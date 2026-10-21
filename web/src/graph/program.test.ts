import { describe, expect, it } from "vitest";
import type { Graph } from "../api";
import { Model } from "./model";
import { digest, isCalculation, programRoots, programView } from "./program";

// ProcessorMain.main starts a consumer thread (only when batching), schedules a snapshot job and
// opens an HTTP server; the consumer reads Kafka, decides, calculates and writes Postgres.
const graph: Graph = {
  nodes: [
    { id: "svc:ledger", kind: "service", name: "ledger" },
    { id: "class:Main", kind: "class", name: "ProcessorMain", parent: "svc:ledger" },
    { id: "m:main", kind: "method", name: "main", parent: "class:Main", attrs: { entryPoint: "main",
      configReads: [{ key: "db.url", file: "processor.properties" }, { key: "batching", file: "processor.properties" }],
      envReads: ["DB_PASSWORD"],
      controlFlow: [
        { k: "do", items: [{ text: "writer.truncate();", calls: [{ kind: "calls", target: "m:truncate", name: "truncate" }] }] },
        { k: "if", cond: "batching", then: [{ k: "do", items: [{ text: "new Worker().start();", calls: [{ kind: "calls", target: "m:run", name: "start Worker.run", async: "thread" }] }] }] },
      ] } },
    { id: "class:Worker", kind: "class", name: "Worker", parent: "svc:ledger" },
    { id: "m:run", kind: "method", name: "run", parent: "class:Worker", attrs: { entryPoint: "thread",
      controlFlow: [
        { k: "do", items: [{ text: "reader = new TopicReader(TOPIC)", calls: [{ kind: "consumes", target: "topic:trades", name: "subscribe trades" }] }] },
        { k: "loop", kind: "foreach", text: "for each record in reader.poll()", body: [
          { k: "if", cond: "trade.quantity() == 0", then: [{ k: "jump", text: "continue" }] },
          { k: "do", items: [{ text: "double value = trade.price() * trade.quantity();" }] },
          { k: "do", items: [{ text: "writer.insert(trade);", calls: [{ kind: "calls", target: "m:insert", name: "insert" }] }] },
        ] },
      ] } },
    { id: "class:Writer", kind: "class", name: "TradeWriter", parent: "svc:ledger" },
    { id: "m:insert", kind: "method", name: "insert", parent: "class:Writer", attrs: { controlFlow: [
      { k: "do", items: [{ text: "ps.executeBatch()", calls: [{ kind: "writes", target: "table:trade_book", name: "INSERT trade_book" }] }] },
    ] } },
    { id: "m:truncate", kind: "method", name: "truncate", parent: "class:Writer" },
    { id: "class:Job", kind: "class", name: "SnapshotJob", parent: "svc:ledger" },
    { id: "m:job", kind: "method", name: "run", parent: "class:Job", attrs: { entryPoint: "scheduled", schedule: "scheduleAtFixedRate(1, 1, SECONDS)" } },
    { id: "class:Status", kind: "class", name: "StatusServer", parent: "svc:ledger" },
    { id: "m:status", kind: "method", name: "<init>", parent: "class:Status" },
    { id: "class:H", kind: "class", name: "PositionsHandler", parent: "svc:ledger" },
    { id: "m:handle", kind: "method", name: "handle", parent: "class:H" },
    { id: "ep:positions", kind: "endpoint", name: "ANY /positions", parent: "svc:ledger", attrs: { route: "/positions", openedBy: ["m:status"], response: { type: "Position[]" } } },
    { id: "db:pg", kind: "database", name: "ledger", otel: { "db.system": "postgresql" } },
    { id: "table:trade_book", kind: "table", name: "trade_book", parent: "db:pg", attrs: { columns: [{ name: "account_email" }] } },
    { id: "db:redis", kind: "database", name: "ledger-cache", otel: { "db.system": "redis" } },
    { id: "table:pos", kind: "table", name: "position:*", parent: "db:redis", attrs: { keyPattern: true, redisType: "string" } },
    { id: "topic:trades", kind: "topic", name: "trades", otel: { "messaging.system": "kafka" } },
  ],
  edges: [
    { source: "m:main", target: "m:truncate", kind: "calls" },
    { source: "m:main", target: "m:status", kind: "calls" },
    { source: "m:main", target: "m:run", kind: "calls", attrs: { async: "thread", conditions: ["if batching"] } },
    { source: "m:main", target: "m:job", kind: "calls", attrs: { async: "scheduled" } },
    { source: "m:truncate", target: "table:trade_book", kind: "writes", attrs: { operations: ["TRUNCATE"] } },
    { source: "m:run", target: "topic:trades", kind: "consumes", attrs: { payloads: [{ type: "Trade" }] } },
    { source: "m:run", target: "m:insert", kind: "calls" },
    { source: "m:insert", target: "table:trade_book", kind: "writes", attrs: { operations: ["INSERT"], payloads: [{ type: "trade_book row", fields: ["account_email"] }] } },
    { source: "m:job", target: "table:pos", kind: "writes", attrs: { operations: ["set"], payloads: [{ type: "String" }] } },
    { source: "m:job", target: "table:trade_book", kind: "reads", attrs: { operations: ["SELECT"], responses: [{ type: "trade_book rows" }] } },
    { source: "ep:positions", target: "m:handle", kind: "handles" },
  ],
};

