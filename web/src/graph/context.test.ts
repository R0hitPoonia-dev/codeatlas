import { describe, expect, it } from "vitest";
import type { Graph } from "../api";
import { contextDataFlow, DFD_CLIENT, DFD_SYSTEM, entryPoints, serviceDataFlow } from "./dataflow";
import { usefulGroups } from "./groups";
import { Model } from "./model";

// A plain-Java service like demo/ledger: a TCP gateway publishes to Kafka, two thread variants
// consume `trades` into a table, a scheduled job writes Redis and publishes a channel nobody
// in the repo reads, an HTTP endpoint reads memory, and an external API is called.
const graph: Graph = {
  nodes: [
    { id: "svc:ledger", kind: "service", name: "ledger" },
    { id: "ep:tcp", kind: "endpoint", name: "TCP :7001", parent: "svc:ledger", attrs: { protocol: "tcp", request: { type: "ByteBuf" } } },
    { id: "ep:http", kind: "endpoint", name: "ANY /positions", parent: "svc:ledger" },
    { id: "class:Handler", kind: "class", name: "PacketHandler", parent: "svc:ledger" },
    { id: "m:read", kind: "method", name: "channelRead0", parent: "class:Handler" },
    { id: "class:A", kind: "class", name: "TradeConsumerThread", parent: "svc:ledger" },
    { id: "m:a", kind: "method", name: "run", parent: "class:A", attrs: { entryPoint: "thread" } },
    { id: "class:B", kind: "class", name: "TradeConsumer", parent: "svc:ledger" },
    { id: "m:b", kind: "method", name: "run", parent: "class:B", attrs: { entryPoint: "thread" } },
    { id: "class:Job", kind: "class", name: "SnapshotJob", parent: "svc:ledger" },
    { id: "m:job", kind: "method", name: "run", parent: "class:Job", attrs: { entryPoint: "scheduled" } },
    { id: "class:Main", kind: "class", name: "ProcessorMain", parent: "svc:ledger" },
    { id: "m:main", kind: "method", name: "main", parent: "class:Main", attrs: { entryPoint: "main" } },
    { id: "class:Positions", kind: "class", name: "PositionsHandler", parent: "svc:ledger" },
    { id: "m:handle", kind: "method", name: "handle", parent: "class:Positions" },
    { id: "class:Writer", kind: "class", name: "TradeWriter", parent: "svc:ledger" },
    { id: "m:insert", kind: "method", name: "insert", parent: "class:Writer" },
    { id: "db:pg", kind: "database", name: "ledger", otel: { "db.system": "postgresql" } },
    { id: "table:trade_book", kind: "table", name: "trade_book", parent: "db:pg", attrs: { columns: [{ name: "account_email" }] } },
    { id: "db:redis", kind: "database", name: "ledger-cache", otel: { "db.system": "redis" } },
    { id: "table:pos", kind: "table", name: "position:*", parent: "db:redis", attrs: { keyPattern: true } },
    { id: "topic:trades", kind: "topic", name: "trades", otel: { "messaging.system": "kafka" } },
    { id: "topic:redis:positions", kind: "topic", name: "positions", otel: { "messaging.system": "redis" } },
    { id: "ext:rates", kind: "external", name: "rates.example.com" },
  ],
  edges: [
    { source: "ep:tcp", target: "m:read", kind: "handles" },
    { source: "m:read", target: "topic:trades", kind: "publishes", attrs: { payloads: [{ type: "byte[]" }] } },
    { source: "m:a", target: "topic:trades", kind: "consumes", attrs: { payloads: [{ type: "Trade" }] } },
    { source: "m:b", target: "topic:trades", kind: "consumes", attrs: { payloads: [{ type: "Trade" }] } },
    { source: "m:a", target: "m:insert", kind: "calls" },
    { source: "m:b", target: "m:insert", kind: "calls" },
    { source: "m:insert", target: "table:trade_book", kind: "writes", attrs: { payloads: [{ type: "trade_book row", fields: ["account_email"] }] } },
    { source: "m:job", target: "table:pos", kind: "writes", attrs: { payloads: [{ type: "String" }] } },
    { source: "m:job", target: "topic:redis:positions", kind: "publishes", attrs: { payloads: [{ type: "String" }] } },
    { source: "m:job", target: "ext:rates", kind: "http_calls", attrs: { payloads: [{ type: "RateRequest" }] } },
    { source: "ep:http", target: "m:handle", kind: "handles" },
  ],
};

