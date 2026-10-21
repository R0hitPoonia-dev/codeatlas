// Builds diagram view models from the merged repo graph. Each view picks a level of
// abstraction and aggregates fine-grained edges (method calls, table reads, ...) up to it.
import type { GraphEdge, GraphNode, SourceLocation } from "../api";
import type { ClassHits, TypeInfo } from "./dataclass";
import { doesRow, edgeTypes, effectsOf, effectText, firstSentence, functionTitle, typeText, withReading, type Outline } from "./reading";
import { Model, locationText } from "./model";
import { packageRole, ROLE_INFO, systemGroup, typeRole } from "./roles";

export type Shape =
  | "service" | "module" | "database" | "topic" | "queue" | "external" | "ingress"
  | "package" | "class" | "table" | "endpoint" | "function" | "container" | "deployment"
  // data flow diagram notation
  | "process" | "store" | "entity"
  // activity diagram notation
  | "start" | "end" | "throw" | "decision" | "action"
  // a variable declared outside the function that uses it
  | "variable";

export type EdgeStyle =
  | "call" | "http" | "data" | "publish" | "consume" | "depends"
  | "extends" | "implements" | "association" | "fk" | "deploy" | "connect" | "handles"
  | "back" | "error"
  // variable reads (variable -> step) and writes (step -> variable)
  | "uses" | "sets";

export interface Row {
  text: string;
  marker?: string;
  muted?: boolean;
}

export interface VNode {
  id: string;
  /** Innermost group this node belongs to (see ViewModel.groups). */
  group?: string;
  /** A collapsed group standing in for its members. */
  collapsed?: boolean;
  /** Functions this box runs or calls, for "step into" navigation (Flow tab). */
  refs?: { id: string; label: string }[];
  /** Data stores / topics / remote services this step reads, writes, publishes to or calls. */
  touches?: { target: string; kind: string }[];
  /** Clicking goes inside (the function has a body to show). */
  enterable?: boolean;
  /** Source lines of the step(s) this box stands for (activity diagrams). */
  lines?: number[];
  /** Graph node to show in the details panel. */
  ref?: string;
  label: string;
  sub?: string;
  shape: Shape;
  faded?: boolean;
  stereotype?: string;
  sections?: Row[][];
}

export interface VEdge {
  id: string;
  source: string;
  target: string;
  style: EdgeStyle;
  label?: string;
  /** Second label line (data flow: sensitive categories carried). */
  sublabel?: string;
  count: number;
  /** Runs only under some condition (if/loop/catch...). */
  conditional?: boolean;
  /** Most sensitive data category carried (data flow view). */
  sensitivity?: "high" | "medium" | "low";
  /** Details shown when the edge is clicked. */
  info?: FlowInfo;
  /** Data moves both ways (a store read and written): drawn with an arrowhead at each end. */
  both?: boolean;
  /** The data types the line carries (shown as its label, the verb underneath). */
  types?: string[];
}

/** What a data-flow edge carries and where in the code it comes from. */
export interface FlowInfo {
  title: string;
  types: TypeInfo[];
  classes: ClassHits;
  sources: { node: string; kind: string; location?: SourceLocation; conditions?: string[] }[];
}

/** A collapsible box around related nodes (service, package, role, data system, loop body...). */
export interface VGroup {
  id: string;
  label: string;
  sub?: string;
  parent?: string;
  kind: "service" | "package" | "class" | "role" | "system" | "region" | "database" | "deployment" | "custom" | "lane" | "function"
    // where variables a function uses are declared (its class, file, enclosing function)
    | "scope";
  /** Show even with a single member (it names something the member's box does not). */
  keep?: boolean;
  /** Start folded into one box (many look-alike members, e.g. eight topics of one broker); a click opens it. */
  fold?: boolean;
}

export interface ViewModel {
  nodes: VNode[];
  edges: VEdge[];
  direction: "RIGHT" | "DOWN";
  empty?: string;
  groups?: VGroup[];
  /**
   * "compact": pack boxes tightly (services, packages, classes as tiles) and lay out only the
   * steps inside each function as a flow; lines between boxes are drawn over the packing.
   */
  layout?: "compact";
  /** How many boxes to show before collapsing groups by default (default 36). */
  budget?: number;
  /** The same diagram as an outline: its parts in data order, what goes in and out. */
  outline?: Outline;
}

export const ARCH = new Set(["service", "module", "database", "topic", "queue", "external"]);

/** Collects the groups a view uses; returns ids for VNode.group. */
export class GroupSet {
  private m = new Map<string, VGroup>();

  add(g: VGroup): string {
    if (!this.m.has(g.id)) this.m.set(g.id, g);
    return g.id;
  }

  has(id: string): boolean {
    return this.m.has(id);
  }

  list(): VGroup[] {
    return [...this.m.values()];
  }
}