describe("program view", () => {
  const m = new Model(graph);
  const v = programView(m);
  const node = (id: string) => v.nodes.find((n) => n.id === id);
  const edge = (s: string, t: string) => v.edges.find((e) => e.source === s && e.target === t);

  it("starts at main and follows what it starts", () => {
    expect(programRoots(m).map((r) => r.label)).toEqual(["ledger · ProcessorMain.main"]);
    expect(node("prog:m:main")?.shape).toBe("start");
    const thread = edge("prog:m:main", "prog:m:run");
    expect(thread?.label).toBe("starts");
    expect(thread?.conditional).toBe(true);
    expect(thread?.sublabel).toBe("when batching");
    expect(edge("prog:m:main", "prog:m:job")?.label).toBe("schedules · AtFixedRate(1, 1, SECONDS)");
    expect(edge("prog:m:main", "prog:ep:positions")?.label).toBe("serves /positions"); // opened by StatusServer, called from main
    // parts are named by what they do, with the function that does it underneath
    expect(node("prog:m:main")?.label).toBe("1. Start-up · write trade_book");
    expect(node("prog:m:run")?.label).toMatch(/^\d\. Consume trades · write trade_book$/); // "Worker" says nothing, so no class prefix
    expect(node("prog:m:run")?.sub).toBe("consumer thread · Worker.run");
    expect(node("prog:m:job")?.label).toMatch(/^\d\. Scheduled: write position:\*/);
  });

  it("puts sources left and sinks right, grouped by mechanism, a store on both sides when read and written", () => {
    const group = (id: string) => v.groups?.find((g) => g.id === node(id)?.group);
    expect(group("in:topic:trades")?.label).toBe("Kafka");
    expect(group("in:topic:trades")?.parent).toBe("lane:in");
    expect(group("out:table:trade_book")?.label).toBe("PostgreSQL");
    expect(group("out:table:pos")?.label).toBe("Redis");
    expect(node("in:table:trade_book")).toBeDefined(); // the job reads it
    expect(node("out:table:trade_book")).toBeDefined(); // the worker and main write it
    expect(edge("in:topic:trades", "prog:m:run")?.label).toBe("Trade");
    const write = edge("prog:m:run", "out:table:trade_book");
    expect(write?.label).toBe("trade_book row");
    expect(write?.sublabel).toBe("INSERT");
    expect(write?.sensitivity).toBe("medium"); // account_email
    expect(edge("prog:m:main", "out:table:trade_book")?.label).toBe("TRUNCATE"); // startup work stays with main
    expect(edge("prog:m:main", "out:table:pos")).toBeUndefined(); // the job's writes are the job's
    expect(edge("prog:ep:positions", "out:client:http")?.label).toBe("Position[]");
  });

  it("digests what each piece of work does: I/O, loops, conditions, calculations, opened calls", () => {
    const rows = digest(m, "m:run").map((r) => `${r.marker ?? ""} ${r.text.replace(/ /g, " ")}`);
    expect(rows).toEqual([
      "⇶ subscribe trades",
      "↻ for each record in reader.poll()",
      "?   if trade.quantity() == 0",
      "↷     continue",
      "=   double value = trade.price() * trade.quantity()",
      "→   TradeWriter.insert",
      "⛁     INSERT trade_book",
    ]);
    expect(digest(m, "m:main").map((r) => `${r.marker} ${r.text.trim()}`)).toEqual([
      "→ TradeWriter.truncate", "? if batching", "⇉ start Worker.run",
    ]);
  });

  it("shows config files and environment variables as data coming in", () => {
    const cfg = edge("in:config:processor.properties", "prog:m:main");
    expect(cfg?.label).toBe("db.url, batching");
    expect(cfg?.sublabel).toBe("settings");
    expect(edge("in:env", "prog:m:main")?.label).toBe("DB_PASSWORD");
    expect(v.groups?.find((g) => g.id === node("in:env")?.group)?.label).toBe("Configuration");
    expect(v.groups?.find((g) => g.id === node("in:table:trade_book")?.group)?.keep).toBe(true); // "PostgreSQL" shows even alone
  });

  it("recognises calculations, not string building or construction", () => {
    expect(isCalculation("double pnl = (mid - avg) * qty;")).toBe(true);
    expect(isCalculation("total += line.amount();")).toBe(true);
    expect(isCalculation("String key = a + \":\" + b;")).toBe(false);
    expect(isCalculation("List<X> xs = new ArrayList<>();")).toBe(false);
    expect(isCalculation("if (a == b)")).toBe(false);
    expect(isCalculation("count = 0;")).toBe(false);
  });

  it("without a main, each service's runtime runs its entry points", () => {
    const noMain = new Model({ ...graph, nodes: graph.nodes.map((n) => (n.id === "m:main" ? { ...n, attrs: {} } : n)) });
    const w = programView(noMain);
    expect(w.nodes.find((n) => n.id === "prog:svc:ledger")?.label).toBe("1. ledger runtime");
    expect(w.edges.some((e) => e.source === "prog:svc:ledger" && e.target === "prog:m:job")).toBe(true);
  });
});
