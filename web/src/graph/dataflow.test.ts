import { describe, expect, it } from "vitest";
import type { Graph } from "../api";
import { Classifier, classifyName } from "./dataclass";
import { DFD_CLIENT, serviceDataFlow, systemDataFlow } from "./dataflow";
import { Model } from "./model";

describe("classifyName", () => {
  it.each([
    ["customerEmail", "email"],
    ["cardToken", "payment"],
    ["iban", "payment"],
    ["password_hash", "credential"],
    ["accessToken", "credential"],
    ["ssn", "government-id"],
    ["phoneNumber", "phone"],
    ["dateOfBirth", "birth-date"],
    ["streetAddress", "address"],
    ["total", "financial"],
  ])("%s -> %s", (name, cls) => {
    expect(classifyName(name)).toBe(cls);
  });

  it("only treats a bare `name` as a person name on person-like owners", () => {
    expect(classifyName("name", "Customer")).toBe("person-name");
    expect(classifyName("name", "Product")).toBeUndefined();
    expect(classifyName("sku")).toBeUndefined();
  });
});

// A two-service system: shop (public) -> payments (internal), shop writes orders and publishes events.
const graph: Graph = {
  nodes: [
    { id: "svc:shop", kind: "service", name: "shop" },
    { id: "svc:payments", kind: "service", name: "payments" },
    { id: "ep:create", kind: "endpoint", name: "POST /orders", parent: "svc:shop",
      attrs: { request: { type: "NewOrder", typeId: "class:NewOrder" }, response: { type: "Order", typeId: "class:Order" } } },
    { id: "ep:charge", kind: "endpoint", name: "POST /charges", parent: "svc:payments" },
    { id: "class:NewOrder", kind: "class", name: "NewOrder", parent: "svc:shop" },
    { id: "f:NewOrder.email", kind: "field", name: "email", parent: "class:NewOrder", attrs: { type: "String" } },
    { id: "f:NewOrder.card", kind: "field", name: "cardNumber", parent: "class:NewOrder", attrs: { type: "String" } },
    { id: "class:Order", kind: "class", name: "Order", parent: "svc:shop" },
    { id: "f:Order.customer", kind: "field", name: "customer", parent: "class:Order", attrs: { type: "Customer" } },
    { id: "class:Customer", kind: "class", name: "Customer", parent: "svc:shop" },
    { id: "f:Customer.name", kind: "field", name: "name", parent: "class:Customer", attrs: { type: "String" } },
    { id: "m:create", kind: "method", name: "create", parent: "class:Order" },
    { id: "m:charge", kind: "method", name: "charge", parent: "class:Order" },
    { id: "db:shop", kind: "database", name: "shopdb" },
    { id: "table:orders", kind: "table", name: "orders", parent: "db:shop", attrs: { columns: [{ name: "id" }, { name: "billing_address" }] } },
    { id: "topic:events", kind: "topic", name: "events" },
  ],
  edges: [
    { source: "ep:create", target: "m:create", kind: "handles" },
    { source: "m:create", target: "m:charge", kind: "calls", attrs: { conditions: ["if paid"] } },
    { source: "m:charge", target: "svc:payments", kind: "http_calls", attrs: { payloads: [{ type: "params(cardNumber)" }], conditions: ["if paid"] } },
    { source: "m:create", target: "table:orders", kind: "writes", attrs: { payloads: [{ type: "Order", typeId: "class:Order" }], unconditional: true } },
    { source: "m:create", target: "topic:events", kind: "publishes", attrs: { payloads: [{ type: "NewOrder", typeId: "class:NewOrder" }], unconditional: true } },
  ],
};

describe("data flow views", () => {
  const m = new Model(graph);

  it("classifies nested types and table columns", () => {
    const c = new Classifier(m);
    expect([...c.ofType("class:Order").entries()]).toEqual([["person-name", ["customer.name"]]]);
    expect(c.ofTable(m.node("table:orders")!).get("address")).toEqual(["orders.billing_address"]);
  });

  it("system level: clients only reach public services, flows carry types and categories", () => {
    const v = systemDataFlow(m);
    const edge = (s: string, t: string) => v.edges.find((e) => e.source === s && e.target === t);
    const intake = edge(DFD_CLIENT, "svc:shop");
    expect(intake?.label).toBe("NewOrder");
    expect(intake?.sensitivity).toBe("high"); // cardNumber
    expect(intake?.sublabel).toContain("payment card");
    expect(edge("svc:shop", DFD_CLIENT)?.label).toBe("Order");
    expect(edge(DFD_CLIENT, "svc:payments")).toBeUndefined(); // only called internally
    // writes go to the database store, with both the entity's and the table's categories
    const write = edge("svc:shop", "db:shop");
    expect(write?.info?.classes.get("address")).toEqual(["orders.billing_address"]);
    expect(edge("svc:shop", "topic:events")?.label).toBe("NewOrder");
    expect(edge("svc:shop", "svc:payments")?.conditional).toBe(true);
    expect(v.nodes.find((n) => n.id === "svc:shop")?.shape).toBe("process");
    expect(v.nodes.find((n) => n.id === "db:shop")?.shape).toBe("store");
  });

  it("service level: one process per entry point, side effects through the call tree", () => {
    const v = serviceDataFlow(m, "svc:shop");
    const proc = v.nodes.find((n) => n.shape === "process");
    expect(proc?.label).toBe("Serve POST /orders"); // one process: nothing to number
    expect(proc?.sub).toBe("POST /orders · shop");
    const targets = v.edges.filter((e) => e.source === proc?.id).map((e) => e.target).sort();
    expect(targets).toEqual([DFD_CLIENT, "svc:payments", "table:orders", "topic:events"].sort());
    expect(v.nodes.find((n) => n.id === "svc:payments")?.shape).toBe("entity"); // other service
  });

  it("filters to sensitive flows", () => {
    const v = systemDataFlow(m, true);
    expect(v.edges.every((e) => e.sensitivity === "high" || e.sensitivity === "medium")).toBe(true);
    expect(v.edges.length).toBeGreaterThan(0);
  });
});
