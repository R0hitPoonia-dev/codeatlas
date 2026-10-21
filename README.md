# CodeAtlas

Self-hosted platform that builds a living map of your system from the code and overlays real
runtime behaviour (OpenTelemetry) on it: what connects to what, how a request flowed, where it
stopped, where the bottlenecks and errors are, and what data moves where.

Full plan: [docs/plan.md](docs/plan.md). **Current status: P1 (static code map) done; P1.5 (code
behaviour) in progress** — data-flow, activity and sequence views and grouping are in; non-Spring I/O
detection and non-HTTP entry points are next. Telemetry (P2) after that.

## What it shows today

Analyzers read a repo (no build or running system needed) and the UI draws, per commit:

| View | Shows |
|---|---|
| **Program** | One program at a time, read as if it were a single file: how it is started (`java -jar producer-1.0.jar`, from maven-shade in `pom.xml`) and its entry point, then its parts in the order data moves through them (start-up, the servers it opens, the threads, tasks and consumers it starts), each named by what it does ("Receive ConnectorPacket", "Kafka consumer · consume fills, prices") with the function underneath. Lines between parts carry the data handed on: what a started task captures (`transcode: int, sid: int, payload: byte[]`), a queue's element type (`FilledPosition` via `persistQueue`), shared state (dashed). Data in on the left (clients, topics, reads, config files), data out on the right. An outline beside the diagram lists the same parts with what goes in and out and the steps each takes |
| **Explore** (default) | One drill-down through every level: start at the level-0 context diagram, click any box and press **▸ Inside** — system › service › package › class › function logic › the functions each step calls. When a box holds several things (a step calling several functions, a package with several classes), **▸ Inside** lays them out next to it on the canvas; click one and press **▸ Inside** again. Breadcrumbs (or Back / Esc) return to any level up to level 0. **One** / **All** switch between one level at a time and everything at once. **All** shows everything below the current level in one nested diagram — services › packages › classes › functions › each function's steps — with calls drawn from the step that makes them to the called function and from steps to the tables, topics and services they touch. Every function opens with its full inner workings (a whole system can be thousands of boxes; layout runs in a Web Worker so the page stays responsive); its toolbar has a **detail ladder** with as many levels as the code is deep (e.g. Services › Packages › Classes › Functions › Blocks › Inner blocks › Everything; a level is named after the boxes it folds). The last level shows everything; − / + or a click on a level folds or opens one level at a time, and ✎ rename (or double-click a level) gives it a name that reads better for your codebase, saved for the repo with the other grouping edits. Click a box to fold or unfold just that box. All tiles services, packages and classes with room between them (a class's state first, then sub-boxes by name, functions in source order); each function's steps keep their flow layout. It reads like a map: zoomed out you see service, package and class names large and no step text; zooming in brings back the steps, labels and lines. Lines between tiles stay faint until you hover or click a box, which lights its own in the accent colour. **Key** (top left) explains lines and shapes; `[` / `]` step the detail level and `f` fits the view. Folding or opening animates: every box glides to its new place, opened boxes grow out of the folded box they were in, folded contents shrink into it, and a box you click stays where it is on screen. Classes are drawn as their own solid box holding their methods and fields. Every function box starts with **what it does** (its doc comment, inputs, output, the stores / topics / services it touches, the state it changes, its decisions and loops) and lists its own parameters and locals with their scope; variables it uses that are declared elsewhere (class fields, statics, module-level or imported variables, variables captured from an enclosing function) sit in separate **declared outside** boxes next to it, linked to the exact steps that read or change them. Selecting a function lists all its variables with scope, where declared and reads / writes; selecting a field lists every function that reads or changes it. **▸ Inside** on a box in the other tabs jumps here at that level |
| **Architecture** | Services, databases, Kafka/Rabbit topics, external APIs and ingress, with HTTP / data / messaging links aggregated from the code |
| **Data flow** | Data flow diagrams: clients, processes, data stores and external systems, every flow labelled with the types it carries and the sensitive categories inside them (email, payment card, credentials, government ID…). Level 1 = services, level 2 = each endpoint / message consumer of one service. Click a flow for its fields and the exact code lines |
| **Components** | Packages inside one service, their dependencies, and what each one talks to outside the service |
| **Classes** | UML class diagram per package: stereotypes, fields, methods, inheritance, associations |
| **Data model** | ER diagram from JPA entities, Prisma models and TypeORM entities: columns, PK/FK, cardinality |
| **API** | Every endpoint (Spring MVC, Express, NestJS, OpenAPI specs) with its handler and the tables/topics/services it reaches |
| **Flow** | "How does this request work": endpoint → handler → call tree → reads/writes, publishes, outbound HTTP (across services). Conditional steps are dashed and labelled with their condition (`if order.isPaid()`, `for each line in …`, `on error`) |
| **Activity** | UML activity diagram of any function or method: actions, decisions with their conditions (yes/no, switch cases), loops with back edges, try/catch branches, returns and throws; I/O steps marked (⛁ table, ⇶ topic, ⇄ HTTP) |
| **Sequence** | Sequence diagram from an endpoint or function: lifelines per class, data store, topic and remote service (boxed by service), messages in call order, `alt`/`opt`/`loop`/`critical` blocks from the code's conditions, loops and try/catch; follows HTTP calls into other services of the repo. Depth is adjustable |
| **Deployment** | docker-compose services and Kubernetes workloads, what they run and how they connect |

