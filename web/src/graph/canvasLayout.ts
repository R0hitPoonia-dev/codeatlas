// Turns a grouped view into an ELK graph, reads the result back into boxes and edge routes,
// and plans the animation from one layout of a diagram to the next.
import type { ElkExtendedEdge } from "elkjs/lib/elk-api";
import { GROUP_NODE, GroupedView } from "./groups";
import type { VEdge, VNode, ViewModel } from "./views";

export interface Point {
  x: number;
  y: number;
}

export interface Rect extends Point {
  width: number;
  height: number;
}

export interface Route {
  points: Point[];
  labelBox?: Point;
}

export interface Layout {
  /** Positions relative to the parent box (what React Flow wants for child nodes). */
  positions: Map<string, Point>;
  routes: Map<string, Route>;
  boxSizes: Map<string, { width: number; height: number }>;
  /** Absolute rectangle of every box: leaves, collapsed groups (group:X) and group boxes (c:X). */
  rects: Map<string, Rect>;
}

export type ElkNode = {
  id: string;
  width?: number;
  height?: number;
  layoutOptions?: Record<string, string>;
  children?: ElkNode[];
  edges?: ElkEdgeIn[];
};
type ElkEdgeIn = {
  id: string; sources: string[]; targets: string[]; labels?: { id: string; text?: string; width: number; height: number }[];
  layoutOptions?: Record<string, string>;
};

/**
 * How strongly a line should point along the diagram (left to right, or down): lines that
 * carry data decide the order boxes are laid out in, so every diagram reads from where data
 * comes from to where it goes. Calls come next; structure (uses, inheritance, deployment,
 * loop-backs) never overrides them, so when the layout has to break a cycle it turns those.
 */
const DIRECTION_PRIORITY: Partial<Record<VEdge["style"], number>> = {
  data: 12, publish: 12, consume: 12, http: 12, connect: 12, handles: 12, uses: 8, sets: 8,
  call: 6, error: 3, fk: 2, depends: 1, association: 1, extends: 0, implements: 0, deploy: 1, back: 0,
};

const BOX_PADDING = "[top=36,left=14,bottom=14,right=14]";
/** Boxes whose contents are a flow of steps; everything else is a container of things. */
const FLOW_KINDS = new Set(["function", "region"]);

export interface ElkPlan {
  graph: ElkNode;
  /** Edges ELK does not route (compact layout: between packed boxes); drawn straight over it. */
  overlay: VEdge[];
}

/**
 * The ELK input for a grouped view. Normal views are one layered graph with every box inside
 * it. Compact views pack services, packages and classes tightly (rectpacking) and lay out
 * only the steps inside each function as a layered flow; lines between functions, tables and
 * services are left to `overlayRoute`.
 */
export function elkGraph(g: GroupedView, direction: "RIGHT" | "DOWN", size: (n: VNode) => { width: number; height: number },
  labelSize: (e: VEdge) => { width: number; height: number } | undefined, compact = g.layout === "compact",
  /** Width / height of the screen the diagram is shown on: packing aims for that shape. */
  aspect = 1.6): ElkPlan {
  const pack = { ...PACK_OPTIONS, "elk.aspectRatio": String(Math.min(Math.max(aspect, 0.8), 2.4)) };
  const ids = new Set(g.nodes.map((n) => n.id));
  const routed = g.edges.filter((e) => ids.has(e.source) && ids.has(e.target) && e.source !== e.target);
  const toElk = (e: VEdge): ElkEdgeIn => {
    const ls = labelSize(e);
    return {
      id: e.id, sources: [e.source], targets: [e.target], labels: ls ? [{ id: `${e.id}#label`, text: e.label, ...ls }] : [],
      layoutOptions: { "elk.layered.priority.direction": String(DIRECTION_PRIORITY[e.style] ?? 4) },
    };
  };

  const kind = new Map(g.containers.map((c) => [c.id, c.kind]));
  const parent = new Map(g.containers.map((c) => [c.id, c.parent]));
  const boxes = new Map<string, ElkNode>();
  const roots: ElkNode[] = [];
  /** Outermost flow box (function) around a container, if any. */
  const flowRoot = (container: string | undefined) => {
    let root: string | undefined;
    for (let c = container, guard = 0; c && guard < 60; c = parent.get(c), guard++) if (FLOW_KINDS.has(kind.get(c) ?? "")) root = c;
    return root;
  };
  for (const c of g.containers) {
    const box: ElkNode = { id: `c:${c.id}`, children: [], layoutOptions: { "elk.padding": BOX_PADDING } };
    if (compact) {
      const flow = FLOW_KINDS.has(c.kind);
      const outerFlow = flow && flowRoot(c.parent) === undefined;
      if (outerFlow) Object.assign(box.layoutOptions!, FLOW_OPTIONS("DOWN"), { "elk.hierarchyHandling": "INCLUDE_CHILDREN" });
      else if (!flow) Object.assign(box.layoutOptions!, pack);
      box.edges = [];
    }
    boxes.set(c.id, box);
  }
  for (const c of g.containers) {
    const box = boxes.get(c.id)!;
    (c.parent && boxes.get(c.parent) ? boxes.get(c.parent)!.children! : roots).push(box);
  }
  const home = new Map<string, string | undefined>();
  for (const n of g.nodes) {
    const container = n.group && boxes.has(n.group) ? n.group : undefined;
    home.set(n.id, container);
    (container ? boxes.get(container)!.children! : roots).push({ id: n.id, ...size(n) });
  }

  if (!compact) {
    return {
      graph: { id: "root", layoutOptions: { ...FLOW_OPTIONS(direction), "elk.hierarchyHandling": "INCLUDE_CHILDREN" }, children: roots, edges: routed.map(toElk) },
      overlay: [],
    };
  }
  // compact: tiles in reading order. A container's own state (fields, variables) first, like a
  // class body; then packages / classes by name; functions keep source order.
  const label = new Map(g.containers.map((c) => [`c:${c.id}`, c.label]));
  const leafShape = new Map(g.nodes.map((n) => [n.id, n.shape]));
  const rank = (n: ElkNode) => {
    if (leafShape.get(n.id) === "variable") return 0;
    const k = kind.get(n.id.slice(2));
    return k === "package" || k === "class" || k === "service" ? 1 : 2;
  };
  for (const box of [{ id: "root", children: roots } as ElkNode, ...boxes.values()]) {
    if (FLOW_KINDS.has(kind.get(box.id.slice(2)) ?? "")) continue; // a function's steps keep their order
    box.children!.sort((a, b) => rank(a) - rank(b) || (rank(a) === 1 ? (label.get(a.id) ?? "").localeCompare(label.get(b.id) ?? "") : 0));
  }
  // steps of one function are routed by ELK inside that function's box; the rest overlay
  const overlay: VEdge[] = [];
  for (const e of routed) {
    const a = flowRoot(home.get(e.source));
    if (a && a === flowRoot(home.get(e.target))) boxes.get(a)!.edges!.push(toElk(e));
    else overlay.push(e);
  }
  return { graph: { id: "root", layoutOptions: { ...pack, "elk.padding": "[top=24,left=24,bottom=24,right=24]" }, children: roots, edges: [] }, overlay };
}

