import { describe, expect, it } from "vitest";
import type { Graph } from "../api";
import { activityView, Step } from "./activity";
import { sequenceToMermaid } from "./mermaid";
import { Model } from "./model";
import { routeMatches, sequenceOf, SeqItem } from "./sequence";

const cf = (steps: Step[]) => ({ controlFlow: steps });

// shop: Controller.create -> Service.place -> (loop) Client.reserve [feign, no body] -> inventory service
//       Service.place: if approved -> markPaid; writes orders; publishes events; try/catch around charge
const graph: Graph = {
  nodes: [
    { id: "svc:shop", kind: "service", name: "shop" },
    { id: "svc:inv", kind: "service", name: "inventory" },
    { id: "ep:create", kind: "endpoint", name: "POST /orders", parent: "svc:shop", attrs: { request: { type: "NewOrder" }, response: { type: "Order" } } },
    { id: "ep:reserve", kind: "endpoint", name: "POST /reservations", parent: "svc:inv", attrs: { method: "POST", route: "/reservations" } },
    { id: "class:Ctl", kind: "class", name: "Ctl", parent: "svc:shop" },
    { id: "class:Svc", kind: "class", name: "Svc", parent: "svc:shop" },
    { id: "class:Client", kind: "interface", name: "Client", parent: "svc:shop" },
    { id: "class:Order", kind: "class", name: "Order", parent: "svc:shop" },
    { id: "class:InvCtl", kind: "class", name: "InvCtl", parent: "svc:inv" },
    { id: "m:create", kind: "method", name: "create", parent: "class:Ctl", attrs: cf([
      { k: "return", text: "svc.place(o)", calls: [{ kind: "calls", target: "m:place", name: "place" }] },
    ]) },
    { id: "m:place", kind: "method", name: "place", parent: "class:Svc", attrs: { returnType: "Order", ...cf([
      { k: "loop", kind: "foreach", text: "for each line in lines", body: [
        { k: "do", items: [{ text: "client.reserve(line)", calls: [{ kind: "calls", target: "m:reserve", name: "reserve" }] }] },
      ] },
      { k: "try", body: [
        { k: "do", items: [{ text: "r = http.post(charge)", calls: [{ kind: "http_calls", target: "ext:pay", name: "POST /charges" }] }] },
      ], catches: [{ type: "IOException", body: [{ k: "throw", text: "new PaymentFailed()" }] }] },
      { k: "if", cond: "r.approved", then: [
        { k: "do", items: [{ text: "o.markPaid()", calls: [{ kind: "calls", target: "m:markPaid", name: "markPaid" }] }] },
      ] },
      { k: "do", items: [
        { text: "repo.save(o)", calls: [{ kind: "writes", target: "table:orders", name: "save" }] },
        { text: "kafka.send(e)", calls: [{ kind: "publishes", target: "topic:events", name: "send" }] },
      ] },
      { k: "return", text: "o" },
    ]) } },
    { id: "m:reserve", kind: "method", name: "reserve", parent: "class:Client" },
    { id: "m:markPaid", kind: "method", name: "markPaid", parent: "class:Order", attrs: cf([{ k: "do", items: [{ text: "status = PAID" }] }]) },
    { id: "m:getId", kind: "method", name: "getId", parent: "class:Order", attrs: cf([{ k: "return", text: "id" }]) },
    { id: "m:invReserve", kind: "method", name: "reserve", parent: "class:InvCtl", attrs: cf([
      { k: "do", items: [{ text: "stock.take()", calls: [{ kind: "writes", target: "table:stock", name: "save" }] }] },
    ]) },
    { id: "ext:pay", kind: "external", name: "payments.example.com" },
    { id: "db:shop", kind: "database", name: "shopdb" },
    { id: "table:orders", kind: "table", name: "orders", parent: "db:shop" },
    { id: "db:inv", kind: "database", name: "invdb" },
    { id: "table:stock", kind: "table", name: "stock", parent: "db:inv" },
    { id: "topic:events", kind: "topic", name: "events" },
  ],
  edges: [
    { source: "ep:create", target: "m:create", kind: "handles" },
    { source: "ep:reserve", target: "m:invReserve", kind: "handles" },
    { source: "m:reserve", target: "svc:inv", kind: "http_calls", attrs: { method: "POST", path: "/reservations" } },
    { source: "m:place", target: "ext:pay", kind: "http_calls", attrs: { responses: [{ type: "ChargeResult" }] } },
    { source: "m:place", target: "table:orders", kind: "writes", attrs: { payloads: [{ type: "Order" }] } },
  ],
};