function roleGroup(gs: GroupSet, scope: string, role: keyof typeof ROLE_INFO, parent?: string) {
  return gs.add({ id: `role:${scope}:${role}`, label: role, sub: ROLE_INFO[role].hint, kind: "role", parent });
}

/** Data-system group (PostgreSQL / Kafka / External systems) for a store-like node. */
export function systemOf(gs: GroupSet, m: Model, n: GraphNode | undefined): string | undefined {
  const sys = n && systemGroup(n, m);
  return sys ? gs.add({ ...sys, kind: "system" }) : undefined;
}
export const TYPES = new Set(["class", "interface", "enum"]);
const CALLABLE = new Set(["method", "function"]);

/** Accumulates aggregated edges keyed by (source, target, style), with the data types they carry. */
export class EdgeSet {
  private m = new Map<string, VEdge & { kinds: Set<string>; carried: Set<string> }>();

  add(source: string, target: string, style: EdgeStyle, kind: string, label?: string, types: string[] = []) {
    const key = `${source}|${target}|${style}`;
    let e = this.m.get(key);
    if (!e) {
      e = { id: key, source, target, style, count: 0, kinds: new Set(), carried: new Set(), label };
      this.m.set(key, e);
    }
    e.count++;
    e.kinds.add(kind);
    types.forEach((t) => e!.carried.add(t));
    return e;
  }

  /**
   * The edges, with a store that is both read and written by the same box drawn as one line
   * from the writer to the store with arrowheads at both ends (two opposite lines would make
   * a cycle the layout has to break at random).
   */
  list(labeler?: (e: VEdge & { kinds: Set<string> }) => string | undefined): VEdge[] {
    const merged = new Map(this.m);
    for (const [key, e] of this.m) {
      if (e.style !== "data" || !merged.has(key)) continue;
      const back = `${e.target}|${e.source}|data`;
      const other = merged.get(back);
      if (!other || back === key) continue;
      const [keep, drop, dropKey] = e.kinds.has("writes") ? [e, other, back] : [other, e, key];
      merged.set(keep === e ? key : back, {
        ...keep, count: keep.count + drop.count, kinds: new Set([...keep.kinds, ...drop.kinds]),
        carried: new Set([...keep.carried, ...drop.carried]), both: true,
      });
      merged.delete(dropKey);
    }
    // a line that carries named data says what (Order, byte[]) with the verb underneath
    return [...merged.values()].map(({ kinds, carried, ...e }) => {
      const verb = labeler ? labeler({ ...e, kinds }) : e.label;
      if (!carried.size) return { ...e, label: verb };
      return { ...e, label: typeText(carried), sublabel: verb, types: [...carried] };
    });
  }
}

/** Data edges point the way data moves: a write from the writer to the store, a read from the store to the reader. */
function dataLabel(kinds: Set<string>) {
  return kinds.has("reads") && kinds.has("writes") ? "reads & writes" : kinds.has("writes") ? "writes" : "read by";
}

export function archShape(n: GraphNode): Shape {
  if (n.kind === "external" && n.attrs?.ingress) return "ingress";
  return n.kind as Shape;
}

export function archSub(m: Model, n: GraphNode): string | undefined {
  switch (n.kind) {
    case "service":
    case "module": {
      let eps = (m.children.get(n.id) ?? []).filter((c) => c.kind === "endpoint").length;
      if (!eps) eps = [...m.reachedBy(n.id)].filter((id) => m.node(id)?.kind === "endpoint").length;
      // a program built from a module that builds others too
      const from = typeof n.attrs?.module === "string" ? m.node(n.attrs.module)?.name : undefined;
      return [n.language, from ? `from ${from}` : undefined, eps ? `${eps} endpoint${eps > 1 ? "s" : ""}` : undefined]
        .filter(Boolean).join(" · ") || n.kind;
    }
    case "database":
      return n.otel?.["db.system"] && n.otel["db.system"] !== "unknown" ? n.otel["db.system"] : "database";
    case "topic":
    case "queue":
      return n.otel?.["messaging.system"] ?? n.kind;
    case "external":
      return n.attrs?.ingress ? "ingress" : "external";
  }
  return undefined;
}

/**
 * Maps a graph edge to its diagram line, pointing the way the data moves so every diagram
 * reads from where data comes from to where it goes: a read is drawn from the store to the
 * reader, a consumed topic from the topic to the consumer; writes, publishes, requests (HTTP,
 * TCP) and calls go from the side that sends.
 */
