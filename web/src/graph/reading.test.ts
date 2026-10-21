import { describe, expect, it } from "vitest";
import type { Graph } from "../api";
import { Model } from "./model";
import { withReading } from "./reading";
import { architectureView, endpoints, flowView, type ViewModel } from "./views";

describe("the reading pass every diagram goes through", () => {
  // gateway reads config, publishes trades; processor consumes trades, reads and writes ledger;
  // a timer job (nothing feeds it) writes a report
  const view: ViewModel = {
    direction: "RIGHT",
    groups: [{ id: "kafka", label: "Kafka", kind: "system" }, { id: "pg", label: "PostgreSQL", kind: "system" }],
    nodes: [
      { id: "cfg", label: "app.properties", shape: "entity" },
      { id: "gw", label: "gateway", shape: "service" },
      { id: "trades", label: "trades", shape: "topic", group: "kafka" },
      { id: "proc", label: "processor", shape: "service" },
      { id: "ledger", label: "ledger", shape: "database", group: "pg" },
      { id: "job", label: "reporter", shape: "service" },
      { id: "report", label: "report", shape: "table", group: "pg" },
      ...["a", "b", "c", "d", "e"].map((x) => ({ id: `t:${x}`, label: x, shape: "topic" as const, group: "kafka" })),
    ],
    edges: [
      { id: "1", source: "cfg", target: "gw", style: "data", count: 1, label: "url" },
      { id: "2", source: "gw", target: "trades", style: "publish", count: 1, label: "Trade", types: ["Trade"] },
      { id: "3", source: "trades", target: "proc", style: "consume", count: 1, label: "Trade", types: ["Trade"] },
      { id: "4", source: "proc", target: "ledger", style: "data", count: 1, label: "Row", both: true },
      { id: "5", source: "job", target: "report", style: "data", count: 1, label: "Report" },
      ...["a", "b", "c", "d", "e"].map((x) => ({ id: `p${x}`, source: "proc", target: `t:${x}`, style: "publish" as const, count: 1, label: "byte[]", sublabel: "publishes" })),
    ],
  };
  const v = withReading(view, { title: "test", middle: "Programs" });
  const laneOf = (id: string) => {
    const groups = new Map((v.groups ?? []).map((g) => [g.id, g]));
    let g = groups.get(v.nodes.find((n) => n.id === id)!.group ?? "");
    while (g?.parent) g = groups.get(g.parent);
    return g?.id;
  };

  it("puts what is only read on the left, only written on the right, handed between parts in the middle", () => {
    expect(laneOf("cfg")).toBe("lane:in");
    expect(laneOf("trades")).toBe("lane:mid"); // the gateway writes it, the processor reads it
    expect(laneOf("ledger")).toBe("lane:out"); // read and written by the same part
    expect(laneOf("report")).toBe("lane:out");
    expect(laneOf("gw")).toBe("lane:mid");
    // one data system split across lanes keeps a group on each side
    expect(v.nodes.find((n) => n.id === "t:a")?.group).toBe("lane:out|kafka");
    expect(v.nodes.find((n) => n.id === "trades")?.group).toBe("kafka");
  });

  it("numbers the parts in data order; a part nothing feeds does not jump ahead", () => {
    const label = (id: string) => v.nodes.find((n) => n.id === id)?.label;
    expect(label("gw")).toBe("1. gateway");
    expect(label("proc")).toBe("3. processor");
    expect(label("job")).toBe("2. reporter");
  });

  it("starts a system with many look-alike members folded", () => {
    expect(v.groups?.find((g) => g.id === "lane:out|kafka")?.fold).toBe(true);
    expect(v.groups?.find((g) => g.id === "lane:out|pg")?.fold).toBeUndefined();
  });

  it("gives the outline, three same-typed links into one system on one line", () => {
    const proc = v.outline!.parts.find((p) => p.id === "proc")!;
    expect(proc.n).toBe(3);
    expect(proc.inputs).toEqual([expect.objectContaining({ label: "trades", data: "Trade" })]);
    expect(proc.outputs).toEqual(expect.arrayContaining([expect.objectContaining({ label: "Kafka (5): a, b, c +2", data: "byte[]", via: "publishes" })]));
  });
});

