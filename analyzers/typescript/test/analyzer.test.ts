import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { analyze, joinRoute, parseUrl } from "../src/analyzer.js";
import type { Document, IrEdge } from "../src/ir.js";
import { parsePrisma } from "../src/prisma.js";

const here = dirname(fileURLToPath(import.meta.url)); // dist/test
const repoRoot = join(here, "../../../..");
const source = { repo: "t", commit: "c", analyzer: { name: "typescript", version: "test" } };

function index(doc: Document) {
  const nodes = new Map(doc.nodes.map((n) => [n.id, n]));
  const edge = (s: string, t: string, k: string): IrEdge | undefined =>
    doc.edges.find((e) => e.source === s && e.target === t && e.kind === k);
  const hasEdge = (s: string, t: string, k: string) => assert.ok(edge(s, t, k), `${k} edge ${s} -> ${t}`);
  return { nodes, edge, hasEdge };
}

describe("demo shop (Express + NestJS + Prisma + kafkajs)", () => {
  const doc = analyze(join(repoRoot, "demo/shop"), source);
  const { nodes, edge, hasEdge } = index(doc);
  const N = "notifications-service";

  it("emits only resolvable references", () => {
    for (const e of doc.edges) assert.ok(nodes.has(e.source) && nodes.has(e.target), `dangling ${e.source} -> ${e.target}`);
  });

  it("finds services from package.json", () => {
    assert.equal(nodes.get(`svc:${N}`)?.attrs?.path, "notifications");
    assert.equal(nodes.get("svc:storefront-bff")?.otel?.["service.name"], "storefront-bff");
  });

  it("finds Express routes, including routers mounted with a prefix", () => {
    const ep = nodes.get(`endpoint:${N}:GET /notifications/:customerEmail`);
    assert.equal(ep?.otel?.["http.route"], "/notifications/:customerEmail");
    assert.ok(nodes.get(`endpoint:${N}:GET /health`));
    hasEdge(`endpoint:${N}:POST /notifications/:id/resend`, `fn:${N}/src/routes/notifications.ts#resendHandler`, "handles");
  });

  it("finds NestJS routes", () => {
    const id = "endpoint:storefront-bff:GET /storefront/orders/:id";
    hasEdge(id, "method:storefront-bff/src/orders.controller.ts#OrdersController.getOrder", "handles");
  });

  it("builds the call graph across files and through this.<field>", () => {
    hasEdge(`fn:${N}/src/notifications.ts#notifyOrderPlaced`, `fn:${N}/src/email.ts#sendEmail`, "calls");
    hasEdge("method:storefront-bff/src/orders.controller.ts#OrdersController.checkout",
      "method:storefront-bff/src/orders.gateway.ts#OrdersGateway.placeOrder", "calls");
  });

  it("reads Prisma models as tables with relations", () => {
    const t = nodes.get("table:notifications-service-db.deliveries");
    assert.equal(t?.parent, "db:notifications-service-db");
    const fk = edge("table:notifications-service-db.deliveries", "table:notifications-service-db.notifications", "references");
    assert.equal(fk?.attrs?.column, "notificationId");
    assert.deepEqual(edge(`fn:${N}/src/notifications.ts#listForCustomer`, "table:notifications-service-db.notifications", "reads")
      ?.attrs?.operations, ["findMany"]);
    hasEdge(`fn:${N}/src/notifications.ts#resend`, "table:notifications-service-db.deliveries", "writes");
  });

  it("records request/response and payload types", () => {
    const checkout = nodes.get("endpoint:storefront-bff:POST /storefront/orders");
    assert.deepEqual(checkout?.attrs?.request, { type: "CheckoutRequest", typeId: "class:storefront-bff/src/orders.controller.ts#CheckoutRequest" });
    const get = nodes.get("endpoint:storefront-bff:GET /storefront/orders/:id");
    assert.equal((get?.attrs?.response as { type: string }).type, "OrderView"); // Promise<OrderView> unwrapped
    assert.deepEqual(get?.attrs?.inputs, [{ name: "id", type: "string", in: "path" }]);
    const place = edge("method:storefront-bff/src/orders.gateway.ts#OrdersGateway.placeOrder", "ext:orders-service", "http_calls");
    assert.equal((place?.attrs?.payloads as { type: string }[])[0].type, "CheckoutRequest + {total}");
    const consumed = edge(`fn:${N}/src/kafka.ts#startOrderEventsConsumer`, "topic:order-events", "consumes");
    assert.equal((consumed?.attrs?.payloads as { type: string }[])[0].type, "OrderPlacedEvent");
    const mail = edge(`fn:${N}/src/email.ts#sendEmail`, "ext:api.mailprovider.example", "http_calls");
    assert.deepEqual((mail?.attrs?.payloads as { fields: string[] }[])[0].fields, ["to", "subject"]);
  });

  it("records the conditions calls run under", () => {
    const notify = edge(`fn:${N}/src/kafka.ts#startOrderEventsConsumer`, `fn:${N}/src/notifications.ts#notifyOrderPlaced`, "calls");
    assert.deepEqual(notify?.attrs?.conditions, ["on each message › if event.customerEmail"]);
    assert.equal(notify?.attrs?.unconditional, undefined);
    assert.equal(edge(`fn:${N}/src/notifications.ts#resend`, "table:notifications-service-db.deliveries", "writes")?.attrs?.unconditional, true);
  });

  it("records control flow with resolved calls", () => {
    type Step = { k: string; cond?: string; then?: Step[]; items?: { calls?: { kind: string; target: string; when?: string }[] }[] };
    const send = nodes.get(`fn:${N}/src/email.ts#sendEmail`)?.attrs?.controlFlow as Step[];
    assert.deepEqual(send.map((s) => s.k), ["do", "if"]);
    assert.equal(send[1].cond, "!res.ok");
    assert.equal(send[1].then?.[0].k, "throw");
    assert.equal(send[0].items?.[0].calls?.[0].kind, "http_calls");

    const consumer = nodes.get(`fn:${N}/src/kafka.ts#startOrderEventsConsumer`)?.attrs?.controlFlow as Step[];
    const calls = consumer[0].items!.flatMap((i) => i.calls ?? []);
    assert.equal(calls.find((c) => c.kind === "consumes")?.target, "topic:order-events");
    const notify = calls.find((c) => c.target.endsWith("#notifyOrderPlaced"));
    assert.equal(notify?.when, "on each message › if event.customerEmail"); // inside the callback, guarded

    const checkout = nodes.get("method:storefront-bff/src/orders.controller.ts#OrdersController.checkout")?.attrs?.controlFlow as Step[];
    assert.equal(checkout[0].k, "return");
  });

  it("finds Kafka consumers and outbound HTTP", () => {
    hasEdge(`fn:${N}/src/kafka.ts#startOrderEventsConsumer`, "topic:order-events", "consumes");
    const fetchCall = edge("method:storefront-bff/src/orders.gateway.ts#OrdersGateway.fetchOrder", "ext:orders-service", "http_calls");
    assert.equal(fetchCall?.attrs?.path, "/orders/{x}"); // template literal with a resolved const host
    const mail = edge(`fn:${N}/src/email.ts#sendEmail`, "ext:api.mailprovider.example", "http_calls");
    assert.equal(mail?.attrs?.method, "POST");
  });
});