export function flowEdge(e: GraphEdge, s: string, t: string): [string, string, EdgeStyle] | undefined {
  switch (e.kind) {
    case "http_calls":
      return [s, t, "http"];
    case "connects_to":
      // a TCP / TLS connection the code opens (infra links are drawn by the deployment view)
      return e.attrs?.protocol ? [s, t, "connect"] : undefined;
    case "reads":
      return [t, s, "data"];
    case "writes":
      return [s, t, "data"];
    case "publishes":
      return [s, t, "publish"];
    case "consumes":
      return [t, s, "consume"];
    case "calls":
    case "references":
    case "depends_on":
    case "extends":
    case "implements":
      return [s, t, "depends"];
  }
  return undefined;
}

export function styleLabel(e: VEdge & { kinds: Set<string> }) {
  switch (e.style) {
    case "data":
      return dataLabel(e.kinds);
    case "http":
      return "HTTP";
    case "connect":
      return e.kinds.has("connects_to") ? "TCP" : e.label;
    case "publish":
      return "publishes";
    case "consume":
      return "consumed by";
    case "depends":
      return e.count > 1 ? `uses (${e.count})` : "uses";
  }
  return e.label;
}

// ------------------------------------------------------------- architecture

/** Edges that stay inside one process: calls and type relations within the same code container. */
const IN_PROCESS = new Set(["calls", "references", "depends_on", "extends", "implements"]);

export function architectureView(m: Model): ViewModel {
  const edges = new EdgeSet();
  const used = new Set<string>();
  for (const e of m.graph.edges) {
    // two programs built from one module share its code, but a call between that code is not a link between them
    const code = IN_PROCESS.has(e.kind) ? m.owner(e.source, SERVICE_KINDS) : undefined;
    if (code && code.id === m.owner(e.target, SERVICE_KINDS)?.id) continue;
    for (const s of m.appsOf(e.source)) {
      for (const t of m.appsOf(e.target)) {
        if (s.id === t.id) continue;
        const f = flowEdge(e, s.id, t.id);
        if (!f || (f[2] === "depends" && e.kind !== "calls")) continue;
        edges.add(f[0], f[1], f[2], e.kind, undefined, edgeTypes(m, e));
        used.add(s.id).add(t.id);
      }
    }
  }
  // Ingress -> deployment -> service
  for (const e of m.graph.edges) {
    if (e.kind !== "connects_to" || !m.node(e.source)?.attrs?.ingress) continue;
    for (const d of m.out.get(e.target) ?? []) {
      if (d.kind === "deploys" && m.node(d.target)?.kind === "service") {
        edges.add(e.source, d.target, "http", "ingress");
        used.add(e.source).add(d.target);
      }
    }
  }
  const gs = new GroupSet();
  const split = m.splitModules();
  const nodes = m.graph.nodes
    .filter((n) => ARCH.has(n.kind) && !(n.kind === "module" && split.has(n.id) && !used.has(n.id))
      && (n.kind === "service" || n.kind === "module" || used.has(n.id)))
    .map<VNode>((n) => {
      // services that live under a common directory (services/billing, services/orders) form a
      // group; programs built from one module are not boxed together, so a producer -> topic ->
      // consumer pipeline still reads left to right (archSub says which module they come from)
      const dir = String(n.attrs?.path ?? "").split("/").slice(0, -1).join("/");
      const group = systemOf(gs, m, n)
        ?? (dir && dir !== "." ? gs.add({ id: `dir:${dir}`, label: `${dir}/`, kind: "service" }) : undefined);
      const does = SERVICE_KINDS.has(n.kind) ? serviceDoes(m, n) : [];
      return { id: n.id, ref: n.id, label: n.name, sub: archSub(m, n), shape: archShape(n), group, sections: does.length ? [does] : undefined };
    });
  return withReading({
    nodes,
    edges: edges.list(styleLabel),
    direction: "RIGHT",
    empty: "No services found. Upload analyzer snapshots for this repo.",
    groups: gs.list(),
  }, { title: "Architecture", middle: "Programs", middleSub: "services, in the order data moves through them" });
}

/**
 * What a service does, in a row or two: the requests it takes (TCP / HTTP endpoints) and what
 * its code does with data.
 */
export function serviceDoes(m: Model, svc: GraphNode): Row[] {
  const scope = m.codeScope(svc.id);
  const eps = [...scope].map((id) => m.node(id)).filter((n): n is GraphNode => n?.kind === "endpoint");
  const rows: Row[] = [];
  const tcp = eps.filter((e) => e.attrs?.protocol === "tcp");
  const http = eps.filter((e) => e.attrs?.protocol !== "tcp");
  const req = tcp.map((e) => (e.attrs?.request as TypeInfo | undefined)?.type).find(Boolean);
  if (tcp.length) rows.push({ marker: "⇢", text: `Receive ${req ?? "data"} on ${tcp.map((e) => e.name.replace(/^TCP\s*/, "")).join(", ")}` });
  if (http.length) rows.push({ marker: "⇢", text: `Serve ${http.length === 1 ? http[0].name : `${http.length} HTTP endpoints`}` });
  const does = doesRow(m, scope);
  if (does) rows.push(does);
  return rows;
}

