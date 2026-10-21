import { describe, expect, it } from "vitest";
import type { Graph } from "../api";
import { activityView } from "./activity";
import { applyGroups, applyOverrides, collapsedAtLevel, configOverrides, defaultCollapsed, detailLevels, GROUP_NODE, mergeOverrides, usefulGroups } from "./groups";
import { toMermaid } from "./mermaid";
import { Model } from "./model";
import { collapseServices, Sequence } from "./sequence";
import type { VEdge, VNode, ViewModel } from "./views";

const node = (id: string, group?: string): VNode => ({ id, label: id, shape: "service", group });
const edge = (source: string, target: string, label?: string): VEdge => ({ id: `${source}>${target}`, source, target, style: "data", count: 1, label });

// app -> {pg: a, b}, app -> {kafka: t1, t2}, lone in "solo" group, nested: sys > pg
const view: ViewModel = {
  direction: "RIGHT",
  nodes: [node("app"), node("a", "pg"), node("b", "pg"), node("t1", "kafka"), node("t2", "kafka"), node("x", "solo")],
  edges: [edge("app", "a", "Order"), edge("app", "b", "Customer"), edge("app", "t1"), edge("t1", "t2"), edge("app", "x")],
  groups: [
    { id: "sys", label: "Stores", kind: "system" },
    { id: "pg", label: "PostgreSQL", kind: "system", parent: "sys" },
    { id: "kafka", label: "Kafka", kind: "system" },
    { id: "solo", label: "Solo", kind: "system" },
  ],
};

