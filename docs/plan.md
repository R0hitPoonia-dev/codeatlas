# Plan: Code + Runtime Understanding Platform (working name: "CodeAtlas")

## Context
Enterprises struggle to understand large codebases: which part talks to which, how a request
actually flows, where data goes, why something is slow or failing. Today this knowledge is split
between static tools (Doxygen-style docs/diagrams) and observability tools (Datadog, SigNoz) that
never connect back to the code structure.

**Goal:** one self-hosted product that builds a *living map of the system from the code* and
*overlays real runtime behavior (OpenTelemetry) on that map*, so users can:
- see what is connected to what, and how (diagrams at every zoom level)
- follow any single request/data item end-to-end: where it went, where it stopped, why
- find bottlenecks and errors directly on the architecture, down to the function/line
- see data flow and what *kind* of data (PII, payment, etc.) moves where

**Decisions (from user):** self-hosted first · own telemetry backend on OpenTelemetry + ClickHouse ·
MVP languages Java/Kotlin + JS/TypeScript · MVP focus = code map + request tracing.

Working directory `/Users/igris/code/doxygen` is empty → greenfield monorepo.

---

## Core idea: the Unified System Graph
Everything hangs off one graph that merges three sources:

| Layer | Source | Examples |
|---|---|---|
| **Static (code)** | Analyzers over repos | service, module, class, function, endpoint, DB table, topic, external API; edges: calls, imports, extends, reads/writes, publishes/consumes, http_calls |
| **Static (infra)** | docker-compose, K8s/Helm, Terraform, OpenAPI/AsyncAPI, CI files | containers, deployments, DBs, queues, network links |
| **Runtime** | OTel traces/logs/metrics | real calls between nodes with rate, errors, latency, payload *shape* |

**Correlation (the differentiator)** — runtime spans are linked to static nodes via OTel semantic conventions:
- `service.name` → service node (repo/module mapping, editable once)
- `code.namespace` + `code.function` (+ `code.filepath`/`code.lineno`) → function node
- `http.route` + method → endpoint node (Spring `@GetMapping`, Express/NestJS routes)
- `db.system` + `db.sql.table`/parsed `db.statement` → table node
- `messaging.destination.name` → topic/queue node
- `server.address` of outbound calls → external system node
- exception stack frames → function node + file/line (+ git blame/commit)

Static edges never observed at runtime = dead/rare paths; runtime edges with no static edge = dynamic
dispatch, reflection, or missing analysis (shown, flagged).

---

## Architecture

```
 Repos (git)                         Instrumented apps (OTel Java agent / Node SDK)
     │ clone/webhook                          │ OTLP
     ▼                                        ▼
 Analyzer workers ──► IR (JSON) ──►  Core API (Go)  ◄── OTel Collector (+ redaction & schema processor)
 (java, ts, infra)                   │   │                         │
                                     │   └─ Correlation engine     ▼
                                     ▼                        ClickHouse (spans, logs, metrics,
                               Postgres (graph, metadata,       edge aggregates)
                               users, snapshots per commit)
                                     ▲
                                Web UI (React)
```

### Components & stack
| Component | Tech | Notes / reuse |
|---|---|---|
| **Java/Kotlin analyzer** | JVM; **scip-java** for precise symbols/references + **JavaParser/Spoon** for framework rules | Detect Spring controllers, JPA entities/repositories, Kafka listeners/templates, RestTemplate/WebClient/Feign calls |
| **TS/JS analyzer** | Node; **scip-typescript** + **ts-morph** | Express/NestJS/Next routes, TypeORM/Prisma/Sequelize models, kafkajs, axios/fetch calls |
| **Infra analyzer** | Go | compose, K8s/Helm (render), Terraform plan JSON, OpenAPI, AsyncAPI |
| **IR** | JSON schema; node/edge lists with stable IDs (SCIP symbol strings) | Language-agnostic; new languages = new analyzer only |
| **Core API** | Go; REST + WebSocket | Ingests IR, versioned graph per commit, query API, correlation, auth |
| **Graph store** | Postgres (nodes/edges tables, recursive CTEs) | Simple to self-host; revisit Neo4j/Memgraph only if queries get slow |
| **Telemetry ingest** | OTel Collector (contrib) + custom processor | Redact values, extract payload *schemas* + PII classes, tag `service.version` |
| **Telemetry store** | ClickHouse (OTel exporter schema) | Same approach as SigNoz/Uptrace |
| **Web UI** | React + TS, **React Flow + ELK.js** layout, Monaco for code view | Export any view to Mermaid/PlantUML/SVG |
| **Deploy** | Docker Compose (eval), Helm chart (prod) | Air-gapped capable; OIDC/SAML SSO later |