// --------------------------------------------------------------- components

export function componentsView(m: Model, serviceId: string): ViewModel {
  const svc = m.node(serviceId);
  if (!svc) return { nodes: [], edges: [], direction: "RIGHT", empty: "Pick a service." };
  const inside = m.codeScope(serviceId);
  const PKG = new Set(["package"]);
  const ownerIn = (id: string) => m.owner(id, PKG)?.id ?? (inside.has(id) ? serviceId : undefined);
  // a call into a sibling program of the same module is a boundary, not "inside"
  const outside = (target: string): string[] => {
    const apps = m.appsOf(target).map((a) => a.id).filter((id) => id !== serviceId);
    const arch = m.owner(target, ARCH);
    if (arch?.kind === "module" && arch.id === svc.attrs?.module) {
      return apps.filter((id) => m.node(id)?.kind === "service");
    }
    return apps.length ? apps : arch ? [arch.id] : [];
  };

  const edges = new EdgeSet();
  const boundary = new Set<string>();
  const used = new Set<string>();
  for (const e of m.graph.edges) {
    if (!inside.has(e.source)) continue;
    const s = ownerIn(e.source);
    if (!s) continue;
    const targets = inside.has(e.target) ? [ownerIn(e.target)].filter((t): t is string => !!t) : outside(e.target);
    for (const t of targets) {
      if (!inside.has(t)) boundary.add(t);
      if (s === t) continue;
      const f = flowEdge(e, s, t);
      if (!f) continue;
      edges.add(f[0], f[1], f[2], e.kind, undefined, edgeTypes(m, e));
      used.add(s).add(t);
    }
  }
  const packages = [...inside].map((id) => m.node(id)).filter((n): n is GraphNode => n?.kind === "package");
  const gs = new GroupSet();
  const nodes: VNode[] = packages.map((p) => {
    const types = (m.children.get(p.id) ?? []).filter((c) => (TYPES.has(c.kind) || c.kind === "function") && inside.has(c.id)).length;
    const group = roleGroup(gs, serviceId, packageRole(m, p.id));
    const does = doesRow(m, m.descendants(p.id).map((d) => d.id).filter((id) => inside.has(id)));
    return { id: p.id, ref: p.id, label: p.name, sub: `${types} type${types === 1 ? "" : "s"}`, shape: "package", group, sections: does ? [[does]] : undefined };
  });
  if (used.has(serviceId)) nodes.push({ id: serviceId, ref: serviceId, label: "(root)", sub: svc.name, shape: "package" });
  for (const id of boundary) {
    const n = m.node(id)!;
    if (!used.has(id)) continue;
    const group = systemOf(gs, m, n) ?? gs.add({ id: "other-services", label: "Other services", kind: "service" });
    nodes.push({ id, ref: id, label: n.name, sub: archSub(m, n), shape: archShape(n), faded: true, group });
  }
  return withReading({
    nodes,
    edges: edges.list(styleLabel),
    direction: "RIGHT",
    empty: `${svc.name} has no packages.`,
    groups: gs.list(),
  }, { title: `${svc.name} · packages`, middle: "Packages", middleSub: `inside ${svc.name}, in the order data moves through them` });
}

// ------------------------------------------------------------------ classes

const VIS: Record<string, string> = { public: "+", private: "-", protected: "#", package: "~" };
const MAX_ROWS = 14;

export function members(m: Model, typeId: string): Row[][] {
  const kids = m.children.get(typeId) ?? [];
  const type = m.node(typeId)!;
  const cap = (rows: Row[]) =>
    rows.length > MAX_ROWS ? [...rows.slice(0, MAX_ROWS), { text: `… ${rows.length - MAX_ROWS} more`, muted: true }] : rows;
  const values = (type.attrs?.values as string[] | undefined)?.map((v) => ({ text: v })) ?? [];
  const fields = kids
    .filter((k) => k.kind === "field")
    .map((f) => ({
      marker: VIS[(f.attrs?.visibility as string) ?? "public"] ?? "+",
      text: `${f.name}: ${f.attrs?.type ?? "?"}`,
      muted: !!f.attrs?.static,
    }));
  const methods = kids
    .filter((k) => k.kind === "method")
    .map((mm) => {
      const params = ((mm.attrs?.params as { name: string; type: string }[] | undefined) ?? []).map((p) => p.type).join(", ");
      const name = mm.name === "<init>" ? type.name : mm.name;
      const ret = mm.attrs?.returnType ? `: ${mm.attrs.returnType}` : "";
      return { marker: VIS[(mm.attrs?.visibility as string) ?? "public"] ?? "+", text: `${name}(${params})${ret}`, muted: !!mm.attrs?.static };
    });
  return [cap(values), cap(fields), cap(methods)].filter((s) => s.length);
}

