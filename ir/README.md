# CodeAtlas IR (v1)

The IR is the contract between **analyzers** (Java, TypeScript, infra, …) and the **core**.
Each analyzer run over one repo at one commit produces one IR document, which is uploaded to
`POST /api/v1/repos/{repo}/snapshots`.

- Schema: [`schema/ir.v1.schema.json`](schema/ir.v1.schema.json)
- Example: [`fixtures/orders-service.java.json`](fixtures/orders-service.java.json)

## Rules

1. **Node ids are stable across commits.** Use a deterministic identity (SCIP symbol string when
   available, otherwise `<kind>:<qualified name>`). Diffing commits and correlating runtime data
   depend on this.
2. **Node ids are unique within a document.** Every edge `source`/`target` and every node `parent`
   must reference a node in the same document. Things outside the repo (third-party APIs, shared
   databases) are modelled as nodes of kind `external`, `database`, `topic`, etc.
3. **`parent` implies containment.** Don't also emit a `contains` edge for the same pair.
4. **`otel` holds runtime identity.** Put the OpenTelemetry attribute values a span would carry
   when it executes this node. The correlation engine matches spans on these:

   | Node kind | Typical `otel` keys |
   |---|---|
   | service | `service.name` |
   | function/method | `code.namespace`, `code.function` |
   | endpoint | `http.request.method`, `http.route` |
   | database / table | `db.system`, `db.namespace`, `db.collection.name` |
   | topic / queue | `messaging.destination.name` |
   | external | `server.address` |

5. **`attrs` is free-form** analyzer metadata (e.g. `stereotype: "RestController"`). The core
   stores it but does not interpret it.
6. Paths in `location.file` are relative to the repo root; lines are 1-based.

## Conventions analyzers follow

These keep output from different analyzers mergeable (the core merges all snapshots of a commit;
nodes with the same id are combined):

| Thing | Id | Notes |
|---|---|---|
| Service (one program) | `svc:<service name>` | `attrs.path` = directory it is launched from (links a compose/K8s build context); `otel.service.name`. `attrs.mainClass` and `attrs.jar` when the build says how it starts. A module that builds several programs stays a `mod:` and each program is its own `svc:` with `attrs.module` |
| Library/module | `mod:<name>` | `attrs.path`. Holds the code when several programs share it |
| Endpoint | `endpoint:<service>:<METHOD> <route>` | same id from code and OpenAPI, so they merge |
| Database | `db:<host>/<name>` or `db:<service>-db` | `attrs.host` (from the connection URL) links it to a container; `attrs.usedBy` |
| Table | `table:<db id without "db:">.<table>` | `attrs.columns: [{name, type, primaryKey?, foreignKey?, nullable?, unique?}]` |
| Topic / queue | `topic:<name>` / `queue:<name>` | `otel.messaging.system` |
| External host | `ext:<host>` | resolved to a service by the core when the host is a known service/container name |
| Container / K8s workload | `ctr:<compose service>` / `k8s:<ns>/<name>` | `attrs.buildContext`, `attrs.hostnames`, `attrs.role`. `attrs.jars` (may be a glob from a Dockerfile `COPY`, e.g. `producer-*.jar`) / `attrs.mainClasses` from its command or its Dockerfile's `ENTRYPOINT` / `CMD` (`attrs.dockerfile`), used to pick a program when one directory builds several |

Edge direction: `source` is the active side — a caller `calls`, a handler is target of `handles`
(endpoint → handler), code `reads`/`writes` a table, a producer `publishes` to a topic and a
**consumer `consumes` a topic** (source = consumer). A service `runs` the main method it starts.
Table → table `references` edges carry
`attrs.cardinality` (`many-to-one`, `one-to-one`, `many-to-many`) and `attrs.column`.

### Data types and logic

| Where | Attribute | Meaning |
|---|---|---|
| endpoint node | `attrs.request`, `attrs.response` | `{type, typeId?}` of the request body / response (wrappers like `ResponseEntity<T>`, `Promise<T>` unwrapped) |
| endpoint node | `attrs.inputs` | `[{name, type, in: path\|query\|header\|cookie}]` |
| http_calls / publishes / writes edge | `attrs.payloads` | `[{type, typeId?, fields?}]` data sent along the edge |
| http_calls / reads edge | `attrs.responses` | data coming back |
| consumes edge | `attrs.payloads` | message type the consumer receives |
| calls and data edges | `attrs.conditions` | distinct guard chains the call runs under, outermost first, joined with ` › ` (`for each line in order.getLines() › if ok`) |
| calls and data edges | `attrs.unconditional` | `true` if at least one occurrence always runs |

