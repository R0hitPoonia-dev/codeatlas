import {
  Background,
  BaseEdge,
  Controls,
  Edge,
  EdgeLabelRenderer,
  EdgeProps,
  Handle,
  MarkerType,
  MiniMap,
  Node,
  NodeProps,
  Position,
  ReactFlow,
  ReactFlowInstance,
  ReactFlowProvider,
  Viewport,
  ViewportPortal,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { elkGraph, Layout, planTransition, Point, readLayout, Rect, Transition } from "../graph/canvasLayout";
import { focusOn } from "../graph/focus";
import { applyGroups, collapsedAtLevel, defaultCollapsed, GROUP_NODE, GroupedView } from "../graph/groups";
import type { EdgeStyle, Shape, VEdge, VGroup, VNode, ViewModel } from "../graph/views";

// ELK is ~1.3 MB; load it only when a diagram is first shown. It runs in a Web Worker so a big
// diagram (every layer of a system: thousands of boxes) lays out without freezing the page.
let elkPromise: Promise<InstanceType<typeof import("elkjs/lib/elk-api.js").default>> | undefined;
function loadElk() {
  elkPromise ??= Promise.all([import("elkjs/lib/elk-api.js"), import("elkjs/lib/elk-worker.min.js?url")])
    .then(([api, worker]) => new api.default({ workerUrl: worker.default }));
  return elkPromise;
}

type AtlasNodeData = Record<string, unknown> & VNode & {
  horizontal: boolean; dimmed: boolean; selected: boolean;
  /** On a path through the focused box (second-level focus). */
  related?: boolean;
  /** Set when the box can be entered: its "Inside" button calls this. */
  onEnter?: () => void;
};

const SHAPE_ICON: Partial<Record<Shape, string>> = {
  service: "◼", module: "▣", database: "⛁", table: "▦", topic: "⇶", queue: "⇶", external: "◎", ingress: "⇥",
  package: "▤", endpoint: "⇢", function: "ƒ", container: "▢", deployment: "☸", store: "⛁", entity: "◻",
  start: "●", end: "◉", throw: "⊗", decision: "◇", variable: "𝑥",
};

// Node size is fixed up front so ELK's edge routes meet the rendered boxes exactly.
function size(n: VNode): { width: number; height: number } {
  const rows = n.sections?.flat() ?? [];
  const longest = Math.max(n.label.length * 8.2, (n.sub?.length ?? 0) * 6.6, ...rows.map((r) => (r.text.length + 3) * 6.9));
  const width = Math.min(Math.max(longest + 40, n.shape === "function" ? 150 : 170), 380);
  if (n.sections) {
    const height = 46 + (n.stereotype ? 14 : 0) + (n.sub ? 14 : 0) + rows.length * 18 + n.sections.length * 9;
    return { width, height };
  }
  if (n.shape === "decision") return { width: Math.max(width, 190), height: n.sub ? 58 : 46 };
  return { width, height: n.sub ? 54 : 38 };
}

function labelSize(e: VEdge) {
  if (!e.label) return undefined;
  const chars = Math.max(e.label.length, e.sublabel?.length ?? 0);
  return { width: Math.min(chars * 6.3 + 14, 260), height: e.sublabel ? 32 : 18 };
}

const AtlasNode = memo(function AtlasNode({ data }: NodeProps<Node<AtlasNodeData>>) {
  const target = data.horizontal ? Position.Left : Position.Top;
  const source = data.horizontal ? Position.Right : Position.Bottom;
  const cls = ["atlas-node", `shape-${data.shape}`, data.faded && "faded", data.dimmed && "dimmed", data.selected && "selected", data.related && "related",
    data.collapsed && "collapsed", data.enterable && "enterable"]
    .filter(Boolean).join(" ");
  return (
    <div className={cls}>
      <Handle type="target" position={target} />
      {(data.label || data.sub || data.stereotype) && (
        <div className="atlas-head">
          {data.stereotype && <div className="atlas-stereo">«{data.stereotype}»</div>}
          {data.label && (
            <div className="atlas-title" title={data.label}>
              <span className="atlas-icon" aria-hidden>{data.collapsed ? "▸" : SHAPE_ICON[data.shape]}</span>
              {data.label}
            </div>
          )}
          {data.sub && <div className="atlas-sub" title={data.sub}>{data.sub}</div>}
        </div>
      )}
      {data.sections?.map((rows, i) => (
        <div className="atlas-section" key={i}>
          {rows.map((r, j) => (
            <div className={r.muted ? "atlas-row muted" : "atlas-row"} key={j} title={r.text}>
              {r.marker !== undefined && <span className="atlas-marker">{r.marker}</span>}
              <span>{r.text}</span>
            </div>
          ))}
        </div>
      ))}
      {data.onEnter && (
        <button type="button" className="atlas-enter nodrag nopan" title="Go inside this function"
          onClick={(e) => { e.stopPropagation(); data.onEnter!(); }}>
          ▸ Inside
        </button>
      )}
      <Handle type="source" position={source} />
    </div>
  );
});

// ------------------------------------------------------------------- edges

type AtlasEdgeData = Record<string, unknown> & {
  points?: Point[];
  labelBox?: Point;
  label?: string;
  sublabel?: string;
  labelClass: string;
  onLabelClick?: () => void;
};

/** Polyline through the route points with small rounded corners. */
function roundedPath(pts: Point[], r = 8): string {
  if (pts.length < 2) return "";
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [p, c, n] = [pts[i - 1], pts[i], pts[i + 1]];
    const d1 = Math.hypot(c.x - p.x, c.y - p.y);
    const d2 = Math.hypot(n.x - c.x, n.y - c.y);
    const k = Math.min(r, d1 / 2, d2 / 2);
    const a = { x: c.x - ((c.x - p.x) / d1) * k, y: c.y - ((c.y - p.y) / d1) * k };
    const b = { x: c.x + ((n.x - c.x) / d2) * k, y: c.y + ((n.y - c.y) / d2) * k };
    d += ` L ${a.x} ${a.y} Q ${c.x} ${c.y} ${b.x} ${b.y}`;
  }
  const last = pts[pts.length - 1];
  return `${d} L ${last.x} ${last.y}`;
}