/** Packages (or service roots) that directly contain types, for the class-diagram picker. */
export function typeContainers(m: Model, serviceId: string): GraphNode[] {
  const scope = m.codeScope(serviceId);
  const containers = new Map<string, number>();
  for (const id of scope) {
    const n = m.node(id);
    if (!n) continue;
    const count = (m.children.get(n.id) ?? []).filter((c) => TYPES.has(c.kind) && scope.has(c.id)).length;
    if (count && n.kind !== "class" && n.kind !== "interface") containers.set(n.id, count);
  }
  return [...containers.keys()].map((id) => m.node(id)!).sort((a, b) => a.name.localeCompare(b.name));
}

export function classView(m: Model, containerId: string): ViewModel {
  const own = (m.children.get(containerId) ?? []).filter((n) => TYPES.has(n.kind));
  const nested = own.flatMap((t) => (m.children.get(t.id) ?? []).filter((n) => TYPES.has(n.kind)));
  const shown = new Map<string, boolean>(); // id -> faded
  for (const t of [...own, ...nested]) shown.set(t.id, false);

  const edges: VEdge[] = [];
  const REL: Record<string, EdgeStyle> = { extends: "extends", implements: "implements", references: "association" };
  for (const e of m.graph.edges) {
    const style = REL[e.kind];
    if (!style) continue;
    const s = m.node(e.source);
    const t = m.node(e.target);
    if (!s || !t || !TYPES.has(s.kind) || !TYPES.has(t.kind)) continue;
    if (!shown.has(s.id) && !shown.has(t.id)) continue;
    for (const n of [s, t]) if (!shown.has(n.id)) shown.set(n.id, true);
    const fields = (e.attrs?.fields as string[] | undefined)?.join(", ");
    edges.push({
      id: `${e.source}|${e.target}|${e.kind}`,
      source: e.source,
      target: e.target,
      style,
      count: 1,
      label: style === "association" ? `${fields ?? ""}${e.attrs?.many ? " *" : ""}`.trim() : undefined,
    });
  }
  const gs = new GroupSet();
  const nodes: VNode[] = [...shown].map(([id, faded]) => {
    const n = m.node(id)!;
    const stereo = (n.attrs?.stereotype as string | undefined) ?? (n.kind !== "class" ? n.kind : undefined);
    // own types by role; related types from elsewhere by their package
    const pkg = faded ? m.node(n.parent ?? "") : undefined;
    const group = faded
      ? (pkg ? gs.add({ id: `pkg:${pkg.id}`, label: pkg.name, sub: "other package", kind: "package" }) : undefined)
      : roleGroup(gs, containerId, typeRole(m, n));
    const supers = [...((n.attrs?.extends as string[]) ?? []), ...((n.attrs?.implements as string[]) ?? [])];
    // what the class is for: its doc comment and what its code does with data, above its members
    const about: Row[] = [];
    const doc = firstSentence(n.attrs?.doc, 70);
    if (doc) about.push({ text: `“${doc}”`, muted: true });
    const does = doesRow(m, m.descendants(id).map((d) => d.id));
    if (does) about.push(does);
    return {
      id,
      ref: id,
      label: n.name,
      sub: faded ? m.node(n.parent ?? "")?.name : supers.length ? `: ${supers.join(", ")}` : undefined,
      stereotype: stereo,
      shape: "class",
      faded,
      sections: faded ? undefined : [...(about.length ? [about] : []), ...members(m, id)],
      group,
    };
  });
  return withReading({ nodes, edges, direction: "DOWN", empty: "No classes here.", groups: gs.list() },
    { title: `Classes · ${m.node(containerId)?.name ?? containerId}`, number: false, stepsLabel: "members" });
}

// ----------------------------------------------------------------------- ER