### Entry points

Functions where work starts without an incoming HTTP request carry `attrs.entryPoint`: `main`
(program entry; in TS the module-level code of an entry file, id `fn:<pkg>/<file>#(module)`),
`thread` (Thread/Runnable bodies, `worker_threads` scripts) or `scheduled` (with `attrs.schedule`).
A Java `main` the build does not put in a jar still carries `entryPoint: main`, with `attrs.packaged: false`.
Lambdas that run as their own unit of work in Java (HTTP handlers, thread / executor / scheduler
tasks) are method nodes `method:<Class>#lambda@<line>()` with `attrs.lambda` and `attrs.definedIn`.
Socket servers are endpoints named `TCP :<port>` / `WS :<port>` / `HTTP :<port>` with `attrs.protocol`.

### Variables and docs (`attrs.variables`, `attrs.doc`)

Function / method nodes list the variables they use in `attrs.variables`:
`[{name, scope, type?, declaredIn?, line?, reads, writes, lines?, writeLines?, final?}]`.

| `scope` | Declared | `declaredIn` |
|---|---|---|
| `param` / `local` | in the function itself (`line` = declaration) | — |
| `captured` | in an enclosing function (lambdas, closures) | that function's id |
| `field` | instance state of a class | field node id |
| `static` | class-level state (Java `static`, TS `static`); `name` is `Class.x` when qualified | field node id |
| `module` | top level of the same file (TS) | repo-relative file |
| `imported` | top level of another file (TS) | repo-relative file |

`reads` / `writes` count uses; a write is an assignment, `++`/`--`, or a mutating call on it
(`add`, `put`, `push`, `set`, `incrementAndGet`...). `lines` / `writeLines` are the source lines of
the uses, so a diagram can attach the variable to the step on that line. `final` marks `final` /
`const` / `readonly`. Field nodes carry `attrs.final` the same way.

Classes, functions and methods carry `attrs.doc`: the first paragraph of their Javadoc / JSDoc.

### Control flow (`attrs.controlFlow` on function / method nodes)

A list of steps describing the body in source order; the UI draws activity diagrams from it and
walks it for sequence diagrams.

| `k` | Fields |
|---|---|
| `do` | `items: [{text, line, calls?}]` — a run of plain statements |
| `if` | `cond`, `then: Step[]`, `else?: Step[]` (else-if chains nest), `calls?` (made by the condition) |
| `switch` | `on`, `cases: [{label, body}]`, `calls?` |
| `loop` | `kind` (`foreach`/`for`/`while`/`do`), `text`, `body`, `calls?` (iterable / condition) |
| `try` | `body`, `catches?: [{type, body}]`, `finally?`, `resources?` |
| `return` / `throw` | `text?`, `calls?` |
| `jump` | `text`: `break` or `continue` |
| `block` / `sync` | `body` (nested block, `synchronized`) |

Each call: `{kind, target, name, text, line, when?}`. `kind` is `calls` (target = in-repo
function/method id) or an I/O kind (`reads`, `writes`, `publishes`, `consumes`, `http_calls`; target =
table/topic/external/service id, plus `httpMethod`/`path` for HTTP). `when` holds guards that apply
inside the statement (lambda such as `orElseThrow` → `if empty`, ternary, `&&`, kafkajs
`eachMessage` → `on each message`). Calls are listed in evaluation order. Bodies over ~400 steps are cut.

`typeId` points at the class/interface node when the type is declared in the repo; `fields` lists
property names when only an object literal is known. Sensitive-data categories are derived in the
UI from field and column names (`web/src/graph/dataclass.ts`), so no values are ever needed.

Analyzers never record environment-variable values or other secrets (compose `envKeys` lists keys only).

## Kinds

**Nodes:** service, module, package, file, class, interface, enum, function, method, field,
endpoint, database, table, topic, queue, external, container, deployment.

**Edges:** contains, imports, depends_on, calls, extends, implements, references, handles,
reads, writes, publishes, consumes, http_calls, deploys, connects_to.

Adding a kind is a schema change: update the JSON schema **and** `core/ir/ir.go`
(the contract test fails if they drift).