function midpoint(pts: Point[]): Point {
  // middle of the longest segment: where a label is least likely to overlap a bend
  let best = { len: -1, at: pts[0] };
  for (let i = 1; i < pts.length; i++) {
    const len = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    if (len > best.len) best = { len, at: { x: (pts[i].x + pts[i - 1].x) / 2, y: (pts[i].y + pts[i - 1].y) / 2 } };
  }
  return best.at;
}

function AtlasEdge({ id, data, markerEnd, markerStart, style, sourceX, sourceY, targetX, targetY }: EdgeProps<Edge<AtlasEdgeData>>) {
  const pts = data?.points?.length ? data.points : [{ x: sourceX, y: sourceY }, { x: targetX, y: targetY }];
  const box = data?.labelBox;
  const mid = midpoint(pts);
  return (
    <>
      <BaseEdge id={id} path={roundedPath(pts)} markerEnd={markerEnd} markerStart={markerStart} style={style} interactionWidth={14} />
      {data?.label && (
        <EdgeLabelRenderer>
          <div
            className={`atlas-edge-label nodrag nopan ${data.labelClass}`}
            data-id={id}
            style={{ transform: box ? `translate(${box.x}px, ${box.y}px)` : `translate(-50%, -50%) translate(${mid.x}px, ${mid.y}px)` }}
            onClick={data.onLabelClick}
          >
            <div>{data.label}</div>
            {data.sublabel && <div className="atlas-edge-sub">{data.sublabel}</div>}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

// ------------------------------------------------------------------ groups

type GroupBoxData = Record<string, unknown> & {
  group: VGroup & { size: number };
  focused: boolean;
  dimmed: boolean;
  onCollapse: () => void;
  onFocus: () => void;
  /** Present when the viewer may rename groups; an empty label undoes a rename. */
  onRename?: (label: string) => void;
};

/** Says what kind of thing a box stands for where its border alone does not. */
const GROUP_BADGE: Partial<Record<VGroup["kind"], string>> = { class: "class", function: "ƒ", scope: "declared outside" };

const GroupBox = memo(function GroupBox({ data }: NodeProps<Node<GroupBoxData>>) {
  const g = data.group;
  const [editing, setEditing] = useState(false);
  return (
    <div className={`group-box group-${g.kind}${data.focused ? " focused" : ""}${data.dimmed ? " dimmed" : ""}`}>
      <div className="group-head">
        {editing ? (
          <input className="group-rename nodrag" autoFocus defaultValue={g.label} aria-label="Group name"
            onClick={(e) => e.stopPropagation()}
            onBlur={() => setEditing(false)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setEditing(false);
              if (e.key === "Enter") {
                data.onRename?.((e.target as HTMLInputElement).value.trim());
                setEditing(false);
              }
            }} />
        ) : (
          <span className="group-title" title={g.label}>
            {GROUP_BADGE[g.kind] && <span className="group-badge">{GROUP_BADGE[g.kind]}</span>}
            {g.label}
          </span>
        )}
        <span className="group-count">{g.sub ? `${g.sub} · ` : ""}{g.size}</span>
        {data.onRename && !editing && (
          <button className="group-btn nodrag" title="Rename (give two groups the same name to merge them)"
            onClick={(e) => { e.stopPropagation(); setEditing(true); }}>✎</button>
        )}
        <button className="group-btn nodrag" title="Focus: dim everything else" onClick={(e) => { e.stopPropagation(); data.onFocus(); }}>◎</button>
        <button className="group-btn nodrag" title="Collapse into one box" onClick={(e) => { e.stopPropagation(); data.onCollapse(); }}>−</button>
      </div>
    </div>
  );
});

const nodeTypes = { atlas: AtlasNode, groupBox: GroupBox };
const edgeTypes = { atlas: AtlasEdge };

const SHAPE_COLOR_VAR: Partial<Record<Shape, string>> = {
  service: "--c-service", module: "--c-module", database: "--c-database", table: "--c-database", topic: "--c-topic",
  queue: "--c-topic", external: "--c-external", ingress: "--c-external", package: "--c-package", class: "--c-package",
  endpoint: "--c-endpoint", function: "--c-function", container: "--c-infra", deployment: "--c-infra",
  process: "--c-service", store: "--c-database", entity: "--c-external",
};

function minimapColor(n: Node): string {
  if (n.type === "groupBox") return "transparent";
  const v = SHAPE_COLOR_VAR[(n.data as AtlasNodeData).shape];
  return v ? getComputedStyle(document.documentElement).getPropertyValue(v).trim() || "#888" : "#888";
}

const MARKER: Partial<Record<EdgeStyle, string>> = { extends: "uml-triangle", implements: "uml-triangle" };

/** A layout of one diagram; `diagram` changes when the diagram itself does (not when boxes fold). */
type CanvasLayout = Layout & { id: number; diagram: number; grouped: GroupedView; overlay: Set<string> };

/** How long boxes take to move to their new places when boxes fold or open. */
const MOVE_MS = 450;
/** Boxes sit above every group box (group boxes stack by nesting depth below this). */
const LEAF_Z = 1000;

/** Boxes of the old layout leaving: drawn as they were, moving into the box now holding them. */
function ghostsOf(plan: Transition, was: Map<string, Node>, phase: "from" | "to"): Node[] {
  return plan.ghosts.flatMap((g) => {
    const old = was.get(g.id);
    if (!old) return [];
    const r = phase === "from" ? g.from : g.to;
    return [{
      ...old, id: `ghost:${g.id}`, position: { x: r.x, y: r.y }, selectable: false, zIndex: LEAF_Z + 1,
      style: { ...(old.style ?? {}), ...(old.type === "groupBox" ? { width: r.width, height: r.height } : {}),
        opacity: phase === "from" ? 1 : 0, pointerEvents: "none" as const },
    }];
  });
}

/** A string inside a CSS attribute selector: [data-id="..."]. */
function cssString(s: string) {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\a ");
}

/** What the shapes and lines mean, a click away. */
function Legend({ compact }: { compact: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="legend">
      <button className="secondary legend-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)} title="What the shapes and lines mean">
        {open ? "Hide key" : "Key"}
      </button>
      {open && (
        <div className="legend-panel" role="note">
          <div className="legend-title">Lines</div>
          <div className="legend-row"><svg width="34" height="10" aria-hidden><line className="lg-call" x1="0" y1="5" x2="34" y2="5" /></svg>runs next / calls</div>
          <div className="legend-row"><svg width="34" height="10" aria-hidden><line className="lg-back" x1="0" y1="5" x2="34" y2="5" /></svg>loops back</div>
          <div className="legend-row"><svg width="34" height="10" aria-hidden><line className="lg-data" x1="0" y1="5" x2="34" y2="5" /></svg>reads / writes data</div>
          <div className="legend-row"><svg width="34" height="10" aria-hidden><line className="lg-msg" x1="0" y1="5" x2="34" y2="5" /></svg>publishes / consumes</div>
          <div className="legend-row"><svg width="34" height="10" aria-hidden><line className="lg-http" x1="0" y1="5" x2="34" y2="5" /></svg>HTTP call</div>
          <div className="legend-row"><svg width="34" height="10" aria-hidden><line className="lg-var" x1="0" y1="5" x2="34" y2="5" /></svg>reads / changes a variable</div>
          {compact && <div className="legend-note">Lines between boxes stay faint; hover or select a box to light up its own.</div>}
          <div className="legend-title">Boxes</div>
          <div className="legend-row"><span className="lg-mark">●</span>start of a function <span className="lg-mark">◉</span>end</div>
          <div className="legend-row"><span className="lg-mark">◇</span>decision or loop</div>
          <div className="legend-row"><span className="lg-mark">𝑥</span>state declared outside the function</div>
          <div className="legend-row"><span className="lg-mark">▸</span>folded box: click to open</div>
          <div className="legend-title">Focus</div>
          <div className="legend-row"><span className="lg-focus" />the box you clicked</div>
          <div className="legend-row"><span className="lg-related" />on a path through it: leads there or follows</div>
          <div className="legend-row"><span className="lg-dim" />not connected to it</div>
          <div className="legend-title">Keys</div>
          <div className="legend-row"><kbd>[</kbd> <kbd>]</kbd> less / more detail · <kbd>f</kbd> fit · <kbd>Esc</kbd> back</div>
        </div>
      )}
    </div>
  );
}

/** The viewport showing every box with a margin (React Flow's fitView needs measured boxes). */
function fitTo(rects: Map<string, Rect>, width: number, height: number) {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const r of rects.values()) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.width);
    y1 = Math.max(y1, r.y + r.height);
  }
  if (!Number.isFinite(x0)) return { x: 0, y: 0, zoom: 1 };
  const zoom = Math.min(Math.max(Math.min(width / ((x1 - x0) * 1.1), height / ((y1 - y0) * 1.1)), 0.005), 1.2);
  return { x: (width - (x1 - x0) * zoom) / 2 - x0 * zoom, y: (height - (y1 - y0) * zoom) / 2 - y0 * zoom, zoom };
}