export function erView(m: Model, databaseId?: string): ViewModel {
  const tables = m.ofKind("table").filter((t) => !databaseId || t.parent === databaseId);
  const ids = new Set(tables.map((t) => t.id));
  const nodes: VNode[] = tables.map((t) => {
    const cols = (t.attrs?.columns as { name: string; type: string; primaryKey?: boolean; foreignKey?: boolean; nullable?: boolean; unique?: boolean }[]) ?? [];
    return {
      id: t.id,
      ref: t.id,
      label: t.name,
      sub: databaseId ? undefined : m.node(t.parent ?? "")?.name,
      shape: "table",
      sections: [...tableUse(m, t), cols.map((c) => ({
        marker: c.primaryKey ? "PK" : c.foreignKey ? "FK" : c.unique ? "UQ" : "",
        text: `${c.name}  ${c.type}${c.nullable === false || c.primaryKey ? "" : "?"}`,
      }))],
    };
  });
  const CARD: Record<string, string> = { "many-to-one": "N : 1", "one-to-one": "1 : 1", "many-to-many": "N : M" };
  const edges: VEdge[] = m.graph.edges
    .filter((e) => e.kind === "references" && ids.has(e.source) && ids.has(e.target))
    .map((e) => ({
      id: `${e.source}|${e.target}`,
      source: e.source,
      target: e.target,
      style: "fk" as const,
      count: 1,
      label: [CARD[e.attrs?.cardinality as string] ?? "", e.attrs?.column ?? e.attrs?.joinTable].filter(Boolean).join("  "),
    }));
  const gs = new GroupSet();
  if (!databaseId) {
    for (const v of nodes) {
      const db = m.node(m.node(v.id)?.parent ?? "");
      if (db) v.group = gs.add({ id: `db:${db.id}`, label: db.name, sub: db.otel?.["db.system"], kind: "database" });
    }
  }
  return withReading({ nodes, edges, direction: "RIGHT", empty: "No tables found (JPA entities, Prisma models or TypeORM entities).", groups: gs.list() },
    { title: "Data model", number: false, isPart: (n) => n.shape === "table", stepsLabel: "columns" });
}

/** Which programs write a table and which read it: "written by orders-service · read by billing". */
function tableUse(m: Model, t: GraphNode): Row[][] {
  const by = (kind: string) => {
    const apps = new Set<string>();
    for (const e of m.in.get(t.id) ?? []) if (e.kind === kind) for (const a of m.appsOf(e.source)) apps.add(a.name);
    return [...apps].sort();
  };
  const rows: Row[] = [];
  const writers = by("writes");
  const readers = by("reads");
  if (writers.length) rows.push({ marker: "↦", text: `written by ${writers.join(", ")}` });
  if (readers.length) rows.push({ marker: "↤", text: `read by ${readers.join(", ")}` });
  return rows.length ? [rows] : [];
}

// --------------------------------------------------------------- deployment

export function deploymentView(m: Model): ViewModel {
  const infra = m.graph.nodes.filter((n) => n.kind === "container" || n.kind === "deployment" || (n.kind === "external" && n.attrs?.ingress));
  const shown = new Map<string, VNode>();
  for (const n of infra) {
    const sub = n.kind === "deployment"
      ? `${n.attrs?.k8sKind ?? "Deployment"}${n.attrs?.replicas ? ` × ${n.attrs.replicas}` : ""} · ${n.attrs?.namespace ?? ""}`
      : n.kind === "container" ? (n.attrs?.image as string) ?? (n.attrs?.buildContext ? `build ./${n.attrs.buildContext}` : "container")
        : "ingress";
    shown.set(n.id, { id: n.id, ref: n.id, label: n.name, sub, shape: archShape(n) === "ingress" ? "ingress" : (n.kind as Shape) });
  }
  const edges: VEdge[] = [];
  for (const e of m.graph.edges) {
    if (!shown.has(e.source) || (e.kind !== "deploys" && e.kind !== "connects_to")) continue;
    const t = m.node(e.target);
    if (!t) continue;
    if (!shown.has(t.id)) shown.set(t.id, { id: t.id, ref: t.id, label: t.name, sub: archSub(m, t), shape: archShape(t), faded: true });
    edges.push({
      id: `${e.source}|${e.target}|${e.kind}`,
      source: e.source,
      target: e.target,
      style: e.kind === "deploys" ? "deploy" : "connect",
      count: 1,
      label: e.kind === "deploys" ? "runs" : (e.attrs?.paths as string[] | undefined)?.join(", "),
    });
  }
  const gs = new GroupSet();
  for (const v of shown.values()) {
    const n = m.node(v.id);
    if (!n || v.faded) continue;
    if (n.attrs?.source === "compose" && n.location) {
      v.group = gs.add({ id: `compose:${n.location.file}`, label: n.location.file, sub: "docker-compose", kind: "deployment" });
    } else if (n.kind === "deployment") {
      v.group = gs.add({ id: `ns:${n.attrs?.namespace}`, label: `namespace ${n.attrs?.namespace ?? "default"}`, sub: "kubernetes", kind: "deployment" });
    }
  }
  // what each container runs, as a row: the program it deploys and what that program does
  for (const v of shown.values()) {
    if (v.faded) continue;
    const runs = (m.out.get(v.id) ?? []).filter((e) => e.kind === "deploys").map((e) => m.node(e.target)).filter((n): n is GraphNode => !!n);
    const rows: Row[] = runs.map((r) => ({ marker: "▸", text: `runs ${r.name}` }));
    for (const r of runs) if (SERVICE_KINDS.has(r.kind)) rows.push(...serviceDoes(m, r).slice(0, 1));
    if (rows.length) v.sections = [rows];
  }
  return withReading({ nodes: [...shown.values()], edges, direction: "RIGHT", empty: "No docker-compose or Kubernetes files found.", groups: gs.list() },
    { title: "Deployment", number: false, isPart: (n) => !n.faded && (n.shape === "container" || n.shape === "deployment"), stepsLabel: "runs" });
}