---

## Features → how each is built

1. **System map (what connects to what)** — zoomable C4-style views from the graph:
   System context (the Context Diagram, feature 6 level 0) → Services/Containers → Components
   (packages) → Classes/Functions.
   Plus generated diagrams: dependency graph, class, ER (from entities/migrations), API surface,
   deployment/K8s topology, event topology (producers→topics→consumers).

2. **How code works** — static call graph from an entry point down; "static sequence
   diagram" for an entry point; per-function control-flow (activity) view; jump-to-source (built in P1.5).
   - *Entry points:* HTTP endpoints, `main` methods, topic/queue consumers, socket handlers,
     scheduled jobs, `Thread`/`Runnable` bodies — not only HTTP.
   - *Activity (UML activity diagram):* every decision with its condition as the guard
     (if/else, switch cases, ternaries), loops with back edges, try/catch/finally regions,
     early returns and throws, calls (drill into the callee) and I/O (reads/writes/publishes) marked.
   - *Sequence:* lifelines per class/service, messages from the call tree, `alt`/`opt`/`loop`
     fragments derived from the decisions and loops that enclose each call.

3. **Request journey ("what happened to this request")** — search by trace ID / user ID / order ID
   (indexed span attributes) → trace drawn *on the architecture map* + as sequence diagram:
   - path taken, timing per hop, the span where it **stopped** (error, timeout, missing downstream span)
   - **why it went there**: span attributes, correlated logs (trace_id), feature flags, HTTP status,
     retries, routing headers shown at each hop
   - static vs actual: "endpoint could call A, B, C — this request called only A"
   - async continuation via span links across Kafka/queues

4. **Bottlenecks** — per node/edge RED metrics (rate, errors, p50/p95/p99) heat-mapped on the map;
   critical-path analysis per trace; detectors: N+1 queries, slow SQL, chatty services, excessive
   fan-out, retry storms, regressions per `service.version`/deploy.

5. **Errors / bugs** — exception grouping by fingerprint; each group pinned to function + line,
   upstream callers affected, first-seen commit/deploy, git blame; "blast radius" via graph.

6. **Data flow & data types** — static (P1.5): which data types enter each entry point (request
   DTOs, message/protobuf types, socket packets), how they are passed and transformed along calls
   (parameter/return types), and where they end up (tables + columns, topics, cache keys, outbound
   calls) → DFD view: external entities → processes → data stores, every flow labelled with its type.
   DFD levels, each one zooming into the previous:
   - *Level 0 — Context Diagram* (also the C4 "System Context" view): the whole system as **one**
     process box, with only the outside world around it. That means users/clients (from public endpoints),
     ingress, socket/TCP clients, external systems reached over HTTP, services from other repos, and data
     stores or topics shared with other systems. Stores used only by this system stay hidden inside the box.
     Each arrow crosses the boundary in one direction and carries the merged data types, sensitivity
     badges (⚠ payment, email…) and the number of code sites. Clicking an arrow lists fields and code
     lines, and clicking the box zooms to level 1. External entities are grouped by kind (users, partner
     APIs, other internal systems, infrastructure). Exports to Mermaid and C4-PlantUML `System_Context`.
     Later (P3) the boundary arrows carry runtime rate/errors.
   - *Level 1 — System:* each service is a process; data stores and external entities around them.
   - *Level 2 — Inside a service:* its entry points are the processes.
   Runtime (P5): Collector processor records payload *shape* (field names/types, never values by default)
   and PII classifiers (email, phone, card, national ID, tokens) → "card data flows: checkout-api →
   payment-svc → Stripe; also logged in order-svc ⚠". Data-class labels added to the same DFD.