describe("tabs read like the Program tab", () => {
  const graph: Graph = {
    nodes: [
      { id: "svc:orders", kind: "service", name: "orders", language: "java" },
      { id: "class:C", kind: "class", name: "OrderController", parent: "svc:orders" },
      { id: "method:C#create(OrderRequest)", kind: "method", name: "create", parent: "class:C", attrs: { params: [{ name: "req", type: "OrderRequest" }] } },
      { id: "class:S", kind: "class", name: "OrderService", parent: "svc:orders" },
      { id: "method:S#place(Order,int)", kind: "method", name: "place", parent: "class:S",
        attrs: { doc: "Places an order and charges the card. Retries twice.", params: [{ name: "order", type: "Order" }, { name: "qty", type: "int" }] } },
      { id: "method:S#save(Order)", kind: "method", name: "save", parent: "class:S", attrs: { params: [{ name: "order", type: "Order" }] } },
      { id: "ep:post", kind: "endpoint", name: "POST /orders", parent: "svc:orders", attrs: { route: "/orders", method: "POST", request: { type: "OrderRequest" } } },
      { id: "db:pg", kind: "database", name: "orders-db", otel: { "db.system": "postgresql" } },
      { id: "table:orders", kind: "table", name: "orders", parent: "db:pg" },
      { id: "topic:events", kind: "topic", name: "order-events", otel: { "messaging.system": "kafka" } },
    ],
    edges: [
      { source: "ep:post", target: "method:C#create(OrderRequest)", kind: "handles" },
      { source: "method:C#create(OrderRequest)", target: "method:S#place(Order,int)", kind: "calls" },
      { source: "method:S#place(Order,int)", target: "method:S#save(Order)", kind: "calls" },
      { source: "method:S#save(Order)", target: "table:orders", kind: "writes", attrs: { payloads: [{ type: "Order" }], operations: ["save"] } },
      { source: "method:S#save(Order)", target: "table:orders", kind: "reads", attrs: { responses: [{ type: "Order" }] } },
      { source: "method:S#place(Order,int)", target: "topic:events", kind: "publishes", attrs: { payloads: [{ type: "OrderPlaced" }] } },
    ],
  };
  const m = new Model(graph);

  it("architecture: services say what they do, lines carry their data", () => {
    const v = architectureView(m);
    const svc = v.nodes.find((n) => n.id === "svc:orders")!;
    expect(svc.sections?.[0].map((r) => r.text)).toEqual(["Serve POST /orders", "Publish order-events · write orders"]);
    const pub = v.edges.find((e) => e.source === "svc:orders" && e.target === "topic:events")!;
    expect(pub).toMatchObject({ label: "OrderPlaced", sublabel: "publishes", types: ["OrderPlaced"] });
    const rw = v.edges.find((e) => e.target === "db:pg")!;
    expect(rw).toMatchObject({ label: "Order", sublabel: "reads & writes", both: true });
    expect(v.outline?.parts.map((p) => p.title)).toEqual(["orders"]);
  });

  it("flow: functions named by what they do, calls carry their arguments, the request goes in", () => {
    const v = flowView(m, "ep:post");
    const place = v.nodes.find((n) => n.id === "method:S#place(Order,int)")!;
    expect(place.label).toMatch(/^\d\. Places an order and charges the card$/);
    expect(place.sub?.startsWith("OrderService.place")).toBe(true);
    const save = v.nodes.find((n) => n.id === "method:S#save(Order)")!;
    expect(save.label).toMatch(/^\d\. Write orders$/);
    expect(v.edges.find((e) => e.target === "method:S#place(Order,int)")).toMatchObject({ label: "Order, int", types: ["Order", "int"] });
    expect(v.edges.find((e) => e.source === "ep:post")).toMatchObject({ label: "OrderRequest", sublabel: "request" });
    expect(v.groups?.some((g) => g.id === "lane:out")).toBe(true);
  });

  it("api: each endpoint says what it does", () => {
    expect(endpoints(m)[0].does).toBe("Publish order-events · write orders");
  });
});