**Reading (every tab):** every tab reads the way the Program tab does.
- **Direction.** Diagrams follow the data, from where it comes from to where it goes: a read is drawn
  from the store to the reader, a write from the writer to the store (a store both read and written
  is one line with arrowheads at both ends), a consumed topic from the topic to the consumer, a
  request from the caller. Lines that carry data decide the order boxes are laid out in; structural
  lines (uses, inheritance, deployment) never override them.
- **Lanes.** Architecture, Data flow, Components, Explore and Flow put what is only read (clients,
  sources, config) in *Data in* on the left and what is only written in *Data out* on the right; a
  store or topic one part writes and another reads sits between the parts.
- **Names.** Boxes say what they do: services, packages and classes get a row from what their code
  does with data ("Receive ConnectorPacket on :5001, :5002", "Publish to Kafka (8 topics)"); functions
  are named by their doc comment or their I/O with `Class.method` underneath; data-flow processes by
  what they do ("Consume trades · write trade_book"); tables say which programs write and read them.
- **Data on every line.** Lines carry the types that move along them (payloads, what a read returns,
  the argument types of calls, an endpoint's request) with the verb underneath.
- **Order.** The parts that do work are numbered in the order data moves through them.
- **Outline.** Beside every diagram (and the sequence diagram) the same parts as an outline: each with
  what it receives and hands on, and its steps / members / columns folded below; a toolbar button
  hides it. The API table has *Receives*, *Returns* and *Does* columns.
- Systems with many look-alike members (eight Kafka topics) start folded into one box.

**Focus (every diagram tab):** clicking a box opens its details and focuses it: the box is highlighted, every box on a path through it (whatever leads to it and whatever follows from it, however far; loop-back lines are not followed) is the second level of focus, and everything else dims, along with the lines not on those paths. A banner shows how many boxes lead there and follow; clicking another box moves the focus, clicking empty space or **Clear** ends it. In sequence diagrams the same applies to participants and messages.

**Grouping:** every diagram groups related boxes — data stores by system (PostgreSQL, Kafka, external
systems), packages and classes by role (Ingress, Messaging, Domain, Integration, Persistence, Model,
Config), functions by class and service, tables by database, containers by compose file / K8s
namespace, and loop / try / catch bodies as regions in activity diagrams; leading guard clauses fold
into one "checks" block. Large diagrams open collapsed to ~35 boxes; click a group's **−** to collapse
it into one box (edges are merged, "×N"), click a collapsed box to expand, **◎** to focus a group.
In sequence diagrams, click a service box's name to fold its classes into one lifeline.

**Programs:** a service is a program the build produces, found the way `java -jar` finds it: the
`Main-Class` the build puts in a jar (maven-shade, jar, assembly, spring-boot, jib, appassembler,
Gradle `mainClass` / manifest, a checked-in `MANIFEST.MF`), else a `@SpringBootApplication` class,
else each `main` the JDK launcher accepts. A module that builds several programs (two shaded jars,
two `main`s) shows one service per program; the code they share is credited to every program whose
`main` reaches it. Containers link to the program whose jar or main class their command or
Dockerfile names.

Every view exports to Mermaid (`.mmd`, groups as subgraphs), and clicking any node shows its source location,
OpenTelemetry identity (used for runtime correlation in P3) and relationships.

## Layout

| Path | What |
|---|---|
| [`ir/`](ir/) | The IR contract every analyzer emits (JSON schema + fixtures) |
| [`core/`](core/) | Go API server (`cmd/codeatlas-api`) and CLI (`cmd/codeatlas`); merges analyzer snapshots per commit |
| [`analyzers/java/`](analyzers/java/) | Java analyzer (JavaParser + symbol solver): Spring MVC, Spring Data/JPA, Kafka/Rabbit, RestTemplate/WebClient/Feign |
| [`analyzers/typescript/`](analyzers/typescript/) | JS/TS analyzer (ts-morph): Express, NestJS, Prisma, TypeORM, kafkajs, fetch/axios |
| [`analyzers/infra/`](analyzers/infra/) | docker-compose, Kubernetes manifests, OpenAPI/Swagger |
| [`web/`](web/) | React UI with React Flow + ELK diagrams (served by the API in production) |
| [`demo/shop/`](demo/shop/) | Small polyglot system used by the analyzer tests and for demos |
| [`deploy/compose/`](deploy/compose/) | Docker Compose stack: API + Postgres + ClickHouse |
| `collector/` | Coming in P2 |

## Index a repository

**From the UI.** Register the repo with its git URL and the server clones it and runs the
analyzers itself; the Repositories page shows each repo's state with Analyze / Re-analyze /
Retry / Cancel, a live log, and "Analyze all pending". Runs are queued and executed one at a
time; their state and logs live in memory, so a restart keeps the results but not the run
history. The server needs `git` and the analyzers next to `codeatlas-api` (`make build` puts
them there; the Docker image does not include them yet). For private repos set
`CODEATLAS_GIT_TOKEN` (for GitHub, e.g. `gh auth token`); without it git falls back to the
server user's own credentials, which on macOS may mean a Keychain prompt.

**From a checkout or CI** (also for repos without a URL):

```bash
make build                                    # server, CLI, UI and analyzers into ./bin
export CODEATLAS_URL=http://localhost:8080 CODEATLAS_TOKEN=<api token>
PATH="$PWD/bin:$PATH" codeatlas scan /path/to/repo --repo my-system
```

`codeatlas scan` detects Java / JS-TS code, runs the matching analyzers plus the infra analyzer,
validates each IR document and uploads it (registering the repo on first upload when the token
belongs to an admin). Run it in CI on every push to keep the map current — see
[`docs/ci/github-actions.yml`](docs/ci/github-actions.yml) and [`Dockerfile.scanner`](Dockerfile.scanner).
Other commands: `codeatlas validate FILE…`, `codeatlas upload FILE…`, `scan --no-upload --out-dir DIR`.

## Run it

```bash
cp deploy/compose/.env.example deploy/compose/.env   # then edit the secrets
make up                                              # http://localhost:8080
```

Sign in with `CODEATLAS_ADMIN_EMAIL` / `CODEATLAS_ADMIN_PASSWORD`. To load the demo system,
create an API token and scan it:

```bash
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"email":"admin@example.com","password":"<password>"}' localhost:8080/api/v1/auth/login
# use the returned token:
curl -s -X POST -H "Authorization: Bearer <token>" -H 'Content-Type: application/json' \
  -d '{"name":"ci"}' localhost:8080/api/v1/tokens
CODEATLAS_URL=http://localhost:8080 CODEATLAS_TOKEN=<api token> make scan-demo
```

## Develop

```bash
make test                                   # core, analyzers (Java/TS/infra) and UI typecheck
make test-integration DB='postgres://…'     # + API/Postgres tests (creates a temp schema)
cd web && npm run dev                       # UI on :5173, proxies /api to :8080
```

## API (v1)

All `/api/v1` endpoints except login need `Authorization: Bearer <token>` or the session cookie.

| Method | Path | |
|---|---|---|
| POST | `/api/v1/auth/login` | `{email, password}` → session token + cookie |
| POST | `/api/v1/auth/logout` | revoke current token |
| GET | `/api/v1/me` | current user |
| GET/POST | `/api/v1/users` | list / create users (admin) |
| POST | `/api/v1/tokens` | `{name}` → long-lived API token for analyzers/CI (shown once) |
| GET/POST | `/api/v1/repos` | list / register repos (create: admin) |
| GET | `/api/v1/repos/{repo}` | repo, with `lastCommit` / `analyzedAt` and the latest server-side `analysis` |
| PATCH | `/api/v1/repos/{repo}` | `{url?, defaultBranch?}` (admin) |
| POST | `/api/v1/repos/{repo}/analysis` | clone `url` and run the analyzers in the background (admin) → 202 |
| GET | `/api/v1/repos/{repo}/analysis` | state of the latest run, with its log |
| DELETE | `/api/v1/repos/{repo}/analysis` | cancel a queued or running analysis (admin) |
| GET/POST | `/api/v1/git-profiles` | list / add git profiles (admin); adding can generate an SSH key and returns its public key |
| POST | `/api/v1/git-profiles/{name}/test` | log in to GitHub with the profile's key; returns the account (admin) |
| GET/POST | `/api/v1/repos/{repo}/snapshots` | list / upload an IR document |
| GET | `/api/v1/repos/{repo}/commits` | analysed commits and which analyzers ran |
| GET | `/api/v1/repos/{repo}/graph?commit=…&kind=…` | merged graph of every analyzer for a commit (default: latest) |
| GET | `/api/v1/snapshots/{id}` | snapshot metadata |
| GET | `/api/v1/snapshots/{id}/graph?kind=…` | nodes + edges, optionally filtered by node kind |
| GET | `/healthz`, `/readyz` | liveness / readiness (Postgres + ClickHouse) |

Uploading the same repo + commit + analyzer again replaces the earlier snapshot.

## Configuration

| Env var | Default | |
|---|---|---|
| `CODEATLAS_DATABASE_URL` | — (required) | Postgres URL |
| `CODEATLAS_HTTP_ADDR` | `:8080` | |
| `CODEATLAS_WEB_DIR` | — | serve built UI from this directory |
| `CODEATLAS_CLICKHOUSE_URL` / `_USER` / `_PASSWORD` / `_DATABASE` | `http://localhost:8123` / `default` / — / `codeatlas` | |
| `CODEATLAS_ADMIN_EMAIL` / `_PASSWORD` | — | first admin, created only when no users exist |
| `CODEATLAS_SESSION_TTL` | `24h` | |
| `CODEATLAS_COOKIE_SECURE` | `false` | set `true` behind HTTPS |
| `CODEATLAS_MAX_UPLOAD_BYTES` | 512 MiB | IR upload limit |
| `CODEATLAS_ANALYSIS_TIMEOUT` | `30m` | per server-side analysis (clone + analyzers) |
| `CODEATLAS_GIT_TOKEN` | — | HTTPS token for cloning private repos; replaces git's credential helpers |
| `CODEATLAS_GIT_TOKEN_HOST` | `github.com` | the only host the token is sent to |
| `CODEATLAS_GIT_PROFILES` | `~/.git-profiles` | git profiles a repo can be cloned with (same file as the `gitprofile` terminal helper) |
| `CODEATLAS_SSH_DIR` | `~/.ssh` | where profile keys are generated, and the only place existing keys may be used from |
| `CODEATLAS_JAVA_ANALYZER` / `_TS_ANALYZER` / `_INFRA_ANALYZER` | next to the binary | analyzer locations (server and CLI) |