7. **Grouping for analysis** — every diagram groups its elements whenever the code gives a basis
   for it, so a large system reads as a few blocks first and details on demand:
   - *Structural groups:* service → module → package → class, drawn as nested, collapsible
     boundaries (swimlanes in activity diagrams, boxed lifelines in sequence diagrams, subsystem
     boundaries in DFDs). A collapsed group is one box with aggregated edges ("×12 calls").
   - *Role groups:* packages/classes classified by what they do — Ingress (controllers, socket/HTTP
     servers), Messaging (producers/consumers), Persistence (repositories, JDBC, cache clients),
     Domain/Processing, State (in-memory stores), Concurrency (threads/executors), Config — from
     detected I/O, annotations and naming (`db`, `kafka`, `store`, `engine`, `threads`, `server`).
   - *Flow groups:* entry points grouped into pipelines by the data they handle and where it
     lands (e.g. "fills: TCP → Kafka `fills` → position engine → Postgres `fillbook` + Redis");
     structurally identical flows folded into one with variants ("×2: FillConsumer, FillThread").
   - *Inside a function:* runs of plain statements merged into one action; guard clauses
     (validate-and-return/throw) folded into a "checks" block; loop and try/catch bodies as regions.
   - *Data groups:* DFD stores grouped by system (Postgres tables, Redis keys, Kafka topics),
     flows grouped by data type/domain (Fill, Price, Position…).
   - Groups appear only when they reduce clutter (≥2 members); the default zoom expands groups until
     about 30–40 boxes are visible. Click to expand/collapse, "focus group" dims everything else.
   - Users can rename, merge or split groups per repo; overrides are stored by node ID and survive
     re-analysis. Optional `.codeatlas.yml` in the repo can declare groups/roles.
   - The same grouping is applied to the P1 views (Architecture, Components, Classes, Flow), and
     later carries runtime overlays (P3/P4 metrics per group).

---

## Build phases
- **P0 – Foundation** ✅ done: monorepo, IR schema, Core API skeleton, Postgres/ClickHouse, compose deploy, auth (local users).
- **P1 – Static map** ✅ done: Java + TS + infra analyzers → graph → UI map + class/dependency/ER/API/K8s diagrams; Mermaid export; re-index on git push (CI) or from the UI (server clones the repo and runs the analyzers).
- **P1.5 – Code behaviour (static, no telemetry needed)** — mostly done (13 Oct):
  1. ✅ Framework-agnostic I/O (Java): kafka-clients producers/consumers (incl. wrapper classes), JDBC
     with SQL-text parsing, Redis (Jedis/Lettuce/Spring templates: key patterns, pub/sub channels),
     Netty and JDK `HttpServer` endpoints. Names come from constants, config files, constructor
     arguments, getters/helpers (`Values.java`, `Sql.java`). Fixture: `demo/ledger`. Also verified on axxela_risk.
     ✅ TS analyzer too (14 Oct): raw SQL through any client (`pool.query`, `execute`, tagged `sql\`…\``)
     read with a port of `Sql.java` (same table ids), ioredis / node-redis keys and pub/sub channels,
     amqplib queues, `net`/`tls`/`http.createServer` and `ws` servers. Fixture: `analyzers/typescript/test/fixtures/raw-node-app`.
  2. ✅ Entry points beyond HTTP: `attrs.entryPoint` = main / thread / scheduled (`@Scheduled`,
     `schedule*(...)` targets); socket endpoints; consumers. Used in DFD level 2 and the Flow/Sequence pickers.
     Java lambdas that run on their own (`createContext(path, ex -> …)`, `new Thread(() -> …)`, executor /
     scheduler tasks) are function nodes (`method:<Class>#lambda@<line>()`) with their own calls and control flow.
     TS: entry files' module code (`fn:<pkg>/<file>#(module)`, entryPoint main), `worker_threads` scripts
     (thread), `setInterval` / node-cron / `CronJob` / Nest `@Cron` callbacks (scheduled).
  3. ✅ IR: per-function control flow and data types (Java + TS); optional document `config` (.codeatlas.yml).
  4. ✅ Views: Context Diagram (DFD level 0, opens level 1 on click), levels 1–2, Activity, Sequence;
     Mermaid **and PlantUML** export (C4-PlantUML for the context diagram).
  5. ✅ Grouping: generic collapsible groups (structural, role, data systems, regions); DFD level 2
     grouped by entry kind and topic pipeline, identical flows folded ("on trades ×2"); renames/merges/moves
     saved per repo (`GET/PUT /api/v1/repos/{repo}/groups`, admins edit) and `.codeatlas.yml` groups/renames.
     Checked in a browser (14 Oct): "Move to group" (now also shows a user-made group with one member) and "Reset grouping".
  6. ✅ "Detailed context" view (feature 2 + 6 together): starts at `main` and shows, in three lanes,
     where data comes in (sockets, HTTP, topics, database/cache reads, config files, environment
     variables), what runs (main, the threads / scheduled jobs / servers it starts — calls edges with
     `attrs.async`, endpoints with `attrs.openedBy`; the framework for Spring Boot), each with a digest of
     its conditions, loops, calculations, calls and I/O, and where data goes out. Methods carry
     `attrs.configReads` / `attrs.envReads`.
  7. ✅ Programs (21 Oct): a service is a program the build produces (`Main-Class` from maven-shade /
     jar / assembly / spring-boot / jib / appassembler / Gradle / MANIFEST.MF, else a Spring Boot class,
     else each `main` the JDK launcher accepts); a module building several is a `mod:` plus one `svc:` per
     program with a `runs` edge, its code credited to every program whose main reaches it. "Detailed
     context" became the **Program** tab: one program read as one file, parts named by what they do and
     numbered in data order, the data handed between parts (captured arguments, queues, shared state),
     with an outline beside the diagram. Every diagram now runs in the direction data moves.
  Exit: met for the plain-Java fixture and the Spring demo.