describe("group engine", () => {
  it("keeps only groups with at least two members", () => {
    // solo has one node; sys only wraps pg (one member) so it adds nothing
    expect([...usefulGroups(view).keys()].sort()).toEqual(["kafka", "pg"]);
  });

  it("drops a group that would wrap the whole diagram", () => {
    const all: ViewModel = { ...view, nodes: view.nodes.map((n) => ({ ...n, group: "kafka" })), groups: [{ id: "kafka", label: "K", kind: "system" }] };
    expect(usefulGroups(all).size).toBe(0);
  });

  it("collapses a group into one node and aggregates its edges", () => {
    const g = applyGroups(view, new Set(["pg"]));
    const box = g.nodes.find((n) => n.id === `${GROUP_NODE}pg`);
    expect(box?.collapsed).toBe(true);
    expect(box?.sub).toContain("×2");
    const merged = g.edges.filter((e) => e.target === `${GROUP_NODE}pg`);
    expect(merged).toHaveLength(1);
    expect(merged[0].count).toBe(2);
    expect(merged[0].label).toBe("Order +1");
    // edges inside a collapsed group disappear
    const k = applyGroups(view, new Set(["kafka"]));
    expect(k.edges.some((e) => e.source === `${GROUP_NODE}kafka` && e.target === `${GROUP_NODE}kafka`)).toBe(false);
    expect(g.containers.map((c) => c.id)).toEqual(["kafka"]);
  });

  it("expands by default when the diagram is small, collapses when large", () => {
    expect(defaultCollapsed(view).size).toBe(0);
    const big: ViewModel = {
      direction: "RIGHT",
      nodes: [
        ...Array.from({ length: 30 }, (_, i) => node(`a${i}`, "A")),
        ...Array.from({ length: 30 }, (_, i) => node(`b${i}`, "B")),
        node("c1", "C"), node("c2", "C"),
      ],
      edges: [],
      groups: [{ id: "A", label: "A", kind: "role" }, { id: "B", label: "B", kind: "role" }, { id: "C", label: "C", kind: "role" }],
    };
    const collapsed = defaultCollapsed(big, 36);
    // one big group fits next to the collapsed other and the small one: 30 + 1 + 2 = 33
    expect(applyGroups(big, collapsed).nodes.length).toBeLessThanOrEqual(36);
    expect(collapsed.has("C")).toBe(false);
    expect(collapsed.size).toBe(1);
  });

  it("exports groups as nested Mermaid subgraphs with node labels", () => {
    const text = toMermaid("architecture", view);
    expect(text).toMatch(/subgraph g\d+\["PostgreSQL"\]\n\s+n1\[/);
    expect(text).toContain('n0["app"]'); // node definitions are emitted
  });
});

describe("activity grouping", () => {
  const graph: Graph = {
    nodes: [
      { id: "m", kind: "method", name: "handle", attrs: { controlFlow: [
        { k: "if", cond: "req == null", then: [{ k: "throw", text: "new Bad()" }] },
        { k: "if", cond: "!req.valid()", then: [{ k: "return", text: "null" }] },
        { k: "loop", kind: "foreach", text: "for each x in xs", body: [{ k: "do", items: [{ text: "work(x)" }] }] },
        { k: "try", body: [{ k: "do", items: [{ text: "send()" }] }], catches: [{ type: "IOException", body: [{ k: "do", items: [{ text: "log()" }] }] }] },
      ] } },
    ],
    edges: [],
  };
  const v = activityView(new Model(graph), "m");

  it("folds leading guard clauses into one checks block", () => {
    const checks = v.nodes.find((n) => n.label === "checks (2)");
    expect(checks?.sections?.[0].map((r) => r.text)).toEqual(["req == null", "!req.valid()"]);
    expect(v.edges.filter((e) => e.source === checks?.id).map((e) => e.label).sort()).toEqual(["all pass", "any fails"]);
    expect(v.nodes.find((n) => n.label === "rejected (throw)")).toBeDefined();
  });

  it("puts loop, try and catch bodies in regions", () => {
    const [fnBox, ...regions] = v.groups ?? [];
    expect(fnBox).toMatchObject({ kind: "function", keep: true }); // the function's own steps
    expect(regions.map((g) => g.label)).toEqual(["loop · for each x in xs", "try", "catch IOException"]);
    expect(regions.every((g) => g.parent === fnBox.id || regions.some((r) => r.id === g.parent))).toBe(true);
    const work = v.nodes.find((n) => n.sections?.[0].some((r) => r.text === "work(x)"));
    expect(v.groups?.find((g) => g.id === work?.group)?.label).toBe("loop · for each x in xs");
    // single-step regions are kept; the function box alone around everything adds nothing
    expect(usefulGroups(v).size).toBe(3);
  });
});

describe("collapseServices", () => {
  const seq: Sequence = {
    truncated: false,
    participants: [
      { id: "client", label: "Client", kind: "actor" },
      { id: "A", label: "A", kind: "class", group: "orders" },
      { id: "B", label: "B", kind: "class", group: "orders" },
      { id: "db", label: "db", kind: "database" },
    ],
    items: [
      { k: "msg", from: "client", to: "A", label: "POST", style: "call" },
      { k: "frag", type: "opt", sections: [{ label: "x", items: [{ k: "msg", from: "A", to: "B", label: "inner()", style: "call" }] }] },
      { k: "msg", from: "B", to: "db", label: "save", style: "io" },
    ],
  };

  it("merges a service's lifelines and hides its internal calls", () => {
    const c = collapseServices(seq, new Set(["orders"]));
    expect(c.participants.map((p) => p.label)).toEqual(["Client", "orders", "db"]);
    expect(c.items.map((i) => (i.k === "msg" ? `${i.from}>${i.to}:${i.label}` : i.k))).toEqual([
      "client>collapsed:orders:POST", "collapsed:orders>db:save",
    ]); // the opt fragment only held an internal call, so it is gone
  });
});

describe("grouping edits", () => {
  const view: ViewModel = {
    direction: "RIGHT",
    nodes: [
      { id: "a", ref: "a", label: "A", shape: "service", group: "role:Persistence" },
      { id: "b", ref: "b", label: "B", shape: "service", group: "role:Messaging" },
      { id: "dfd:p:c", ref: "c", label: "C", shape: "process", group: "role:Messaging" },
      { id: "act:1", ref: "a", label: "step", shape: "action" },
    ],
    edges: [],
    groups: [
      { id: "role:Persistence", label: "Persistence", kind: "role" },
      { id: "role:Messaging", label: "Messaging", kind: "role" },
    ],
  };

  it("renames, and merges groups that end up with the same name", () => {
    const v = applyOverrides(view, { rename: { "role:Messaging": "Storage", "role:Persistence": "Storage" }, assign: {} });
    expect(v.groups?.map((g) => `${g.id}=${g.label}`)).toEqual(["role:Persistence=Storage"]);
    expect(new Set(v.nodes.slice(0, 3).map((n) => n.group))).toEqual(new Set(["role:Persistence"]));
  });

  it("moves nodes into an existing group by name, or a new one; never activity steps", () => {
    const v = applyOverrides(view, { rename: {}, assign: { b: "Persistence", c: "Pipelines", a: "Pipelines" } });
    const group = (id: string) => v.nodes.find((n) => n.id === id)?.group;
    expect(group("b")).toBe("role:Persistence");
    expect(group("dfd:p:c")).toBe("custom:Pipelines");
    expect(group("a")).toBe("custom:Pipelines");
    expect(group("act:1")).toBeUndefined(); // a step that merely calls `a` stays put
    expect(v.groups?.find((g) => g.id === "custom:Pipelines")?.kind).toBe("custom");
    expect(applyOverrides(view, { rename: {}, assign: { b: "" } })).toEqual(view); // empty = undone
  });

  it("repo config: globs over qualified names; a class brings its members; user edits win", () => {
    const m = new Model({
      nodes: [
        { id: "class:x.Trades", kind: "class", name: "Trades", qualifiedName: "com.acme.threads.Trades" },
        { id: "m:run", kind: "method", name: "run", parent: "class:x.Trades" },
        { id: "class:x.Other", kind: "class", name: "Other", qualifiedName: "com.acme.db.Other" },
      ],
      edges: [],
    });
    const cfg = configOverrides({ groups: [{ name: "Trade pipeline", members: ["com.acme.threads.*"] }], rename: { "proc:thread": "Workers" } }, m);
    expect(cfg.assign).toEqual({ "class:x.Trades": "Trade pipeline", "m:run": "Trade pipeline" });
    const merged = mergeOverrides(cfg, { rename: { "proc:thread": "Consumers" }, assign: { "m:run": "Mine" } });
    expect(merged.rename["proc:thread"]).toBe("Consumers");
    expect(merged.assign["m:run"]).toBe("Mine");
    expect(merged.assign["class:x.Trades"]).toBe("Trade pipeline");
  });
});

describe("detail levels", () => {
  // svc › pkg › class › fn › loop, plus a database box at the top (kept: stand-ins for bigger groups)
  const view: ViewModel = {
    direction: "DOWN",
    groups: [
      { id: "svc", label: "orders", kind: "service" },
      { id: "pkg", label: "api", kind: "package", parent: "svc", keep: true },
      { id: "pkg2", label: "core", kind: "package", parent: "svc", keep: true },
      { id: "cls", label: "Ctl", kind: "class", parent: "pkg", keep: true },
      { id: "cls2", label: "Svc", kind: "class", parent: "pkg2", keep: true },
      { id: "fn", label: "create", kind: "function", parent: "cls" },
      { id: "fn2", label: "place", kind: "function", parent: "cls2" },
      { id: "loop", label: "loop", kind: "region", parent: "fn" },
      { id: "db", label: "PostgreSQL", kind: "system" },
    ],
    nodes: [
      { id: "a", label: "a", shape: "action", group: "fn" },
      { id: "b", label: "b", shape: "action", group: "loop" },
      { id: "c", label: "c", shape: "action", group: "fn2" },
      { id: "d", label: "d", shape: "action", group: "fn2" },
      { id: "t1", label: "t1", shape: "table", group: "db" },
      { id: "t2", label: "t2", shape: "table", group: "db" },
    ],
    edges: [],
  };

  it("has as many levels as the boxes are deep, named after what they are", () => {
    const levels = detailLevels(view);
    expect(levels.map((l) => l.name)).toEqual([
      "Services & data systems", "Packages", "Classes", "Functions", "Blocks", "Everything",
    ]);
    expect(levels.map((l) => l.boxes)).toEqual([2, 2, 2, 2, 1, 0]);
  });

  it("uses the names given to levels", () => {
    expect(detailLevels(view, { Blocks: "Loops", Everything: "Every line" }).slice(-2).map((l) => [l.key, l.name]))
      .toEqual([["Blocks", "Loops"], ["Everything", "Every line"]]);
  });

  it("folds every box at the chosen depth and deeper", () => {
    expect(collapsedAtLevel(view, 1)).toEqual(new Set(["svc", "pkg", "pkg2", "cls", "cls2", "fn", "fn2", "loop", "db"]));
    expect(applyGroups(view, collapsedAtLevel(view, 1)).nodes).toHaveLength(2); // orders, PostgreSQL
    expect(collapsedAtLevel(view, 4)).toEqual(new Set(["fn", "fn2", "loop"]));
    expect(collapsedAtLevel(view, 6).size).toBe(0); // the last level: everything open
  });

  it("follows how deep the code actually is", () => {
    const shallow: ViewModel = { ...view, groups: view.groups!.filter((g) => g.id !== "loop"),
      nodes: view.nodes.map((n) => (n.group === "loop" ? { ...n, group: "fn" } : n)) };
    expect(detailLevels(shallow).map((l) => l.key)).toEqual(["Services & data systems", "Packages", "Classes", "Functions", "Everything"]);
  });
});

describe("detail level names", () => {
  it("names a level after the boxes holding most of it, and repeats as inner", () => {
    const view: ViewModel = {
      direction: "DOWN",
      groups: [
        { id: "svc", label: "s", kind: "service" },
        { id: "db", label: "PostgreSQL", kind: "system" },
        { id: "q", label: "Kafka", kind: "system" },
        { id: "fn", label: "f", kind: "function", parent: "svc" },
        { id: "fn2", label: "g", kind: "function", parent: "svc" },
        { id: "l1", label: "loop", kind: "region", parent: "fn" },
        { id: "l2", label: "loop", kind: "region", parent: "l1" },
        { id: "l3", label: "loop", kind: "region", parent: "l2" },
      ],
      nodes: [
        ...["a", "b", "c"].map((id) => ({ id, label: id, shape: "action" as const, group: "fn2" })),
        ...["d", "e"].map((id) => ({ id, label: id, shape: "action" as const, group: "l3" })),
        { id: "s", label: "start", shape: "start", group: "fn" },
        { id: "t1", label: "t", shape: "table", group: "db" }, { id: "t2", label: "t", shape: "table", group: "db" },
        { id: "k1", label: "k", shape: "topic", group: "q" }, { id: "k2", label: "k", shape: "topic", group: "q" },
      ],
      edges: [],
    };
    expect(detailLevels(view).map((l) => l.key)).toEqual([
      "Services & data systems", "Functions", "Blocks", "Inner blocks", "Inner blocks 2", "Everything",
    ]);
  });
});

describe("groups that start folded", () => {
  it("folds a group marked fold even when the diagram is small, and nothing else", () => {
    const view: ViewModel = {
      direction: "RIGHT",
      groups: [{ id: "kafka", label: "Kafka", kind: "system", fold: true }, { id: "redis", label: "Redis", kind: "system" }],
      nodes: [
        ...["a", "b", "c", "d", "e"].map((x) => ({ id: `t:${x}`, label: x, shape: "topic" as const, group: "kafka" })),
        { id: "k:1", label: "one", shape: "table" as const, group: "redis" },
        { id: "k:2", label: "two", shape: "table" as const, group: "redis" },
      ],
      edges: [],
    };
    expect([...defaultCollapsed(view)]).toEqual(["kafka"]);
  });
});
