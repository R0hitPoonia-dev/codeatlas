import { describe, expect, it } from "vitest";
import type { Graph } from "../api";
import { contextDataFlow } from "./dataflow";
import { Model } from "./model";
import { activityToPlantUml, sequenceToPlantUml, toPlantUml } from "./plantuml";
import type { Sequence } from "./sequence";

const graph: Graph = {
  nodes: [
    { id: "svc:a", kind: "service", name: "a" },
    { id: "class:S", kind: "class", name: "OrderService", parent: "svc:a" },
    {
      id: "m:place", kind: "method", name: "place", parent: "class:S",
      attrs: {
        controlFlow: [
          { k: "if", cond: "order == null", then: [{ k: "throw", text: "new IllegalArgumentException()" }] },
          { k: "loop", kind: "foreach", text: "for each line in order.lines()", body: [
            { k: "do", items: [{ text: "stock.reserve(line);", calls: [{ kind: "writes", target: "table:stock", name: "save" }] }] },
          ] },
          { k: "try", body: [{ k: "do", items: [{ text: "events.publish(order)" }] }],
            catches: [{ type: "IOException", body: [{ k: "do", items: [{ text: "log.warn(e)" }] }] }] },
          { k: "return", text: "order.id()" },
        ],
      },
    },
    { id: "ep:x", kind: "endpoint", name: "POST /orders", parent: "svc:a", attrs: { request: { type: "Order" } } },
    { id: "ext:pay", kind: "external", name: "pay.example.com" },
  ],
  edges: [
    { source: "ep:x", target: "m:place", kind: "handles" },
    { source: "m:place", target: "ext:pay", kind: "http_calls", attrs: { payloads: [{ type: "Charge" }] } },
  ],
};

describe("PlantUML export", () => {
  const m = new Model(graph);

  it("activity: structured if / while / partitions and a stop after return", () => {
    const puml = activityToPlantUml(m, "m:place");
    expect(puml.startsWith("@startuml\ntitle OrderService.place\nstart\n")).toBe(true);
    expect(puml).toContain("if (order == null?) then (yes)\n  :throw new IllegalArgumentException();\n  end\nendif");
    expect(puml).toContain("while (for each line in order.lines()) is (next)\n  :⛁ stock.reserve(line);\nendwhile (done)");
    expect(puml).toContain('partition "catch IOException" {');
    expect(puml.trimEnd().endsWith(":return order.id();\nstop\n@enduml")).toBe(true);
  });

  it("context diagram becomes C4 System Context", () => {
    const puml = toPlantUml("dataflow", contextDataFlow(m, "shop"));
    expect(puml).toContain("!include <C4/C4_Context>");
    expect(puml).toMatch(/System\(e\d+, "shop"/);
    expect(puml).toMatch(/Person\(e\d+, "Clients \/ users"/);
    expect(puml).toMatch(/System_Ext\(e\d+, "pay.example.com"/);
    expect(puml).toMatch(/Rel\(e\d+, e\d+, "Order"\)/);
  });

  it("sequence keeps service boxes and fragments", () => {
    const seq: Sequence = {
      participants: [
        { id: "actor:client", label: "Client", kind: "actor" },
        { id: "class:S", label: "OrderService", kind: "class", group: "a" },
        { id: "db", label: "orders-db", kind: "database" },
      ],
      items: [
        { k: "msg", from: "actor:client", to: "class:S", label: "POST /orders", style: "call" },
        { k: "frag", type: "alt", sections: [
          { label: "paid", items: [{ k: "msg", from: "class:S", to: "db", label: "save", style: "io" }] },
          { label: "else", items: [] },
        ] },
      ],
      truncated: false,
    };
    const puml = sequenceToPlantUml(seq);
    expect(puml).toContain('box "a"\nparticipant "OrderService" as p1\nend box');
    expect(puml).toContain('database "orders-db" as p2');
    expect(puml).toContain("alt paid\n  p1 -> p2 : save\nelse else\nend");
  });
});