interface Props {
  view: ViewModel;
  selected?: string;
  /** Click on a box: its graph node (ref) and the box itself (for refs / enterable). */
  onSelect: (ref: string | undefined, node?: VNode) => void;
  /** Edges with details (data flows) are selectable. */
  selectedEdge?: string;
  onSelectEdge?: (id: string | undefined) => void;
  /** Lets the viewer rename groups (admins). */
  onRenameGroup?: (groupId: string, label: string) => void;
  /** The clicked box gets an "Inside" button when it has an inside (canEnter); pressing it calls onEnter. */
  onEnter?: (node: VNode) => void;
  canEnter?: (node: VNode) => boolean;
  /** Detail level: fold every box this many levels deep (see detailLevels); unset = fit the budget. */
  level?: number;
}

export default function GraphCanvas({ view, selected, onSelect, selectedEdge, onSelectEdge, onRenameGroup, onEnter, canEnter, level }: Props) {
  // the box last clicked: the only one showing an "Inside" button
  const [clicked, setClicked] = useState<{ view: ViewModel; id: string }>();
  const clickedId = clicked?.view === view ? clicked.id : undefined;
  const [layout, setLayout] = useState<CanvasLayout>();
  const layoutRef = useRef<CanvasLayout>();
  // Folding or opening boxes animates: every box starts where it was ("from"), then moves ("to").
  const [anim, setAnim] = useState<{ phase: "from" | "to"; plan: Transition; layoutId: number }>();
  const flow = useRef<ReactFlowInstance<Node, Edge<AtlasEdgeData>>>();
  /** The group a click just folded or opened: it stays put on screen while the rest moves. */
  const anchor = useRef<string>();
  const [error, setError] = useState("");
  // Left-to-right diagrams are laid out top-down when the canvas is portrait (narrow panes, phones).
  const container = useRef<HTMLDivElement>(null);
  const [portrait, setPortrait] = useState<boolean>();
  const hasNodes = view.nodes.length > 0; // the container only exists for non-empty views
  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const measure = () => setPortrait(el.clientWidth < el.clientHeight * 0.9);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasNodes]);
  const direction = view.direction === "RIGHT" && portrait ? "DOWN" : view.direction;
  const horizontal = direction === "RIGHT";

  // Collapse state is per diagram: a new diagram starts from its default expansion, while the same
  // diagram re-made (renamed group, choices fanned out next to a box) keeps what was opened.
  // A detail level folds every box that deep; otherwise boxes fold to fit the view's budget.
  const initial = useMemo(() => (level !== undefined ? collapsedAtLevel(view, level) : defaultCollapsed(view, view.budget)),
    [view, level]);
  const structure = useMemo(() => [`level:${level ?? ""}`, ...(view.groups ?? []).map((g) => g.id), "|",
    ...view.nodes.filter((n) => !n.id.startsWith("pick:")).map((n) => n.id)].join("\n"), [view, level]);
  const [override, setOverride] = useState<{ structure: string; collapsed: Set<string> }>();
  const collapsed = override?.structure === structure ? override.collapsed : initial;
  const setCollapsed = (next: Set<string>) => setOverride({ structure, collapsed: next });
  const toggle = (g: string) => {
    anchor.current = g;
    const next = new Set(collapsed);
    if (next.has(g)) next.delete(g);
    else next.add(g);
    setCollapsed(next);
  };
  const [focus, setFocus] = useState<{ view: ViewModel; group: string }>();
  // memoized group boxes call the latest handler (it closes over the current edits)
  const renameRef = useRef(onRenameGroup);
  renameRef.current = onRenameGroup;
  const canRename = !!onRenameGroup;
  const focusGroup = focus?.view === view ? focus.group : undefined;

  const grouped: GroupedView = useMemo(() => applyGroups(view, collapsed), [view, collapsed]);
  // the same diagram (same groups and boxes) keeps its viewport and animates; a new one refits
  const shape = structure.slice(structure.indexOf("\n") + 1);
  const diagramSeq = useRef(0);
  const diagram = useMemo(() => ++diagramSeq.current, [shape]); // eslint-disable-line react-hooks/exhaustive-deps
  const allGroupIds = useMemo(() => (view.groups ?? []).map((g) => g.id), [view]);

  // Layout (node positions, group boxes and edge routes) whenever what's visible changes.
  useEffect(() => {
    if (portrait === undefined) return; // wait for the first measurement
    let live = true;
    setError("");
    const el = container.current;
    const plan = elkGraph(grouped, direction, size, labelSize, undefined, el && el.clientHeight ? el.clientWidth / el.clientHeight : 1.6);
    loadElk()
      .then((elk) => elk.layout(plan.graph))
      .then((res) => {
        if (!live) return;
        const prev = layoutRef.current;
        const next: CanvasLayout = {
          ...readLayout(res, plan.overlay), id: (prev?.id ?? 0) + 1, diagram, grouped, overlay: new Set(plan.overlay.map((e) => e.id)),
        };
        layoutRef.current = next;
        // same diagram, boxes folded or opened: animate from the old places to the new ones
        setAnim(prev && prev.diagram === diagram
          ? { phase: "from", plan: planTransition(view, prev.rects, next.rects), layoutId: next.id } : undefined);
        setLayout(next);
      })
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [grouped, direction, portrait]); // eslint-disable-line react-hooks/exhaustive-deps

  // "from" is painted first, then "to" on the next frame so CSS transitions run between them
  useEffect(() => {
    if (anim?.phase !== "from") return;
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setAnim((a) => (a && a.layoutId === anim.layoutId ? { ...a, phase: "to" } : a)));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [anim]);
  useEffect(() => {
    if (anim?.phase !== "to" || !layout) return;
    const rf = flow.current;
    const a = anchor.current;
    anchor.current = undefined;
    const before = a ? anim.plan.from.get(`c:${a}`) ?? anim.plan.from.get(GROUP_NODE + a) : undefined;
    const after = a ? layout.rects.get(`c:${a}`) ?? layout.rects.get(GROUP_NODE + a) : undefined;
    if (rf && before && after) {
      // keep the box that was clicked where it was on screen
      const vp = rf.getViewport();
      void rf.setViewport({ x: vp.x - (after.x - before.x) * vp.zoom, y: vp.y - (after.y - before.y) * vp.zoom, zoom: vp.zoom },
        { duration: MOVE_MS });
    } else if (rf && container.current) {
      void rf.setViewport(fitTo(layout.rects, container.current.clientWidth, container.current.clientHeight), { duration: MOVE_MS });
    }
    // a little past the CSS transition, so it is never cut short
    const t = setTimeout(() => setAnim((x) => (x && x.layoutId === anim.layoutId ? undefined : x)), MOVE_MS + 250);
    return () => clearTimeout(t);
  }, [anim, layout]);

  // Hovering a box lights up its lines (the faint ones between tiles included). Done with one
  // small stylesheet so thousands of edges are not re-rendered on every mouse move.
  const [hovered, setHovered] = useState<string>();
  const edgesOf = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const e of (layout?.grouped ?? grouped).edges) {
      m.set(e.source, [...(m.get(e.source) ?? []), e.id]);
      m.set(e.target, [...(m.get(e.target) ?? []), e.id]);
    }
    return m;
  }, [layout, grouped]);
  // the hovered box, else the box last clicked: its lines stay lit while you read the details
  const lit = hovered ?? clickedId;
  const litCss = useMemo(() => {
    const ids = lit ? edgesOf.get(lit) ?? [] : [];
    if (!ids.length) return "";
    const sel = (prefix: string, suffix = "") => ids.map((id) => `${prefix}[data-id="${cssString(id)}"]${suffix}`).join(",");
    return `${sel(".react-flow__edge")}{opacity:1!important;visibility:visible!important}
${sel(".react-flow__edge", " .react-flow__edge-path")}{stroke:var(--accent)!important;stroke-width:2.5px;vector-effect:non-scaling-stroke;opacity:1!important}
${sel(".atlas-edge-label")}{visibility:visible!important;opacity:1!important}`;
  }, [lit, edgesOf]);

  // Zoom decides how much is written: far out only box names (large, like places on a map),
  // closer in the steps and labels. Classes go straight on the element: no re-render on zoom.
  const [zoomBand, setZoomBand] = useState(1);
  const onZoom = (vp: Viewport) => {
    const el = container.current;
    if (!el) return;
    el.classList.toggle("zoom-far", vp.zoom < 0.3);
    el.classList.toggle("zoom-mid", vp.zoom >= 0.3 && vp.zoom < 0.6);
    // map labels re-render only when the zoom moves by ~20%
    const band = Math.round(Math.log(vp.zoom) / Math.log(1.2));
    setZoomBand((b) => (b === band ? b : band));
  };
  const zoom = Math.pow(1.2, zoomBand);

  // What is drawn is the grouping the current layout was made for: until the next layout is
  // ready the old one stays on screen (instead of new boxes piled up at stale positions).
  const drawn = layout?.grouped ?? grouped;

  // Focus: the clicked box (or the box of whatever is selected, e.g. from a link in the
  // details panel), everything on a path through it, and the lines along those paths.
  const focused = useMemo(() => {
    if (!selected && !clickedId) return undefined;
    const clicked = clickedId ? drawn.nodes.find((n) => n.id === clickedId) : undefined;
    if (clicked && (!selected || clicked.id === selected || clicked.ref === selected)) return clicked.id;
    return drawn.nodes.find((n) => n.id === selected)?.id ?? drawn.nodes.find((n) => n.ref === selected)?.id;
  }, [selected, clickedId, drawn]);
  const paths = useMemo(() => (focused ? focusOn(focused, drawn.edges) : undefined), [focused, drawn]);
  /** Group boxes holding the focus or something on its paths: they stay lit. */
  const litGroups = useMemo(() => {
    if (!paths) return undefined;
    const parents = new Map(drawn.containers.map((c) => [c.id, c.parent]));
    const groupOf = new Map(drawn.nodes.map((n) => [n.id, n.group]));
    const out = new Set<string>();
    for (const id of [paths.focus, ...paths.related]) {
      for (let g = groupOf.get(id), guard = 0; g && guard < 60 && !out.has(g); g = parents.get(g), guard++) out.add(g);
    }
    return out;
  }, [paths, drawn]);

  // "Focus group": everything outside the group (and its sub-groups) is dimmed.
  const inFocus = useMemo(() => {
    if (!focusGroup) return undefined;
    const parents = new Map(drawn.containers.map((c) => [c.id, c.parent]));
    const within = (g?: string) => {
      for (let x = g, guard = 0; x && guard < 50; x = parents.get(x), guard++) if (x === focusGroup) return true;
      return false;
    };
    return { within, node: (n: VNode) => within(n.group) || drawn.collapsedNodes.get(n.id) === focusGroup };
  }, [focusGroup, drawn]);

  // Every box is placed absolutely (not inside a parent node), at its final place. Moving boxes
  // between layouts then only changes positions; nesting comes from z-order (deeper on top).
  const settled = useMemo<Node[]>(() => {
    if (!layout) return [];
    const parents = new Map(drawn.containers.map((c) => [c.id, c.parent]));
    const depthOf = (id: string | undefined) => {
      let d = 0;
      for (let p = id; p && d < 60; p = parents.get(p)) d++;
      return d;
    };
    const rect = (id: string) => layout.rects.get(id) ?? { x: 0, y: 0, width: 0, height: 0 };
    const boxes: Node<GroupBoxData>[] = drawn.containers.map((c) => {
      const r = rect(`c:${c.id}`);
      return {
        id: `c:${c.id}`,
        type: "groupBox",
        position: { x: r.x, y: r.y },
        zIndex: depthOf(c.id),
        style: { width: r.width, height: r.height },
        selectable: false,
        data: {
          group: c,
          focused: c.id === focusGroup,
          dimmed: (!!inFocus && !inFocus.within(c.id)) || (!!litGroups && !litGroups.has(c.id)),
          onCollapse: () => toggle(c.id),
          onRename: canRename ? (label: string) => renameRef.current?.(c.id, label) : undefined,
          onFocus: () => setFocus(focusGroup === c.id ? undefined : { view, group: c.id }),
        },
      };
    });
    const leaves: Node<AtlasNodeData>[] = drawn.nodes.map((n) => {
      const r = rect(n.id);
      return {
        id: n.id,
        type: "atlas",
        position: { x: r.x, y: r.y },
        zIndex: LEAF_Z,
        data: {
          ...n,
          horizontal,
          selected: n.id === focused,
          related: !!paths?.related.has(n.id),
          dimmed: (!!paths && n.id !== focused && !paths.related.has(n.id)) || (!!inFocus && !inFocus.node(n)),
          onEnter: onEnter && n.id === clickedId && (canEnter ? canEnter(n) : n.enterable) ? () => onEnter(n) : undefined,
        },
        style: size(n),
      };
    });
    return [...boxes, ...leaves];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawn, layout, horizontal, focused, paths, litGroups, inFocus, focusGroup, canRename, onEnter, canEnter, clickedId]);

  // the boxes of the last settled layout: what disappearing boxes look like while they leave
  const lastSettled = useRef(new Map<string, Node>());
  useEffect(() => {
    if (!anim) lastSettled.current = new Map(settled.map((n) => [n.id, n]));
  }, [anim, settled]);

  const nodes = useMemo<Node[]>(() => {
    if (!anim || !layout) return settled;
    if (anim.phase === "to") {
      // final places (same as settled) while the leaving boxes shrink into their new holder
      return [...settled, ...ghostsOf(anim.plan, lastSettled.current, "to")];
    }
    const moved = settled.map((n) => {
      const start = anim.plan.from.get(n.id);
      if (!start) return { ...n, style: { ...(n.style ?? {}), opacity: 0 } }; // fades in where it ends
      return {
        ...n, position: { x: start.x, y: start.y },
        style: n.type === "groupBox" ? { ...(n.style ?? {}), width: start.width, height: start.height } : n.style,
      };
    });
    return [...moved, ...ghostsOf(anim.plan, lastSettled.current, "from")];
  }, [anim, layout, settled]);

  // Names of boxes big enough on screen to matter, drawn above everything at a readable size
  // whatever the zoom: services and packages larger than classes and functions.
  const mapLabels = useMemo(() => {
    // only the packed All view: other diagrams are small enough for their own titles
    if (!layout || zoom >= 0.6 || view.layout !== "compact") return [];
    const parents = new Map(drawn.containers.map((c) => [c.id, c.parent]));
    const out: { id: string; x: number; y: number; width: number; text: string; kind: string; size: number; depth: number }[] = [];
    for (const c of drawn.containers) {
      const r = layout.rects.get(`c:${c.id}`);
      if (!r || r.width * zoom < 70) continue; // too small on screen to carry a name
      let depth = 0;
      for (let p = c.parent; p && depth < 60; p = parents.get(p)) depth++;
      const px = Math.max(11, 17 - depth * 2); // on-screen size: outer boxes larger
      out.push({ id: c.id, x: r.x, y: r.y, width: r.width, text: c.label, kind: c.kind, size: px / zoom, depth });
    }
    // outer boxes first; a label that would cover one already placed is left out (its box's
    // own title shows once zoomed in enough)
    const placed: { x0: number; y0: number; x1: number; y1: number }[] = [];
    return out.sort((a, b) => a.depth - b.depth).filter((l) => {
      const em = l.size;
      const box = { x0: l.x, y0: l.y, x1: l.x + Math.min(l.width, (l.text.length * 0.62 + 1.4) * em), y1: l.y + 1.9 * em };
      if (placed.some((p) => box.x0 < p.x1 && box.x1 > p.x0 && box.y0 < p.y1 && box.y1 > p.y0)) return false;
      placed.push(box);
      return true;
    });
  }, [layout, drawn, zoom, view.layout]);

  const edges = useMemo<Edge<AtlasEdgeData>[]>(() => {
    if (!layout) return [];
    const visible = inFocus ? new Set(drawn.nodes.filter((n) => inFocus.node(n)).map((n) => n.id)) : undefined;
    return drawn.edges.map((e) => {
      const dimmed = (!!paths && !paths.edges.has(e.id))
        || (!!visible && !(visible.has(e.source) || visible.has(e.target)));
      const state = [dimmed && "dimmed", paths?.edges.has(e.id) && "on-path", e.id === selectedEdge && "selected", e.conditional && "conditional",
        e.sensitivity && `sens-${e.sensitivity}`, e.info && "clickable"].filter(Boolean).join(" ");
      const route = layout.routes.get(e.id);
      return {
        id: e.id,
        type: "atlas",
        source: e.source,
        target: e.target,
        zIndex: LEAF_Z - 1, // above group boxes, below the boxes they connect
        className: `atlas-edge edge-${e.style} ${state}${layout.overlay.has(e.id) ? " overlay" : ""}`,
        markerEnd: MARKER[e.style] ?? { type: MarkerType.ArrowClosed, width: 16, height: 16 },
        markerStart: e.both ? { type: MarkerType.ArrowClosed, width: 16, height: 16, orient: "auto-start-reverse" } : undefined,
        animated: e.style === "publish" || e.style === "consume",
        style: e.count > 1 && e.style !== "data" ? { strokeWidth: Math.min(1.2 + Math.log2(e.count), 4) } : undefined,
        data: {
          points: route?.points,
          labelBox: route?.labelBox,
          label: e.label,
          sublabel: e.sublabel,
          labelClass: `edge-${e.style} ${state}${layout.overlay.has(e.id) ? " overlay" : ""}`,
          onLabelClick: e.info && onSelectEdge ? () => onSelectEdge(e.id) : undefined,
        },
      };
    });
  }, [drawn, layout, paths, selectedEdge, onSelectEdge, inFocus]);

  if (error) return <p className="error">Layout failed: {error}</p>;
  if (!view.nodes.length) return <div className="canvas-empty muted">{view.empty ?? "Nothing to show."}</div>;

  const hasGroups = grouped.containers.length > 0 || grouped.collapsedNodes.size > 0;
  return (
    <div className={`canvas${anim ? " atlas-animating" : ""}${view.layout === "compact" ? " compact" : ""}`} ref={container}
      tabIndex={-1}
      onKeyDown={(e) => {
        const t = e.target as HTMLElement;
        if (t.closest?.("input, textarea, select")) return;
        if (e.key === "f" && layout && flow.current && container.current) {
          void flow.current.setViewport(fitTo(layout.rects, container.current.clientWidth, container.current.clientHeight), { duration: 300 });
        }
      }}>
      {litCss && <style>{litCss}</style>}
      <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden>
        <defs>
          <marker id="uml-triangle" viewBox="0 0 12 12" refX="11" refY="6" markerWidth="14" markerHeight="14" orient="auto-start-reverse">
            <path d="M1,1 L11,6 L1,11 z" className="uml-triangle" />
          </marker>
        </defs>
      </svg>
      {hasGroups && (
        <div className="group-tools">
          <button className="secondary" onClick={() => setCollapsed(new Set())}>Expand all</button>
          <button className="secondary" onClick={() => setCollapsed(new Set(allGroupIds))}>Collapse all</button>
          {focusGroup && <button className="secondary" onClick={() => setFocus(undefined)}>Clear focus</button>}
        </div>
      )}
      <Legend compact={view.layout === "compact"} />
      {!layout && <div className="canvas-loading muted">Laying out {grouped.nodes.length} nodes…</div>}
      {layout && layout.grouped !== grouped && <div className="canvas-pending muted small" role="status">Arranging…</div>}
      {paths && layout?.grouped === grouped && (
        <div className="focus-banner" role="status">
          <span className="focus-dot" aria-hidden />
          <strong title={drawn.nodes.find((n) => n.id === paths.focus)?.label}>{drawn.nodes.find((n) => n.id === paths.focus)?.label || "box"}</strong>
          <span className="muted">
            {paths.related.size ? ` · ${paths.upstream.size} lead here, ${paths.downstream.size} follow` : " · nothing connected"}
          </span>
          <button className="link small" onClick={() => {
            setClicked(undefined);
            onSelect(undefined);
          }}>Clear</button>
        </div>
      )}
      {layout && (
        // Remounted per diagram so React Flow's own fitView runs after nodes are measured; folding
        // boxes in the same diagram keeps the viewport and animates instead.
        <ReactFlowProvider key={layout.diagram}>
          <ReactFlow
            onInit={(rf) => {
              flow.current = rf;
              onZoom(rf.getViewport());
            }}
            onMove={(_, vp) => onZoom(vp)}
            onNodeMouseEnter={(_, n) => setHovered(n.type === "groupBox" ? undefined : n.id)}
            onNodeMouseLeave={() => setHovered(undefined)}
            fitView
            fitViewOptions={{ padding: 0.1, maxZoom: 1.2, minZoom: 0.005 }}
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            colorMode="system"
            // a whole system with every layer open is tens of thousands of pixels wide
            minZoom={nodes.length > 300 ? 0.005 : 0.1}
            maxZoom={2}
            nodesConnectable={false}
            nodesDraggable={false}
            onNodeClick={(_, n) => {
              if (n.type === "groupBox" || n.id.startsWith("ghost:")) return;
              const g = drawn.collapsedNodes.get(n.id);
              if (g) toggle(g);
              else {
                setClicked({ view, id: n.id });
                onSelect((n.data as AtlasNodeData).ref ?? n.id, n.data as AtlasNodeData);
              }
            }}
            onEdgeClick={(_, edge) => {
              if (onSelectEdge && drawn.edges.find((x) => x.id === edge.id)?.info) onSelectEdge(edge.id);
            }}
            onPaneClick={() => {
              setClicked(undefined);
              onSelect(undefined);
              onSelectEdge?.(undefined);
            }}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={24} size={1} />
            {mapLabels.length > 0 && (
              <ViewportPortal>
                {mapLabels.map((l) => (
                  <div key={l.id} className={`map-label map-${l.kind}`} aria-hidden
                    style={{ transform: `translate(${l.x}px, ${l.y}px)`, maxWidth: l.width, fontSize: l.size }}>
                    {l.text}
                  </div>
                ))}
              </ViewportPortal>
            )}
            <Controls showInteractive={false} />
            {grouped.nodes.length > 20 && (
              <MiniMap pannable zoomable className="atlas-minimap" nodeColor={minimapColor} nodeStrokeWidth={0}
                style={{ width: 150, height: 100 }} />
            )}
          </ReactFlow>
        </ReactFlowProvider>
      )}
    </div>
  );
}
