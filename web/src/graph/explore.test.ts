import { describe, expect, it } from "vitest";
import type { Graph } from "../api";
import { DFD_SYSTEM } from "./dataflow";
import { allLayersView, CHOICE, classInside, insideOf, packageInside, pathTo, scopeOfNode, scopeView, withChoices } from "./explore";
import { Model } from "./model";

const cf = [{ k: "do", items: [{ text: "repo.save(o)", calls: [{ kind: "writes", target: "table:orders", name: "save" }] }] }];
const graph: Graph = {
  nodes: [
    { id: "svc:shop", kind: "service", name: "shop" },
    { id: "svc:mail", kind: "service", name: "mail" },
    { id: "pkg:api", kind: "package", name: "api", parent: "svc:shop" },
    { id: "pkg:core", kind: "package", name: "core", parent: "svc:shop" },
    { id: "ep:create", kind: "endpoint", name: "POST /orders", parent: "svc:shop" },
    { id: "class:Ctl", kind: "class", name: "Ctl", parent: "pkg:api" },
    { id: "m:create", kind: "method", name: "create", parent: "class:Ctl", attrs: { controlFlow: [
      { k: "do", items: [{ text: "svc.place()", calls: [{ kind: "calls", target: "m:place", name: "place" }] }] },
    ] } },
    { id: "class:Svc", kind: "class", name: "Svc", parent: "pkg:core" },
    { id: "m:place", kind: "method", name: "place", parent: "class:Svc", attrs: { controlFlow: cf } },
    { id: "m:helper", kind: "method", name: "helper", parent: "class:Svc" },
    { id: "fn:send", kind: "function", name: "send", parent: "svc:mail", attrs: { controlFlow: cf } },
    { id: "db:main", kind: "database", name: "main" },
    { id: "table:orders", kind: "table", name: "orders", parent: "db:main" },
  ],
  edges: [
    { source: "ep:create", target: "m:create", kind: "handles" },
    { source: "m:create", target: "m:place", kind: "calls" },
    { source: "m:place", target: "m:helper", kind: "calls" },
    { source: "m:place", target: "table:orders", kind: "writes" },
  ],
};
const m = new Model(graph);

describe("explore levels", () => {
  it("knows which level each kind of box opens", () => {
    expect(scopeOfNode(m, m.node("svc:shop")!)).toEqual({ kind: "service", id: "svc:shop" });
    expect(scopeOfNode(m, m.node("svc:mail")!)).toEqual({ kind: "package", id: "svc:mail" }); // no packages: its root
    expect(scopeOfNode(m, m.node("pkg:core")!)).toEqual({ kind: "package", id: "pkg:core" });
    expect(scopeOfNode(m, m.node("class:Svc")!)).toEqual({ kind: "class", id: "class:Svc" });
    expect(scopeOfNode(m, m.node("m:place")!)).toEqual({ kind: "function", id: "m:place" });
    expect(scopeOfNode(m, m.node("m:helper")!)).toBeUndefined(); // no body to show
    expect(scopeOfNode(m, m.node("db:main")!)).toEqual({ kind: "database", id: "db:main" });
    expect(scopeOfNode(m, m.node("ep:create")!)).toEqual({ kind: "function", id: "m:create" }); // its handler
  });

  it("builds the full path back to level 0", () => {
    expect(pathTo(m, "m:place").map((s) => `${s.kind}:${s.id ?? ""}`)).toEqual([
      "context:", "system:", "service:svc:shop", "package:pkg:core", "class:class:Svc", "function:m:place",
    ]);
    expect(pathTo(m, "db:main").map((s) => s.kind)).toEqual(["context", "system", "database"]);
  });

  it("offers Inside on the right boxes at each level", () => {
    expect(insideOf(m, { kind: "context" }, { id: DFD_SYSTEM, label: "x", shape: "process" })).toEqual([{ scope: { kind: "system" }, label: "the system" }]);
    expect(insideOf(m, { kind: "system" }, { id: "svc:shop", ref: "svc:shop", label: "shop", shape: "service" })[0].scope)
      .toEqual({ kind: "service", id: "svc:shop" });
    // inside a function, steps open the functions they call
    const fn = scopeView(m, { kind: "function", id: "m:create" }, "sys");
    const step = fn.nodes.find((n) => n.refs?.length)!;
    expect(insideOf(m, { kind: "function", id: "m:create" }, step).map((t) => t.scope)).toEqual([{ kind: "function", id: "m:place" }]);
  });

  it("package level shows its classes, calls between them and what they touch outside", () => {
    const v = packageInside(m, "pkg:core");
    expect(v.nodes.map((n) => n.id).sort()).toEqual(["class:Svc", "db:main"]);
    expect(v.edges.some((e) => e.source === "class:Svc" && e.target === "db:main")).toBe(true);
    const api = packageInside(m, "pkg:api");
    expect(api.nodes.find((n) => n.id === "pkg:core")?.faded).toBe(true); // calls into another package
  });

  it("class level shows methods, calls among them, and who calls in", () => {
    const v = classInside(m, "class:Svc");
    const ids = v.nodes.map((n) => n.id);
    expect(ids).toEqual(expect.arrayContaining(["m:place", "m:helper", "db:main"]));
    expect(v.edges.some((e) => e.source === "m:place" && e.target === "m:helper")).toBe(true);
    expect(v.nodes.find((n) => n.id === "m:helper")?.faded).toBe(true); // nothing inside to open
  });
});

