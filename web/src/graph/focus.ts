// Focus on one box: the box itself (level 1), every box on a path through it (level 2: what
// leads to it and what it leads to, however far), and the lines along those paths. The rest
// of the diagram is dimmed.
import type { VEdge } from "./views";

export interface Focus {
  focus: string;
  /** Boxes on a path through the focus: upstream (lead to it) and downstream (it leads to). */
  related: Set<string>;
  upstream: Set<string>;
  downstream: Set<string>;
  /** Lines on those paths. */
  edges: Set<string>;
}

/** Lines that close a loop are not followed: through a loop everything would reach everything. */
const NOT_A_PATH = new Set<VEdge["style"]>(["back"]);

export function focusOn(focus: string, edges: VEdge[]): Focus {
  const out = new Map<string, VEdge[]>();
  const inc = new Map<string, VEdge[]>();
  for (const e of edges) {
    if (NOT_A_PATH.has(e.style) || e.source === e.target) continue;
    out.set(e.source, [...(out.get(e.source) ?? []), e]);
    inc.set(e.target, [...(inc.get(e.target) ?? []), e]);
  }
  const walk = (from: Map<string, VEdge[]>, next: (e: VEdge) => string) => {
    const seen = new Set<string>();
    const queue = [focus];
    while (queue.length) {
      for (const e of from.get(queue.shift()!) ?? []) {
        const n = next(e);
        if (n !== focus && !seen.has(n)) {
          seen.add(n);
          queue.push(n);
        }
      }
    }
    return seen;
  };
  const downstream = walk(out, (e) => e.target);
  const upstream = walk(inc, (e) => e.source);
  const down = new Set([focus, ...downstream]);
  const up = new Set([focus, ...upstream]);
  const onPath = new Set<string>();
  for (const e of edges) {
    if (NOT_A_PATH.has(e.style)) continue;
    // on a path into the focus, or on a path out of it
    if ((up.has(e.source) && up.has(e.target)) || (down.has(e.source) && down.has(e.target))) onPath.add(e.id);
  }
  return { focus, related: new Set([...upstream, ...downstream]), upstream, downstream, edges: onPath };
}