function FLOW_OPTIONS(direction: "RIGHT" | "DOWN"): Record<string, string> {
  return {
    "elk.algorithm": "layered",
    "elk.direction": direction,
    "elk.edgeRouting": "ORTHOGONAL",
    "elk.spacing.nodeNode": "40",
    "elk.spacing.edgeEdge": "14",
    "elk.spacing.edgeNode": "18",
    "elk.spacing.edgeLabel": "4",
    "elk.layered.spacing.nodeNodeBetweenLayers": "70",
    "elk.layered.spacing.edgeNodeBetweenLayers": "22",
    "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
    "elk.edgeLabels.placement": "CENTER",
    "elk.spacing.componentComponent": "60",
  };
}

/**
 * Tiles: boxes packed in rows, with gaps wide enough to see where one box ends and the next
 * starts, and room at the top of each box for its title.
 */
const PACK_OPTIONS: Record<string, string> = {
  "elk.algorithm": "rectpacking",
  "elk.aspectRatio": "1.6",
  "elk.spacing.nodeNode": "56",
  "elk.padding": "[top=52,left=28,bottom=28,right=28]",
  "elk.contentAlignment": "V_TOP H_LEFT",
};

type ElkOut = { id: string; x?: number; y?: number; width?: number; height?: number; children?: ElkOut[]; edges?: (ElkExtendedEdge & { container?: string })[] };

/** Reads ELK's result back: relative positions, absolute rectangles and edge routes. */
export function readLayout(res: ElkOut, overlay: VEdge[]): Layout {
  const positions = new Map<string, Point>();
  const rects = new Map<string, Rect>();
  const boxSizes = new Map<string, { width: number; height: number }>();
  const absolute = new Map<string, Point>([["root", { x: 0, y: 0 }]]);
  const elkEdges: (ElkExtendedEdge & { container?: string })[] = [...(res.edges ?? [])];
  const walk = (n: ElkOut, origin: Point) => {
    const rel = { x: n.x ?? 0, y: n.y ?? 0 };
    positions.set(n.id, rel);
    const abs = { x: origin.x + rel.x, y: origin.y + rel.y };
    rects.set(n.id, { ...abs, width: n.width ?? 0, height: n.height ?? 0 });
    if (n.id.startsWith("c:")) {
      absolute.set(n.id, abs);
      boxSizes.set(n.id, { width: n.width ?? 0, height: n.height ?? 0 });
    }
    elkEdges.push(...(n.edges ?? []));
    for (const c of n.children ?? []) walk(c, abs);
  };
  for (const c of res.children ?? []) walk(c, { x: 0, y: 0 });

  const routes = new Map<string, Route>();
  for (const e of elkEdges) {
    const s = e.sections?.[0];
    if (!s) continue;
    // edge coordinates are relative to the box ELK reports as the edge's container
    const o = absolute.get(e.container ?? "root") ?? { x: 0, y: 0 };
    const shift = (p: Point) => ({ x: p.x + o.x, y: p.y + o.y });
    const l = e.labels?.[0];
    routes.set(e.id, {
      points: [s.startPoint, ...(s.bendPoints ?? []), s.endPoint].map(shift),
      labelBox: l && l.x !== undefined && l.y !== undefined ? shift({ x: l.x, y: l.y }) : undefined,
    });
  }
  for (const e of overlay) {
    const a = rects.get(e.source);
    const b = rects.get(e.target);
    if (a && b) routes.set(e.id, { points: overlayRoute(a, b) });
  }
  return { positions, routes, boxSizes, rects };
}