- **P2 – Telemetry:** OTel Collector + ClickHouse ingest; trace list/search; trace waterfall; logs by trace.
- **P3 – Correlation (MVP complete):** span→node mapping, runtime overlay on map, request journey view, static vs runtime diff.
- **P4 – Diagnosis:** RED heatmaps, critical path, N+1/slow-query/fan-out detectors, error grouping → code.
- **P5 – Data flow (runtime):** payload-schema extraction + PII processor; data-class labels on the P1.5 data-flow view.
- **P6 – Enterprise:** SSO (OIDC/SAML), RBAC per repo/service, audit log, multi-tenant orgs, retention policies.
- **Later:** more languages (Python, Go, C#), optional LLM summaries/Q&A (opt-in, local model support), dynamic snapshot debugging.

---

## Proposed repo layout
```
analyzers/java/        # scip-java + JavaParser rules → IR
analyzers/typescript/  # scip-typescript + ts-morph rules → IR
analyzers/infra/       # compose/k8s/terraform/openapi → IR
ir/                    # JSON schema + fixtures (shared contract)
core/                  # Go: API, graph store, correlation, detectors
collector/             # OTel Collector build + redaction/schema processor
web/                   # React UI
deploy/compose, deploy/helm
demo/                  # sample system for testing
```

---

## Verification
- **Demo target:** OpenTelemetry Demo (Astronomy Shop: Java, TS, and more, Kafka, Postgres) and
  Spring PetClinic microservices — run via compose with OTel exporting to our Collector.
- **P1:** index demo repos → assert graph contains known endpoints, entities, Kafka topics, service calls (golden IR fixtures in `ir/`).
- **P1.5:** add a plain-Java fixture to `demo/` (Netty server → kafka-clients producer; consumer → JDBC + Jedis).
  Assert its topics, tables and Redis keys are found. Assert golden control-flow for chosen methods
  (decision count, guard texts, loop/try regions). Check the data-flow view labels each hop with the
  right type. Check grouping: collapsed defaults stay under ~40 boxes, and duplicate pipelines fold into one.
  Context Diagram: on demo/shop, check the system is one box with clients, ingress and external
  APIs around it, its own tables and topics hidden, and the boundary flows labelled with types and
  sensitivity. Check it matches the level-1 flows that cross the boundary.
- **P2/P3:** hit demo endpoints; confirm traces land in ClickHouse and ≥90% of spans map to a code node; open a trace and see it drawn on the map.
- **P4:** enable the demo's built-in failure flags (feature flags for errors/latency) → verify the faulty node lights up and the error group points to the right function/line.
- **P5:** send a request with a fake email/card → verify PII class shown on the flow and value never stored.
- Unit tests per analyzer rule; contract tests on IR schema; end-to-end UI tests (Playwright).
