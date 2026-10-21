import { describe, expect, it } from "vitest";
import { focusOn } from "./focus";
import type { VEdge } from "./views";

const e = (source: string, target: string, style: VEdge["style"] = "call"): VEdge => ({ id: `${source}>${target}`, source, target, style, count: 1 });

describe("focus", () => {
  // a -> b -> c -> d, x -> c, y unrelated (y -> z), and a loop back d -> b
  const edges = [e("a", "b"), e("b", "c"), e("c", "d"), e("x", "c"), e("y", "z"), e("d", "b", "back")];

  it("lights everything on a path through the box, however far", () => {
    const f = focusOn("b", edges);
    expect([...f.upstream].sort()).toEqual(["a"]);
    expect([...f.downstream].sort()).toEqual(["c", "d"]);
    expect([...f.related].sort()).toEqual(["a", "c", "d"]);
    expect(f.related.has("x")).toBe(false); // feeds c, but not through b
    expect(f.related.has("y")).toBe(false);
    expect([...f.edges].sort()).toEqual(["a>b", "b>c", "c>d"]);
  });

  it("follows both directions from a box in the middle", () => {
    const f = focusOn("c", edges);
    expect([...f.upstream].sort()).toEqual(["a", "b", "x"]);
    expect([...f.downstream]).toEqual(["d"]);
    expect(f.edges.has("x>c")).toBe(true);
  });

  it("does not follow loop-back lines (everything in a loop would light up)", () => {
    expect(focusOn("d", edges).downstream.size).toBe(0);
  });

  it("an unconnected box has nothing on its paths", () => {
    expect(focusOn("q", edges).related.size).toBe(0);
  });
});