describe("activity view", () => {
  const m = new Model(graph);
  const v = activityView(m, "m:place");
  const byLabel = (l: string) => v.nodes.find((n) => n.label === l);
  const out = (id: string) => v.edges.filter((e) => e.source === id);

  it("has a start, decisions for loops and ifs, and end nodes", () => {
    expect(v.nodes[0].shape).toBe("start");
    expect(byLabel("for each line in lines")?.shape).toBe("decision");
    expect(byLabel("r.approved?")?.shape).toBe("decision");
    expect(v.nodes.filter((n) => n.shape === "end").map((n) => n.label)).toEqual(["return o"]);
    expect(v.nodes.find((n) => n.shape === "throw")?.label).toBe("throw new PaymentFailed()");
  });

  it("labels branches and closes loops with a back edge", () => {
    const loop = byLabel("for each line in lines")!;
    expect(out(loop.id).map((e) => e.label).sort()).toEqual(["done", "next"]);
    expect(v.edges.some((e) => e.target === loop.id && e.style === "back")).toBe(true);
    const decision = byLabel("r.approved?")!;
    expect(out(decision.id).map((e) => e.label).sort()).toEqual(["no", "yes"]);
    const tryNode = byLabel("try")!;
    expect(out(tryNode.id).find((e) => e.style === "error")?.label).toBe("on IOException");
  });

  it("marks I/O in actions", () => {
    const io = v.nodes.find((n) => n.sections?.[0].some((r) => r.text.startsWith("repo.save")));
    expect(io?.sections?.[0].map((r) => r.marker)).toEqual(["⛁", "⇶"]);
  });
});

describe("sequence", () => {
  const m = new Model(graph);
  const flat = (items: SeqItem[]): SeqItem[] => items.flatMap((i) => (i.k === "frag" ? [i, ...i.sections.flatMap((s) => flat(s.items))] : [i]));
  const msgs = (items: SeqItem[]) => flat(items).filter((i): i is Extract<SeqItem, { k: "msg" }> => i.k === "msg");

  it("follows calls from the endpoint through classes, stores and other services", () => {
    const seq = sequenceOf(m, "ep:create", 4);
    // first appearance, with each service's lifelines kept together
    expect(seq.participants.map((p) => `${p.group ?? "-"}/${p.label}`)).toEqual([
      "-/Client", "shop/Ctl", "shop/Svc", "shop/Client", "shop/Order", "inventory/inventory", "inventory/InvCtl",
      "-/invdb", "-/payments.example.com", "-/shopdb", "-/events",
    ]);
    const labels = msgs(seq.items).map((x) => x.label);
    expect(labels[0]).toBe("POST /orders (NewOrder)");
    expect(labels).toContain("POST /reservations"); // through the bodiless Feign-style client
    expect(labels).toContain("reserve"); // ...into the inventory handler
    expect(labels).toContain("POST /charges");
    expect(labels).toContain("ChargeResult"); // response of the HTTP call
    expect(labels.at(-1)).toBe("Order"); // response to the client
    expect(msgs(seq.items).find((x) => x.label === "send()")?.style).toBe("async");
  });

  it("wraps conditional parts in fragments", () => {
    const seq = sequenceOf(m, "ep:create", 4);
    const frags = flat(seq.items).filter((i) => i.k === "frag") as Extract<SeqItem, { k: "frag" }>[];
    expect(frags.map((f) => `${f.type} ${f.sections[0].label}`)).toEqual([
      "loop for each line in lines", "critical try", "opt r.approved",
    ]);
    expect(frags[1].sections.map((s) => s.label)).toEqual(["try", "on IOException"]);
  });

  it("respects depth and groups lifelines by service in Mermaid", () => {
    const shallow = sequenceOf(m, "ep:create", 1);
    expect(msgs(shallow.items).map((x) => x.label)).toEqual(["POST /orders (NewOrder)", "place()", "Order", "Order"]);
    const text = sequenceToMermaid(sequenceOf(m, "ep:create", 4));
    expect(text).toContain("box shop");
    expect(text).toContain("box inventory");
    expect(text).toMatch(/critical try[\s\S]*option on IOException/);
  });

  it("matches routes with path parameters", () => {
    expect(routeMatches("/orders/{id}", "/orders/{x}")).toBe(true);
    expect(routeMatches("/orders/:id/cancel", "/orders/42/cancel")).toBe(true);
    expect(routeMatches("/orders", "/orders/42")).toBe(false);
  });
});

describe("step into (Flow tab)", () => {
  const m = new Model(graph);

  it("activity boxes list the in-repo functions they call, skipping bodiless ones and accessors", () => {
    const v = activityView(m, "m:create");
    const step = v.nodes.find((n) => n.refs?.length);
    expect(step?.refs).toEqual([{ id: "m:place", label: "Svc.place" }]);
    expect(step?.enterable).toBe(true);
    // Client.reserve (no body) is not something you can step into
    const place = activityView(m, "m:place");
    expect(place.nodes.flatMap((n) => n.refs ?? []).map((r) => r.id)).toEqual(["m:markPaid"]);
  });
});