// --------------------------------------------------------------------- flow

export interface Endpoint {
  node: GraphNode;
  service?: GraphNode;
  handler?: GraphNode;
  /** Data stores, topics and remote services reached from the handler. */
  touches: GraphNode[];
  /** What handling it does with data: "Publish order-events · write orders". */
  does?: string;
}

/** Callables reachable from `start` through calls (breadth-first, bounded). */
/**
 * Methods reached from start through calls (and handles) edges, with their depth. Work started
 * on another thread (calls edges with attrs.async) is not part of the same flow unless
 * followAsync is set.
 */
/**
 * Methods reachable from start along calls and handles (async ones only when asked), with
 * their depth. A call to an abstract method (an interface the code is written against) also
 * reaches the in-repo methods implementing it.
 */
export function reachable(m: Model, start: string, maxNodes = 80, maxDepth = 10, followAsync = false): Map<string, number> {
  const depth = new Map([[start, 0]]);
  const queue = [start];
  const visit = (id: string, d: number) => {
    if (depth.has(id) || !CALLABLE.has(m.node(id)?.kind ?? "")) return;
    depth.set(id, d);
    queue.push(id);
  };
  while (queue.length && depth.size < maxNodes) {
    const id = queue.shift()!;
    const d = depth.get(id)!;
    if (d >= maxDepth) continue;
    for (const e of m.out.get(id) ?? []) {
      if (e.attrs?.async && !followAsync) continue;
      if (e.kind === "calls" || e.kind === "handles") visit(e.target, d + 1);
    }
    const n = m.node(id);
    if (n?.attrs?.abstract) for (const impl of m.implementations(n)) visit(impl, d + 1);
  }
  return depth;
}

export const SIDE_EFFECTS = new Set(["reads", "writes", "publishes", "consumes", "http_calls", "connects_to"]);

/** Short label for the conditions an edge runs under; undefined if it always runs. */
export function conditionLabel(e: GraphEdge): string | undefined {
  const conds = e.attrs?.conditions as string[] | undefined;
  if (!conds?.length || e.attrs?.unconditional) return undefined;
  const first = conds[0].split(" › ").pop()!;
  const short = first.length > 42 ? first.slice(0, 40) + "…" : first;
  return conds.length > 1 ? `${short} (+${conds.length - 1})` : short;
}

export function endpoints(m: Model): Endpoint[] {
  return m.ofKind("endpoint").map((ep) => {
    const handler = (m.out.get(ep.id) ?? []).find((e) => e.kind === "handles");
    const touches = new Map<string, GraphNode>();
    const reach = handler ? [...reachable(m, handler.target).keys()] : [];
    if (handler) {
      for (const id of reach) {
        for (const e of m.out.get(id) ?? []) {
          if (!SIDE_EFFECTS.has(e.kind)) continue;
          const t = m.node(e.target);
          if (t) touches.set(t.id, t);
        }
      }
    }
    const apps = m.appsOf(ep.id).filter((a) => a.kind === "service");
    return {
      node: ep,
      service: apps.length === 1 ? apps[0] : m.owner(ep.id, new Set(["service", "module"])),
      handler: handler && m.node(handler.target),
      touches: [...touches.values()],
      does: effectText(m, effectsOf(m, reach)),
    };
  });
}

export function callableLabel(m: Model, n: GraphNode) {
  const owner = n.parent ? m.node(n.parent) : undefined;
  return owner && TYPES.has(owner.kind) ? `${owner.name}.${n.name === "<init>" ? "new" : n.name}` : n.name;
}