describe("all layers in one view", () => {
  const v = allLayersView(m, { kind: "system" });
  const group = (id: string) => v.groups?.find((g) => g.id === id);

  it("nests service › package › class › function, each function holding its steps", () => {
    expect(group("F:m:place")).toMatchObject({ kind: "function", parent: "L:class:Svc" });
    expect(group("L:class:Svc")?.parent).toBe("L:pkg:core");
    expect(group("L:pkg:core")?.parent).toBe("L:svc:shop");
    const steps = v.nodes.filter((n) => n.id.startsWith("m:place|"));
    expect(steps.some((n) => n.shape === "start")).toBe(true);
    expect(steps.every((n) => n.enterable === false)).toBe(true);
    // a service without packages still gets its function
    expect(group("F:fn:send")?.parent).toBe("L:svc:mail");
  });

  it("links a calling step to the start of the called function, and steps to the tables they touch", () => {
    const ids = new Set(v.nodes.map((n) => n.id));
    for (const e of v.edges) {
      expect(ids.has(e.source), e.source).toBe(true);
      expect(ids.has(e.target), e.target).toBe(true);
    }
    const call = v.edges.find((e) => e.style === "call" && e.source.startsWith("m:create|"))!;
    expect(v.nodes.find((n) => n.id === call.target)).toMatchObject({ shape: "start" });
    expect(call.target.startsWith("m:place|")).toBe(true);
    expect(v.edges.some((e) => e.source.startsWith("m:place|") && e.target === "table:orders")).toBe(true);
    expect(v.nodes.find((n) => n.id === "table:orders")?.group).toBe("db:db:main");
    expect(v.edges.some((e) => e.source === "ep:create" && e.style === "handles")).toBe(true);
  });

  it("inside a function covers its whole call tree only", () => {
    const fnView = allLayersView(m, { kind: "function", id: "m:create" });
    const fns = new Set((fnView.groups ?? []).filter((g) => g.kind === "function").map((g) => g.id));
    expect(fns).toEqual(new Set(["F:m:create", "F:m:place"]));
    expect(fnView.nodes.some((n) => n.id === "m:helper")).toBe(true); // called, no body: a plain box
    expect(fnView.nodes.some((n) => n.id.startsWith("fn:send"))).toBe(false);
  });
});

describe("choices fanned out on the canvas", () => {
  it("adds each choice next to the box, linked to it", () => {
    const base = scopeView(m, { kind: "system" }, "sys");
    const box = base.nodes.find((n) => n.ref === "svc:shop")!;
    const v = withChoices(base, box.id, [{ key: "a", label: "A" }, { key: "b", label: "B", ref: "m:place" }]);
    const picks = v.nodes.filter((n) => n.id.startsWith(CHOICE));
    expect(picks.map((n) => n.label)).toEqual(["A", "B"]);
    expect(picks.every((n) => n.group === box.group && n.enterable)).toBe(true);
    expect(v.edges.filter((e) => e.source === box.id && e.target.startsWith(CHOICE))).toHaveLength(2);
    expect(withChoices(base, "nope", [{ key: "a", label: "A" }])).toBe(base);
  });
});