describe("TypeORM fixture", () => {
  const doc = analyze(join(repoRoot, "analyzers/typescript/test/fixtures/typeorm-app"), source);
  const { nodes, edge, hasEdge } = index(doc);

  it("maps entities to tables with columns and foreign keys", () => {
    const users = nodes.get("table:blog-api-db.users");
    assert.ok(users, "users table from @Entity('users')");
    const posts = nodes.get("table:blog-api-db.blog_post");
    assert.deepEqual((posts?.attrs?.columns as { name: string }[]).map((c) => c.name), ["id", "title", "author_id"]);
    assert.equal(edge("table:blog-api-db.blog_post", "table:blog-api-db.users", "references")?.attrs?.cardinality, "many-to-one");
  });

  it("maps Repository<T> calls to reads and writes", () => {
    hasEdge("method:blog-api/src/posts.service.ts#PostsService.list", "table:blog-api-db.blog_post", "reads");
    hasEdge("method:blog-api/src/posts.service.ts#PostsService.publish", "table:blog-api-db.blog_post", "writes");
  });
});

describe("helpers", () => {
  it("joins routes", () => {
    assert.equal(joinRoute("/api/", "/users/"), "/api/users");
    assert.equal(joinRoute("", ""), "/");
  });
  it("parses URLs", () => {
    assert.deepEqual(parseUrl("http://orders-service:8080/orders/{x}"), { host: "orders-service", path: "/orders/{x}" });
    assert.equal(parseUrl("/relative"), undefined);
  });
  it("parses prisma schemas", () => {
    const s = parsePrisma(`datasource db { provider = "mysql" }\nmodel A {\n id Int @id\n b B? @relation(fields: [bId], references: [id])\n bId Int @unique @map("b_id")\n @@map("as")\n}\nmodel B {\n id Int @id\n}`);
    assert.equal(s.provider, "mysql");
    assert.equal(s.models[0].table, "as");
    assert.deepEqual(s.models[0].fields[1].relation, { fields: ["bId"], references: ["id"] });
    assert.equal(s.models[0].fields[2].column, "b_id");
  });
});