/** "How does this work": endpoint -> handler -> call tree -> data stores / topics / remote calls. */
export function flowView(m: Model, startId: string): ViewModel {
  const start = m.node(startId);
  if (!start) return { nodes: [], edges: [], direction: "RIGHT", empty: "Pick an endpoint." };
  const root = start.kind === "endpoint" ? (m.out.get(startId) ?? []).find((e) => e.kind === "handles")?.target : startId;
  const nodes = new Map<string, VNode>();
  const edges: VEdge[] = [];
  if (start.kind === "endpoint") {
    const app = m.appsOf(start.id).find((a) => a.kind === "service") ?? m.owner(start.id, new Set(["service", "module"]));
    nodes.set(start.id, { id: start.id, ref: start.id, label: start.name, sub: app?.name, shape: "endpoint" });
  }
  if (!root) return { nodes: [...nodes.values()], edges, direction: "RIGHT", empty: "No handler found for this endpoint." };
  const reached = reachable(m, root);
  // Leaf getters/setters (no calls, no side effects) add noise without explaining anything.
  for (const id of [...reached.keys()]) {
    const n = m.node(id)!;
    const leaf = !(m.out.get(id) ?? []).some((e) => e.kind === "calls" || SIDE_EFFECTS.has(e.kind));
    if (id !== root && leaf && /^(get|set|is|has)[A-Z]/.test(n.name)) reached.delete(id);
  }
  for (const id of reached.keys()) {
    const n = m.node(id)!;
    const body = (n.attrs?.controlFlow as unknown[] | undefined)?.length;
    // named by what it does (doc comment, its own I/O), the function underneath
    const { title, code } = functionTitle(m, id);
    nodes.set(id, {
      id, ref: id, label: title, sub: title === code ? locationText(n) : `${code} · ${locationText(n)}`, shape: "function",
      enterable: !!body, refs: body ? [{ id, label: callableLabel(m, n) }] : undefined,
    });
  }
  if (start.kind === "endpoint") {
    // the request the endpoint receives is what it hands its handler
    const req = (start.attrs?.request as TypeInfo | undefined)?.type;
    const inputs = ((start.attrs?.inputs as { name: string; type?: string }[] | undefined) ?? []).map((i) => (i.type ? `${i.name}: ${i.type}` : i.name));
    const types = [...(req ? [req] : []), ...inputs];
    edges.push({
      id: `${start.id}|${root}`, source: start.id, target: root, style: "handles", count: 1,
      label: types.length ? typeText(types) : undefined, sublabel: types.length ? "request" : undefined, types: types.length ? types : undefined,
    });
  }
  for (const id of reached.keys()) {
    for (const e of m.out.get(id) ?? []) {
      if (e.kind === "calls" && reached.has(e.target)) {
        const line = e.locations?.[0]?.startLine;
        const cond = conditionLabel(e);
        const types = edgeTypes(m, e);
        const where = cond ?? (line ? `L${line}` : undefined);
        edges.push({
          id: `${id}|${e.target}|calls`, source: id, target: e.target, style: "call", count: 1,
          label: types.length ? typeText(types) : where, sublabel: types.length ? where : undefined,
          conditional: !!cond, types: types.length ? types : undefined,
        });
      } else if (SIDE_EFFECTS.has(e.kind)) {
        const t = m.node(e.target);
        if (!t) continue;
        if (!nodes.has(t.id)) nodes.set(t.id, { id: t.id, ref: t.id, label: t.name, sub: t.kind === "table" ? m.node(t.parent ?? "")?.name : archSub(m, t), shape: archShape(t) === "ingress" ? "external" : (t.kind as Shape) });
        const f = flowEdge(e, id, t.id);
        if (!f) continue;
        const ops = (e.attrs?.operations as string[] | undefined)?.join(", ");
        const http = e.kind === "http_calls" ? [e.attrs?.method, e.attrs?.path].filter(Boolean).join(" ") : undefined;
        const cond = conditionLabel(e);
        const what = http || ops || e.kind.replace("_", " ");
        const verb = cond ? `${what} · ${cond}` : what;
        const types = edgeTypes(m, e);
        edges.push({
          id: `${id}|${t.id}|${e.kind}`, source: f[0], target: f[1], style: f[2], count: 1,
          label: types.length ? typeText(types) : verb, sublabel: types.length ? verb : undefined,
          conditional: !!cond, types: types.length ? types : undefined,
        });
      }
    }
  }
  // functions sit in their class, inside their service; data stores in their system
  const gs = new GroupSet();
  for (const v of nodes.values()) {
    const n = m.node(v.ref ?? v.id);
    if (!n) continue;
    if (n.kind === "method" || n.kind === "function" || n.kind === "endpoint") {
      const apps = m.appsOf(n.id).filter((a) => a.kind === "service");
      const svc = apps.length === 1 ? apps[0] : m.owner(n.id, new Set(["service", "module"]));
      const svcGroup = svc ? gs.add({ id: `svc:${svc.id}`, label: svc.name, kind: "service" }) : undefined;
      const owner = n.parent ? m.node(n.parent) : undefined;
      v.group = owner && TYPES.has(owner.kind)
        ? gs.add({ id: `cls:${owner.id}`, label: owner.name, sub: owner.kind, kind: "class", parent: svcGroup })
        : svcGroup;
    } else {
      v.group = systemOf(gs, m, n) ?? (SERVICE_KINDS.has(n.kind) ? gs.add({ id: "other-services", label: "Other services", kind: "service" }) : undefined);
    }
  }
  return withReading({ nodes: [...nodes.values()], edges, direction: "RIGHT", groups: gs.list() },
    { title: `How ${start.name} works`, middle: "Code", middleSub: "the functions it runs, in the order data moves", stepsLabel: "steps" });
}

const SERVICE_KINDS = new Set(["service", "module"]);