/**
 * A line between two boxes laid out independently: leaves the side facing the other box and
 * turns once halfway (an elbow), so it reads like the routed lines inside functions.
 */
export function overlayRoute(a: Rect, b: Rect): Point[] {
  const ac = { x: a.x + a.width / 2, y: a.y + a.height / 2 };
  const bc = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  if (b.y >= a.y + a.height || b.y + b.height <= a.y) {
    // one above the other: bottom/top centres, horizontal run halfway between them
    const down = bc.y > ac.y;
    const s = { x: ac.x, y: down ? a.y + a.height : a.y };
    const t = { x: bc.x, y: down ? b.y : b.y + b.height };
    const midY = (s.y + t.y) / 2;
    return s.x === t.x ? [s, t] : [s, { x: s.x, y: midY }, { x: t.x, y: midY }, t];
  }
  // side by side: right/left centres, vertical run halfway
  const right = bc.x > ac.x;
  const s = { x: right ? a.x + a.width : a.x, y: ac.y };
  const t = { x: right ? b.x : b.x + b.width, y: bc.y };
  const midX = (s.x + t.x) / 2;
  return s.y === t.y ? [s, t] : [s, { x: midX, y: s.y }, { x: midX, y: t.y }, t];
}

// ------------------------------------------------------------- transitions

export interface Transition {
  /** Where each box of the new layout starts its move (absent: it fades in where it is). */
  from: Map<string, Rect>;
  /** Boxes of the old layout that disappear: they move into the box that now holds them. */
  ghosts: { id: string; from: Rect; to: Rect }[];
}

/**
 * How to move from one layout of a diagram to the next so every box can be followed: boxes in
 * both move; boxes appearing (a folded group opened) grow out of the folded box they were in;
 * boxes disappearing (their group folded) shrink into it. Element ids: leaf node ids, c:<group>
 * for a group box, group:<group> for a folded group.
 */
export function planTransition(view: ViewModel, prev: Map<string, Rect>, next: Map<string, Rect>): Transition {
  const parentOf = new Map((view.groups ?? []).map((g) => [g.id, g.parent]));
  const groupOfNode = new Map(view.nodes.map((n) => [n.id, n.group]));
  /** Groups an element sits in, innermost first (a group box / folded group starts with itself). */
  const groupsOf = (id: string): string[] => {
    let g = id.startsWith("c:") ? id.slice(2) : id.startsWith(GROUP_NODE) ? id.slice(GROUP_NODE.length) : groupOfNode.get(id);
    const out: string[] = [];
    for (let guard = 0; g && guard < 60; g = parentOf.get(g), guard++) out.push(g);
    return out;
  };
  /** The box standing for group g in a layout: folded, or open. */
  const boxOf = (rects: Map<string, Rect>, g: string) => rects.get(GROUP_NODE + g) ?? rects.get(`c:${g}`);

  const from = new Map<string, Rect>();
  for (const [id, rect] of next) {
    const old = prev.get(id);
    if (old) {
      from.set(id, old);
      continue;
    }
    // a group opened (group:X -> c:X), folded (c:X -> group:X), or it came out of a folded group
    for (const g of groupsOf(id)) {
      const was = prev.get(GROUP_NODE + g) ?? (id === `${GROUP_NODE}${g}` ? prev.get(`c:${g}`) : undefined);
      if (was) {
        from.set(id, id.startsWith("c:") || id.startsWith(GROUP_NODE) ? was : { ...was, width: rect.width, height: rect.height });
        break;
      }
    }
  }
  const ghosts: Transition["ghosts"] = [];
  for (const [id, rect] of prev) {
    if (next.has(id)) continue;
    const self = id.startsWith("c:") ? id.slice(2) : id.startsWith(GROUP_NODE) ? id.slice(GROUP_NODE.length) : undefined;
    if (self && (next.has(GROUP_NODE + self) || next.has(`c:${self}`))) continue; // the same group, folded or opened
    for (const g of groupsOf(id)) {
      if (g === self) continue;
      const to = boxOf(next, g);
      if (to) {
        ghosts.push({ id, from: rect, to: { ...to, width: Math.min(rect.width, to.width), height: Math.min(rect.height, to.height) } });
        break;
      }
    }
  }
  return { from, ghosts };
}