describe("plain Node fixture (raw clients, sockets, non-HTTP entry points)", () => {
  const doc = analyze(join(repoRoot, "analyzers/typescript/test/fixtures/raw-node-app"), source);
  const { nodes, edge, hasEdge } = index(doc);
  const F = "fn:events-hub/src";

  it("emits only resolvable references", () => {
    for (const e of doc.edges) assert.ok(nodes.has(e.source) && nodes.has(e.target), `dangling ${e.source} -> ${e.target}`);
  });

  it("marks entry points: main module, worker thread, scheduled callbacks", () => {
    assert.equal(nodes.get(`${F}/main.ts#(module)`)?.attrs?.entryPoint, "main");
    assert.equal(nodes.get(`${F}/worker.ts#(module)`)?.attrs?.entryPoint, "thread");
    assert.equal(nodes.get(`${F}/worker.ts#(module)`)?.name, "worker.ts (worker thread)");
    assert.equal(nodes.get(`${F}/main.ts#(module)`)?.name, "main.ts (entry)");
    assert.deepEqual(
      [nodes.get(`${F}/stats.ts#flushStats`)?.attrs?.entryPoint, nodes.get(`${F}/stats.ts#flushStats`)?.attrs?.schedule],
      ["scheduled", "every 60000 ms"],
    );
    const cron = doc.nodes.find((n) => n.attrs?.schedule === "0 * * * *");
    assert.equal(cron?.attrs?.entryPoint, "scheduled");
    // top-level code now has a caller, and module code gets control flow
    hasEdge(`${F}/main.ts#(module)`, `${F}/server.ts#startServers`, "calls");
    hasEdge(`${F}/worker.ts#(module)`, `${F}/db.ts#rollup`, "calls");
    assert.ok(Array.isArray(nodes.get(`${F}/main.ts#(module)`)?.attrs?.controlFlow));
    // imported modules with top-level code are not entry points
    assert.equal(nodes.get(`${F}/db.ts#(module)`), undefined);
  });

  it("finds TCP, raw HTTP and WebSocket servers with their handlers", () => {
    hasEdge("endpoint:events-hub:TCP :9000", `${F}/server.ts#onConnection`, "handles"); // port from a constant
    hasEdge("endpoint:events-hub:HTTP :8081", `${F}/server.ts#handleHttp`, "handles");
    hasEdge("endpoint:events-hub:WS :9001", `${F}/server.ts#onSocket`, "handles");
    assert.equal(nodes.get("endpoint:events-hub:WS :9001")?.attrs?.framework, "ws");
  });

  it("reads tables and columns from raw SQL, including interpolated names", () => {
    const write = edge(`${F}/db.ts#saveEvent`, "table:events-hub-db.events", "writes");
    assert.deepEqual(write?.attrs?.operations, ["INSERT"]);
    assert.deepEqual((nodes.get("table:events-hub-db.events")?.attrs?.columns as { name: string }[]).map((c) => c.name),
      ["id", "user_email", "payload"]);
    hasEdge(`${F}/db.ts#recent`, "table:events-hub-db.events", "reads");
    hasEdge(`${F}/db.ts#rollup`, "table:events-hub-db.event_rollups", "writes"); // INSERT INTO ${ROLLUPS}
    hasEdge(`${F}/db.ts#rollup`, "table:events-hub-db.events", "reads"); // ... SELECT FROM events
    assert.equal(nodes.get("db:events-hub-db")?.otel?.["db.system"], "postgresql");
  });

  it("finds Redis keys and channels and RabbitMQ queues", () => {
    hasEdge(`${F}/cache.ts#remember`, "table:redis/cache.session:*", "writes"); // host from the default URL
    hasEdge(`${F}/cache.ts#lookup`, "table:redis/cache.session:*", "reads");
    hasEdge(`${F}/cache.ts#remember`, "topic:redis:sessions", "publishes");
    assert.equal(nodes.get("table:redis/cache.session:*")?.attrs?.redisType, "string");
    const consumed = edge(`${F}/queue.ts#startQueue`, "queue:incoming-events", "consumes");
    assert.equal((consumed?.attrs?.payloads as { type: string }[])[0].type, "EventRow");
    const sent = edge(`${F}/queue.ts#startQueue`, "queue:emails", "publishes");
    assert.deepEqual((sent?.attrs?.payloads as { fields: string[] }[])[0].fields, ["to"]);
  });
});

