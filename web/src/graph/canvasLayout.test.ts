import { describe, expect, it } from "vitest";
import { elkGraph, overlayRoute, planTransition, Rect } from "./canvasLayout";
import { applyGroups, GROUP_NODE } from "./groups";
import type { ViewModel } from "./views";

const view: ViewModel = {
  direction: "DOWN", layout: "compact",
  groups: [
    { id: "cls", label: "Svc", kind: "class" },
    { id: "f", label: "place", kind: "function", parent: "cls", keep: true },
    { id: "loop", label: "loop", kind: "region", parent: "f" },
    { id: "g", label: "find", kind: "function", parent: "cls", keep: true },
  ],
  nodes: [
    { id: "f1", label: "start", shape: "start", group: "f" },
    { id: "f2", label: "x", shape: "action", group: "loop" },
    { id: "g1", label: "start", shape: "start", group: "g" },
    { id: "g2", label: "y", shape: "action", group: "g" },
    { id: "t", label: "orders", shape: "table" },
  ],
  edges: [
    { id: "e1", source: "f1", target: "f2", style: "call", count: 1 },
    { id: "e2", source: "g1", target: "g2", style: "call", count: 1 },
    { id: "e3", source: "f2", target: "g1", style: "call", count: 1 },
    { id: "e4", source: "g2", target: "t", style: "data", count: 1 },
  ],
};
const size = () => ({ width: 100, height: 40 });

describe("compact layout", () => {
  it("packs containers and lays out each function's steps as a flow", () => {
    const { graph, overlay } = elkGraph(applyGroups(view, new Set()), "DOWN", size, () => undefined);
    expect(graph.layoutOptions?.["elk.algorithm"]).toBe("rectpacking");
    const cls = graph.children!.find((c) => c.id === "c:cls")!;
    expect(cls.layoutOptions?.["elk.algorithm"]).toBe("rectpacking");
    const f = cls.children!.find((c) => c.id === "c:f")!;
    expect(f.layoutOptions).toMatchObject({ "elk.algorithm": "layered", "elk.hierarchyHandling": "INCLUDE_CHILDREN" });
    // steps inside one function are routed by ELK in that function, even into its loop
    expect(f.edges!.map((e) => e.id)).toEqual(["e1"]);
    expect(f.children!.find((c) => c.id === "c:loop")!.layoutOptions?.["elk.algorithm"]).toBeUndefined();
    // calls between functions and lines to tables are drawn over the packing
    expect(overlay.map((e) => e.id).sort()).toEqual(["e3", "e4"]);
  });

  it("keeps the single layered graph for other views", () => {
    const { graph, overlay } = elkGraph(applyGroups({ ...view, layout: undefined }, new Set()), "DOWN", size, () => undefined);
    expect(graph.layoutOptions?.["elk.algorithm"]).toBe("layered");
    expect(graph.edges).toHaveLength(4);
    expect(overlay).toHaveLength(0);
  });

  it("draws an elbow from the side facing the other box", () => {
    const a: Rect = { x: 0, y: 0, width: 100, height: 40 };
    expect(overlayRoute(a, { x: 200, y: 100, width: 100, height: 40 })).toEqual([
      { x: 50, y: 40 }, { x: 50, y: 70 }, { x: 250, y: 70 }, { x: 250, y: 100 },
    ]);
    expect(overlayRoute(a, { x: 300, y: 10, width: 100, height: 40 })).toEqual([
      { x: 100, y: 20 }, { x: 200, y: 20 }, { x: 200, y: 30 }, { x: 300, y: 30 },
    ]);
  });
});

describe("transitions", () => {
  const r = (x: number, y: number, width = 100, height = 40): Rect => ({ x, y, width, height });

  it("opens a folded box: its contents grow out of it, the rest moves", () => {
    const before = new Map([[GROUP_NODE + "f", r(10, 10, 120, 40)], ["t", r(300, 0)]]);
    const after = new Map([["c:f", r(10, 10, 300, 200)], ["f1", r(24, 46)], ["f2", r(24, 120)], ["t", r(400, 0)]]);
    const plan = planTransition(view, before, after);
    expect(plan.from.get("c:f")).toEqual(r(10, 10, 120, 40)); // the box grows from where it was folded
    expect(plan.from.get("f1")).toMatchObject({ x: 10, y: 10 }); // steps come out of it
    expect(plan.from.get("t")).toEqual(r(300, 0)); // others move from their old place
    expect(plan.ghosts).toEqual([]);
  });

  it("folds a box: its contents shrink into it", () => {
    const before = new Map([["c:f", r(10, 10, 300, 200)], ["f1", r(24, 46)], ["c:loop", r(24, 100, 150, 80)], ["f2", r(30, 130)]]);
    const after = new Map([[GROUP_NODE + "f", r(10, 10, 120, 40)]]);
    const plan = planTransition(view, before, after);
    expect(plan.from.get(GROUP_NODE + "f")).toEqual(r(10, 10, 300, 200));
    expect(plan.ghosts.map((g) => g.id).sort()).toEqual(["c:loop", "f1", "f2"]);
    expect(plan.ghosts.every((g) => g.to.x === 10 && g.to.y === 10)).toBe(true);
  });
});