describe("plain-Java entry points and flows", () => {
  const m = new Model(graph);

  it("finds every kind of entry point, consumers first by their topic", () => {
    const eps = entryPoints(m, "svc:ledger").map((e) => `${e.kind}:${e.label}`);
    expect(eps).toEqual([
      "http:ANY /positions",
      "socket:TCP :7001",
      "consumer:on trades",
      "consumer:on trades",
      "scheduled:SnapshotJob.run",
      "main:ProcessorMain.main",
    ]);
  });

  it("level 2: socket clients, identical consumers folded, groups by kind and pipeline", () => {
    const v = serviceDataFlow(m, "svc:ledger");
    const labels = v.nodes.filter((n) => n.shape === "process").map((n) => n.label);
    // processes are named by what they do, the entry point underneath, numbered in data order
    const consumer = v.nodes.find((n) => n.label.endsWith("Consume trades · write trade_book ×2"));
    expect(consumer?.sub).toBe("same flow in TradeConsumerThread, TradeConsumer");
    // one of the two consumers was folded away; main moves no data here, so it is not drawn
    expect(labels.map((l) => l.replace(/^\d+\. /, "")).sort()).toEqual([
      "Consume trades · write trade_book ×2", "Receive ByteBuf", "Scheduled: publish positions · write position:*", "Serve ANY /positions",
    ]);
    expect(v.nodes.find((n) => n.label.endsWith("Receive ByteBuf"))?.sub).toBe("TCP :7001 · ledger");
    expect(v.edges.some((e) => e.source === "dfd:client:tcp" && e.target === "dfd:p:ep:tcp" && e.label === "ByteBuf")).toBe(true);
    const groups = new Map((v.groups ?? []).map((g) => [g.id, g]));
    expect(groups.get("proc:scheduled")?.label).toBe("Scheduled jobs");
    expect(groups.get("pipe:trades")?.parent).toBe("proc:consumer");
  });

  it("context: one system box, internal stores and topics hidden, the outside world grouped", () => {
    const v = contextDataFlow(m, "ledger");
    const ids = v.nodes.map((n) => n.id).sort();
    // trades is produced and consumed inside; positions is only published (someone outside reads it)
    expect(ids).toEqual([DFD_CLIENT, "dfd:client:tcp", DFD_SYSTEM, "ext:rates", "topic:redis:positions"].sort());
    expect(v.nodes.find((n) => n.id === DFD_SYSTEM)?.label).toBe("ledger");
    const edge = (s: string, t: string) => v.edges.find((e) => e.source === s && e.target === t);
    expect(edge("dfd:client:tcp", DFD_SYSTEM)?.label).toBe("ByteBuf");
    expect(edge(DFD_SYSTEM, "ext:rates")?.label).toBe("RateRequest");
    expect(edge(DFD_SYSTEM, "topic:redis:positions")?.label).toBe("String");
    expect(edge(DFD_CLIENT, DFD_SYSTEM)?.label).toBe("data"); // GET /positions: no typed body, still a call in
    expect(new Map((v.groups ?? []).map((g) => [g.id, g.label])).get("ctx:external")).toBe("External systems");
    // HTTP + socket clients sit together in Data in; other kinds have one member
    expect([...usefulGroups(v).keys()]).toEqual(["lane:in", "lane:mid", "lane:out", "lane:in|ctx:users"]);
  });
});