describe("readSql", () => {
  it("names written and read tables and columns", async () => {
    const { readSql } = await import("../src/sql.js");
    const ins = readSql("INSERT INTO trades (id, qty) SELECT id, qty FROM staging s JOIN accounts a ON a.id = s.a");
    assert.deepEqual([...ins!.writes], ["trades"]);
    assert.deepEqual([...ins!.reads].sort(), ["accounts", "staging"]);
    assert.deepEqual(ins!.columns.get("trades"), ["id", "qty"]);
    const upd = readSql("UPDATE positions SET qty = qty + 1 FROM fills WHERE fills.id = $1");
    assert.deepEqual([[...upd!.writes], [...upd!.reads]], [["positions"], ["fills"]]);
    assert.equal(readSql("hello world"), undefined);
    assert.equal(readSql("SELECT 'FROM fake' AS x FROM real_table")?.reads.has("fake"), false);
    assert.deepEqual([...readSql("DELETE FROM * WHERE id = 1")!.writes], ["*"]); // unresolved name
  });
});

describe("variables and their scopes", () => {
  const doc = analyze(join(repoRoot, "analyzers/typescript/test/fixtures/vars-app"), source);
  const { nodes } = index(doc);
  type Var = { name: string; scope: string; type?: string; declaredIn?: string; reads: number; writes: number; final?: boolean };
  const variable = (fn: string, scope: string, name: string) => {
    const vars = nodes.get(fn)?.attrs?.variables as Var[] | undefined;
    assert.ok(vars, `${fn} has variables`);
    return vars.find((v) => v.name === name && v.scope === scope);
  };
  const ADD = "method:vars-app/src/counter.ts#Counter.add";

  it("lists the function's own params and locals", () => {
    assert.equal(variable(ADD, "param", "qty")?.type, "number");
    assert.equal(variable(ADD, "local", "sum")?.final, true);
    assert.equal(variable(ADD, "local", "name")?.reads, 1); // the local shadowing the field
  });

  it("marks state declared outside the function", () => {
    const total = variable(ADD, "module", "total")!;
    assert.equal(total.writes, 1);
    assert.deepEqual((total as Var & { writeLines?: number[] }).writeLines, [22]);
    assert.equal(total.declaredIn, "src/counter.ts");
    assert.equal(variable(ADD, "module", "seen")?.reads, 1);
    const recent = variable(ADD, "field", "recent")!;
    assert.equal(recent.declaredIn, "field:vars-app/src/counter.ts#Counter.recent");
    assert.equal(recent.final, true);
    assert.equal(recent.writes, 1); // push changes it
    assert.equal(variable(ADD, "field", "name")?.writes, 1); // parameter property
    const limit = variable(ADD, "imported", "LIMIT")!;
    assert.equal(limit.final, true);
    assert.match(limit.declaredIn!, /src\/config\.ts$/);
    assert.equal(variable(ADD, "imported", "mode")?.final, undefined);
    assert.equal(variable("method:vars-app/src/counter.ts#Counter.constructor", "static", "Counter.instances")?.writes, 1);
  });

  it("closures capture from their enclosing function", () => {
    const timer = "fn:vars-app/src/counter.ts#scheduled every 1000 ms@33";
    assert.equal(variable(timer, "captured", "tag")?.declaredIn, "fn:vars-app/src/counter.ts#startTimer");
    assert.equal(variable(timer, "module", "seen")?.writes, 1);
    // startTimer itself does not list what only the callback uses; shorthand { tag } reads the param
    assert.equal(variable("fn:vars-app/src/counter.ts#startTimer", "module", "seen"), undefined);
    assert.equal(variable("fn:vars-app/src/counter.ts#startTimer", "param", "tag")?.reads, 1);
    assert.equal(variable(ADD, "imported", "LIMIT")?.type, "number");
  });

  it("keeps the doc comment as what it does", () => {
    assert.equal(nodes.get("class:vars-app/src/counter.ts#Counter")?.attrs?.doc, "Counts orders and remembers recent ones.");
    assert.equal(nodes.get(ADD)?.attrs?.doc, "Adds an order to the recent list.");
  });
});
