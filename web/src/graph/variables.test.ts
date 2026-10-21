import { describe, expect, it } from "vitest";
import type { Graph } from "../api";
import { activityView, FN_BOX } from "./activity";
import { allLayersView, classInside } from "./explore";
import { Model } from "./model";
import { variableEdges, variableId, whatItDoes } from "./variables";

// Counter.add: line 20 sum = qty * 2 · line 21 total += sum (static) · line 22 recent.add(order) (field)
// line 23 if (sum > LIMIT) (imported) · line 24 return sum
const graph: Graph = {
  nodes: [
    { id: "svc:s", kind: "service", name: "s" },
    { id: "pkg:p", kind: "package", name: "p", parent: "svc:s" },
    { id: "class:Counter", kind: "class", name: "Counter", parent: "pkg:p", location: { file: "p/Counter.java", startLine: 1 } },
    { id: "field:Counter#total", kind: "field", name: "total", parent: "class:Counter", attrs: { type: "int", static: true } },
    { id: "field:Counter#recent", kind: "field", name: "recent", parent: "class:Counter", attrs: { type: "List<String>" } },
    { id: "field:Counter#unused", kind: "field", name: "unused", parent: "class:Counter", attrs: { type: "int" } },
    {
      id: "m:add", kind: "method", name: "add", parent: "class:Counter",
      attrs: {
        doc: "Adds an order.", params: [{ name: "order", type: "String" }, { name: "qty", type: "int" }], returnType: "int",
        controlFlow: [
          { k: "do", line: 20, items: [{ text: "int sum = qty * 2", line: 20 }, { text: "total += sum", line: 21 }, { text: "recent.add(order)", line: 22 }] },
          { k: "if", line: 23, cond: "sum > LIMIT", then: [{ k: "throw", line: 23, text: "new TooMany()" }] },
          { k: "return", line: 24, text: "sum" },
        ],
        variables: [
          { name: "order", scope: "param", type: "String", line: 19, reads: 1, writes: 0, lines: [22] },
          { name: "qty", scope: "param", type: "int", line: 19, reads: 1, writes: 0, lines: [20] },
          { name: "sum", scope: "local", type: "int", line: 20, reads: 3, writes: 0, lines: [21, 23, 24] },
          { name: "total", scope: "static", type: "int", declaredIn: "field:Counter#total", reads: 0, writes: 1, lines: [21], writeLines: [21] },
          { name: "recent", scope: "field", type: "List<String>", declaredIn: "field:Counter#recent", reads: 0, writes: 1, lines: [22], writeLines: [22], final: true },
          { name: "LIMIT", scope: "imported", type: "number", declaredIn: "src/config.ts", reads: 1, writes: 0, lines: [23], final: true },
        ],
      },
    },
  ],
  edges: [],
};
const m = new Model(graph);

describe("what a function does", () => {
  it("summarises doc, inputs, output, state changes and shape", () => {
    const text = whatItDoes(m, m.node("m:add")!).map((r) => r.text);
    expect(text).toContain("Adds an order.");
    expect(text).toContain("takes order: String, qty: int");
    expect(text).toContain("returns int");
    expect(text).toContain("changes state outside it: total, recent");
    expect(text).toContain("1 decision, can fail (1 throw)");
  });
});

describe("variables on the activity diagram", () => {
  const v = activityView(m, "m:add");
  const node = (id: string) => v.nodes.find((n) => n.id === id);

  it("keeps the function's own variables inside its box, on the start box", () => {
    const start = v.nodes.find((n) => n.shape === "start")!;
    expect(start.group).toBe(FN_BOX);
    const own = start.sections![1].map((r) => r.text);
    expect(own).toEqual(["order: String — parameter", "qty: int — parameter", "sum: int — local"]);
  });

  it("puts outside variables in separate boxes, grouped by where they are declared", () => {
    const total = node("var:field:Counter#total")!;
    expect(total).toMatchObject({ shape: "variable", label: "total", group: "home:class:Counter" });
    expect(node("var:field:Counter#recent")?.sub).toBe("List<String> · field · final");
    const limit = v.nodes.find((n) => n.label === "LIMIT")!;
    expect(limit.group).toBe("home:file:src/config.ts");
    expect(v.groups?.find((g) => g.id === "home:class:Counter")).toMatchObject({ kind: "scope", label: "Counter" });
    // none of them is inside the function box
    expect([total, limit].every((n) => n.group !== FN_BOX)).toBe(true);
  });

  it("links each variable to the step that uses it", () => {
    const action = v.nodes.find((n) => n.shape === "action")!;
    const decision = v.nodes.find((n) => n.shape === "decision")!;
    expect(v.edges.find((e) => e.source === action.id && e.target === "var:field:Counter#total")).toMatchObject({ style: "sets", label: "changes" });
    const limit = v.nodes.find((n) => n.label === "LIMIT")!;
    expect(v.edges.find((e) => e.source === limit.id)).toMatchObject({ target: decision.id, style: "uses", label: "reads" });
  });

  it("pins a use to the last step starting at or before its line", () => {
    const steps = [{ id: "a", lines: [10] }, { id: "b", lines: [14, 15] }, { id: "c", lines: [20] }];
    const e = variableEdges({ name: "x", scope: "module", reads: 2, writes: 1, lines: [12, 16, 20], writeLines: [20] }, steps, "start");
    expect(e.map((x) => `${x.source}>${x.target}`).sort()).toEqual([
      "c>var:module::x", "var:module::x>a", "var:module::x>b",
    ]);
  });
});

describe("variables at class level and in all layers", () => {
  it("draws the class as its own box with its fields inside and outside state beside it", () => {
    const v = classInside(m, "class:Counter");
    const cls = v.groups!.find((g) => g.kind === "class")!;
    expect(cls.label).toBe("Counter");
    const inClass = v.nodes.filter((n) => n.group === cls.id).map((n) => n.id).sort();
    expect(inClass).toEqual(["m:add", "var:field:Counter#recent", "var:field:Counter#total", "var:field:Counter#unused"]);
    expect(v.nodes.find((n) => n.label === "LIMIT")?.group).toBe("home:file:src/config.ts");
    expect(v.edges.some((e) => e.source === "m:add" && e.target === "var:field:Counter#total" && e.label === "changes")).toBe(true);
    expect(v.nodes.find((n) => n.id === "m:add")?.sections?.[0].map((r) => r.text)).toContain("Adds an order.");
  });

  it("places fields in their class box, beside the function boxes", () => {
    const v = allLayersView(m, { kind: "system" });
    const total = v.nodes.find((n) => n.id === variableId({ name: "total", scope: "static", declaredIn: "field:Counter#total", reads: 0, writes: 0 }))!;
    expect(total.group).toBe("L:class:Counter");
    expect(v.groups?.find((g) => g.id === "F:m:add")?.parent).toBe("L:class:Counter");
    expect(v.edges.some((e) => e.source.startsWith("m:add|") && e.target === total.id && e.style === "sets")).toBe(true);
    const ids = new Set(v.nodes.map((n) => n.id));
    for (const e of v.edges) expect(ids.has(e.source) && ids.has(e.target), `${e.source} -> ${e.target}`).toBe(true);
  });
});
