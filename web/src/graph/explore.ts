// "Explore": one drill-down from the level-0 context diagram to the logic of a single
// function. Every level is a view; "Inside" on a box opens the next level for that box:
//   context › system › service › package › class › function › function › …
// (and system › database for a database's tables).
import type { GraphNode } from "../api";
import { activityView, controlFlowOf, FN_BOX, isAccessor } from "./activity";
import { homeGroup, homeOf, OUTSIDE, Variable, variableBox, variableEdges, variableId, variablesOf, whatItDoes } from "./variables";
import { contextDataFlow, DFD_SYSTEM } from "./dataflow";
import { Model, locationText } from "./model";
import { doesRow, edgeTypes, firstSentence, functionTitle, withReading } from "./reading";
import {
  ARCH, archShape, archSub, architectureView, callableLabel, componentsView, EdgeSet, erView, flowEdge,
  GroupSet, Row, styleLabel, systemOf, TYPES, VEdge, VNode, ViewModel,
} from "./views";

export type ScopeKind = "context" | "system" | "service" | "package" | "class" | "function" | "database";

export interface Scope {
  kind: ScopeKind;
  /** Graph node id (none for context / system). */
  id?: string;
}

export const LEVEL: Record<ScopeKind, string> = {
  context: "Level 0 · context",
  system: "Level 1 · system",
  service: "Level 2 · service",
  package: "Level 3 · package",
  class: "Level 4 · class",
  function: "Level 5 · function",
  database: "Data model",
};

const SERVICES = new Set(["service", "module"]);
const CALLABLE = new Set(["method", "function"]);

export function sameScope(a: Scope, b: Scope) {
  return a.kind === b.kind && a.id === b.id;
}

export function scopeLabel(m: Model, s: Scope, systemName: string): string {
  if (s.kind === "context") return `${systemName} (context)`;
  if (s.kind === "system") return systemName;
  const n = s.id ? m.node(s.id) : undefined;
  if (!n) return s.id ?? s.kind;
  if (s.kind === "function") return callableLabel(m, n);
  if (s.kind === "package" && SERVICES.has(n.kind)) return `${n.name} (root)`;
  return n.name;
}

export function scopeView(m: Model, s: Scope, systemName: string): ViewModel {
  switch (s.kind) {
    case "context": return contextDataFlow(m, systemName);
    case "system": return architectureView(m);
    case "service": return componentsView(m, s.id!);
    case "package": return packageInside(m, s.id!);
    case "class": return classInside(m, s.id!);
    case "function": return activityView(m, s.id!);
    case "database": return erView(m, s.id);
  }
}

/** What "Inside" on a box of scope `s` opens. Several targets: the viewer picks one. */
export function insideOf(m: Model, s: Scope, box: VNode): { scope: Scope; label: string }[] {
  if (s.kind === "context") return box.id === DFD_SYSTEM ? [{ scope: { kind: "system" }, label: "the system" }] : [];
  if (s.kind === "function") {
    return (box.refs ?? []).map((r) => ({ scope: { kind: "function" as const, id: r.id }, label: r.label }));
  }
  const ref = box.ref ? m.node(box.ref) : undefined;
  const target = ref && scopeOfNode(m, ref);
  return target ? [{ scope: target, label: scopeLabel(m, target, "") }] : [];
}

/** The level a graph node is the subject of when you go inside it, if it has an inside. */
export function scopeOfNode(m: Model, n: GraphNode): Scope | undefined {
  if (SERVICES.has(n.kind)) {
    // a service without packages: its types and functions sit directly under it
    const hasPackages = [...m.codeScope(n.id)].some((id) => m.node(id)?.kind === "package");
    return hasPackages ? { kind: "service", id: n.id } : { kind: "package", id: n.id };
  }
  if (n.kind === "package") return { kind: "package", id: n.id };
  if (TYPES.has(n.kind)) return { kind: "class", id: n.id };
  if (CALLABLE.has(n.kind)) return controlFlowOf(n)?.length ? { kind: "function", id: n.id } : undefined;
  if (n.kind === "database") return { kind: "database", id: n.id };
  if (n.kind === "endpoint") {
    const h = (m.out.get(n.id) ?? []).find((e) => e.kind === "handles");
    const fn = h && m.node(h.target);
    return fn ? scopeOfNode(m, fn) : undefined;
  }
  return undefined;
}

/** Full path from level 0 down to (and including) the scope of `nodeId`. */
export function pathTo(m: Model, nodeId: string): Scope[] {
  const path: Scope[] = [{ kind: "context" }, { kind: "system" }];
  const n = m.node(nodeId);
  const target = n && scopeOfNode(m, n);
  if (!n || !target) return path;
  if (target.kind === "database") return [...path, target];
  const subject = m.node(target.id!)!;
  // ancestors of the subject, outermost first: service › package › class
  const chain: GraphNode[] = [];
  for (let p = subject.parent ? m.node(subject.parent) : undefined, guard = 0; p && guard < 20; p = p.parent ? m.node(p.parent) : undefined, guard++) {
    chain.unshift(p);
  }
  for (const a of chain) {
    const s = scopeOfNode(m, a);
    if (s && s.kind !== "function" && !path.some((x) => sameScope(x, s))) path.push(s);
  }
  if (!path.some((x) => sameScope(x, target))) path.push(target);
  return path;
}

// ------------------------------------------------------------------ level 3

/** A package (or a service root): its classes and functions, how they use each other, what they touch. */
export function packageInside(m: Model, containerId: string): ViewModel {
  const container = m.node(containerId);
  if (!container) return { nodes: [], edges: [], direction: "RIGHT", empty: "Unknown package." };
  const members = (m.children.get(containerId) ?? []).filter((c) => TYPES.has(c.kind) || c.kind === "function");
  const memberIds = new Set(members.map((x) => x.id));
  // which member a node belongs to (a method -> its class)
  const memberOf = (id: string): string | undefined => {
    for (let n = m.node(id), g = 0; n && g < 20; n = n.parent ? m.node(n.parent) : undefined, g++) if (memberIds.has(n.id)) return n.id;
    return undefined;
  };
  const edges = new EdgeSet();
  const outside = new Map<string, GraphNode>();
  for (const e of m.graph.edges) {
    const s = memberOf(e.source);
    if (!s) continue;
    let t = memberOf(e.target);
    if (!t) {
      // leaving the package: stores / topics / services, else the other package
      const arch = m.owner(e.target, ARCH);
      const other = arch && !(SERVICES.has(arch.kind) && arch.id === m.owner(containerId, SERVICES)?.id)
        ? arch : m.owner(e.target, new Set(["package"]));
      if (!other || other.id === containerId) continue;
      t = other.id;
      outside.set(other.id, other);
    }
    if (s === t) continue;
    const f = flowEdge(e, s, t);
    if (f) edges.add(f[0], f[1], f[2], e.kind, undefined, edgeTypes(m, e));
  }
  const gs = new GroupSet();
  const nodes: VNode[] = members.map((x) => {
    if (x.kind === "function") {
      return { id: x.id, ref: x.id, label: x.name, sub: locationText(x), shape: "function" };
    }
    const methods = (m.children.get(x.id) ?? []).filter((c) => c.kind === "method");
    const rows: Row[] = [];
    const doc = firstSentence(x.attrs?.doc, 70);
    if (doc) rows.push({ text: `“${doc}”`, muted: true });
    const does = doesRow(m, m.descendants(x.id).map((d) => d.id));
    if (does) rows.push(does);
    rows.push(...methods.slice(0, 8).map((mm) => ({ marker: "→", text: mm.name === "<init>" ? "new" : mm.name })));
    if (methods.length > 8) rows.push({ marker: "", text: `… ${methods.length - 8} more` });
    return {
      id: x.id, ref: x.id, label: x.name, shape: "class",
      stereotype: (x.attrs?.stereotype as string | undefined) ?? (x.kind !== "class" ? x.kind : undefined),
      sections: rows.length ? [rows] : undefined,
    };
  });
  for (const o of outside.values()) {
    nodes.push({
      id: o.id, ref: o.id, label: o.name, sub: o.kind === "package" ? "other package" : archSub(m, o),
      shape: o.kind === "package" ? "package" : archShape(o), faded: true,
      group: systemOf(gs, m, o) ?? gs.add({ id: "outside", label: "Outside this package", kind: "service" }),
    });
  }
  return withReading({
    nodes, edges: edges.list(styleLabel), direction: "RIGHT", groups: gs.list(),
    empty: `${container.name} has no classes or functions.`,
  }, { title: `${container.name} · classes`, middle: "Classes", middleSub: `in ${container.name}, in the order data moves through them`, stepsLabel: "what it does" });
}

// ------------------------------------------------------------------ level 4

/** A class: its methods, the calls between them, and what they reach outside the class. */
export function classInside(m: Model, typeId: string): ViewModel {
  const type = m.node(typeId);
  if (!type) return { nodes: [], edges: [], direction: "RIGHT", empty: "Unknown class." };
  const methods = (m.children.get(typeId) ?? []).filter((c) => c.kind === "method");
  const ids = new Set(methods.map((x) => x.id));
  const edges = new EdgeSet();
  const outside = new Map<string, GraphNode>();
  const gs = new GroupSet();
  const ownerType = (id: string) => m.owner(id, TYPES);
  for (const meth of methods) {
    for (const e of m.out.get(meth.id) ?? []) {
      let t: string | undefined;
      if (ids.has(e.target)) t = e.target;
      else if (e.kind === "calls") {
        const other = ownerType(e.target) ?? m.node(e.target);
        if (other) {
          t = other.id;
          outside.set(other.id, other);
        }
      } else {
        const arch = m.owner(e.target, ARCH);
        if (arch) {
          t = arch.id;
          outside.set(arch.id, arch);
        }
      }
      if (!t || t === meth.id) continue;
      const f = flowEdge(e, meth.id, t);
      if (f) edges.add(f[0], f[1], f[2], e.kind, undefined, edgeTypes(m, e));
    }
    // endpoints / listeners that start here
    for (const e of m.in.get(meth.id) ?? []) {
      if (e.kind === "handles" && m.node(e.source)) {
        const ep = m.node(e.source)!;
        outside.set(ep.id, ep);
        edges.add(ep.id, meth.id, "handles", "handles", "handles");
      }
    }
  }
  // the class is its own box: its methods (each saying what it does) and its fields inside,
  // state declared anywhere else in boxes beside it
  const cls = gs.add({ id: `cls:${typeId}`, label: type.name, sub: type.kind, kind: "class", keep: true });
  const nodes: VNode[] = methods.map((x) => {
    const params = ((x.attrs?.params as { type: string }[] | undefined) ?? []).map((p) => p.type).join(", ");
    const ret = x.attrs?.returnType ? `: ${x.attrs.returnType}` : "";
    const signature = `${x.name === "<init>" ? "new" : x.name}(${params})${ret}`;
    // named by what it does (doc comment, its own I/O), the signature underneath
    const { title, code } = functionTitle(m, x.id);
    return {
      id: x.id, ref: x.id, label: title === code ? signature : title,
      sub: [title === code ? "" : signature, x.attrs?.entryPoint ? `${x.attrs.entryPoint} entry point` : "", locationText(x)].filter(Boolean).join(" · "),
      shape: "function", faded: !controlFlowOf(x)?.length, group: cls,
      sections: controlFlowOf(x)?.length || x.attrs?.doc ? [whatItDoes(m, x).filter((r) => r.marker !== "in").slice(0, 6)] : undefined,
    };
  });
  const fields = new Map<string, VNode>();
  for (const f of m.children.get(typeId) ?? []) {
    if (f.kind !== "field") continue;
    const v: Variable = { name: f.name, scope: f.attrs?.static ? "static" : "field", type: f.attrs?.type as string | undefined,
      declaredIn: f.id, reads: 0, writes: 0, final: f.attrs?.final === true || undefined };
    fields.set(variableId(v), variableBox(v, cls));
  }
  const outsideState = new Map<string, VNode>();
  for (const meth of methods) {
    for (const v of variablesOf(meth)) {
      if (!OUTSIDE.has(v.scope)) continue;
      const vid = variableId(v);
      if (!fields.has(vid) && !outsideState.has(vid)) {
        const home = homeOf(m, v);
        outsideState.set(vid, variableBox(v, gs.add(homeGroup(home))));
      }
      for (const e of variableEdges(v, [], meth.id)) edges.add(e.source, e.target, e.style, e.style, e.label);
    }
  }
  nodes.push(...fields.values(), ...outsideState.values());
  for (const o of outside.values()) {
    nodes.push({
      id: o.id, ref: o.id, label: o.name,
      sub: TYPES.has(o.kind) ? "other class" : o.kind === "endpoint" ? "endpoint" : archSub(m, o),
      shape: TYPES.has(o.kind) ? "class" : o.kind === "endpoint" ? "endpoint" : archShape(o), faded: o.kind !== "endpoint",
      group: o.kind === "endpoint" ? gs.add({ id: "entry", label: "Called from", kind: "role" })
        : systemOf(gs, m, o) ?? gs.add({ id: "outside", label: "Other classes", kind: "class" }),
    });
  }
  // the class stays one box (its methods and fields together), so no lanes; methods are
  // numbered in the order data moves through them and listed in the outline
  return withReading({
    nodes, edges: edges.list(styleLabel), direction: "RIGHT", groups: gs.list(),
    empty: `${type.name} has no methods.`,
  }, { title: `${type.name} · methods`, isPart: (n) => n.shape === "function" && n.group === cls, stepsLabel: "what it does" });
}

// ------------------------------------------------------------ all layers

const STEP = "|"; // separates a function id from its step ids in the all-layers view

/**
 * Everything below scope `s` in one nested diagram: service › package › class › function boxes,
 * each function box holding its own logic (steps, decisions, loops). Calls run from the step
 * that makes them to the start of the called function; I/O runs from the step to the store,
 * topic or remote service. Every layer is a collapsible group.
 */
export function allLayersView(m: Model, s: Scope): ViewModel {
  const fns = functionsBelow(m, s);
  const gs = new GroupSet();
  const nodes: VNode[] = [];
  const edges: VEdge[] = [];
  const stores = new Map<string, VNode>();

  // structural groups: service › package › class › function
  const groupFor = (n: GraphNode): string | undefined => {
    const chain: GraphNode[] = [];
    for (let p = n.parent ? m.node(n.parent) : undefined, g = 0; p && g < 20; p = p.parent ? m.node(p.parent) : undefined, g++) chain.unshift(p);
    let parent: string | undefined;
    for (const a of chain) {
      const kind = SERVICES.has(a.kind) ? "service" : a.kind === "package" ? "package" : TYPES.has(a.kind) ? "class" : undefined;
      if (!kind) continue;
      parent = gs.add({ id: `L:${a.id}`, label: a.name, sub: kind === "class" ? a.kind : undefined, kind, parent });
    }
    return parent;
  };

  const startOf = new Map<string, string>(); // function id -> the node calls into it should point at
  const outsideUses: { fn: GraphNode; steps: { id: string; lines?: number[] }[] }[] = [];
  for (const fn of fns) {
    const parent = groupFor(fn);
    const cf = controlFlowOf(fn);
    if (!cf?.length) {
      // no body (interface, declarative client): a single box
      nodes.push({ id: fn.id, ref: fn.id, label: callableLabel(m, fn), sub: "no body", shape: "function", group: parent, faded: true });
      startOf.set(fn.id, fn.id);
      continue;
    }
    const fnGroup = gs.add({ id: `F:${fn.id}`, label: callableLabel(m, fn), sub: locationText(fn), kind: "function", parent });
    const act = activityView(m, fn.id, { outside: false });
    const pid = (id: string) => `${fn.id}${STEP}${id}`;
    // the activity's own function box is this function's group
    const inFn = (g?: string) => (!g || g === FN_BOX ? fnGroup : pid(g));
    for (const g of act.groups ?? []) if (g.id !== FN_BOX) gs.add({ ...g, id: pid(g.id), parent: inFn(g.parent) });
    for (const n of act.nodes) {
      nodes.push({ ...n, id: pid(n.id), group: inFn(n.group), enterable: false });
      // calls from this step into other functions shown here
      for (const r of n.refs ?? []) edges.push({ id: `${pid(n.id)}>call>${r.id}`, source: pid(n.id), target: `@${r.id}`, style: "call", count: 1 });
      for (const t of n.touches ?? []) {
        const target = m.node(t.target);
        const store = target && (target.kind === "table" || target.kind === "topic" || target.kind === "queue" || target.kind === "database"
          ? target : m.owner(target.id, ARCH));
        if (!store) continue;
        if (!stores.has(store.id)) {
          const db = store.kind === "table" ? m.node(store.parent ?? "") : undefined;
          const sys = systemOf(gs, m, store);
          stores.set(store.id, {
            id: store.id, ref: store.id, label: store.name, sub: store.kind === "table" ? db?.name : archSub(m, store),
            shape: store.kind === "table" ? "table" : archShape(store),
            group: db ? gs.add({ id: `db:${db.id}`, label: db.name, kind: "database", parent: sys }) : sys,
          });
        }
        const style = t.kind === "http_calls" ? "http" : t.kind === "connects_to" ? "connect"
          : t.kind === "publishes" ? "publish" : t.kind === "consumes" ? "consume" : "data";
        const [from, to] = t.kind === "reads" || t.kind === "consumes" ? [store.id, pid(n.id)] : [pid(n.id), store.id];
        edges.push({ id: `${pid(n.id)}>${t.kind}>${store.id}`, source: from, target: to, style, count: 1, label: t.kind.replace("_", " ") });
      }
      if (n.shape === "start") startOf.set(fn.id, pid(n.id));
    }
    for (const e of act.edges) edges.push({ ...e, id: pid(e.id), source: pid(e.source), target: pid(e.target) });
    outsideUses.push({ fn, steps: act.nodes.filter((n) => n.lines?.length).map((n) => ({ id: pid(n.id), lines: n.lines })) });
  }
  // variables declared outside a function: one box each, in the class / file / function declaring it
  const fileHome = new Map<string, GraphNode | undefined>();
  const nodeInFile = (path: string) => {
    if (!fileHome.has(path)) fileHome.set(path, m.graph.nodes.find((n) => n.location?.file === path && n.kind !== "field"));
    return fileHome.get(path);
  };
  const vars = new Map<string, VNode>();
  for (const { fn, steps } of outsideUses) {
    for (const v of variablesOf(fn)) {
      if (!OUTSIDE.has(v.scope)) continue;
      const vid = variableId(v);
      if (!vars.has(vid)) {
        const home = homeOf(m, v);
        let group: string | undefined;
        if (v.scope === "field" || v.scope === "static") {
          const field = m.node(v.declaredIn ?? "");
          const cls = field?.parent ? m.node(field.parent) : undefined;
          group = cls && fns.some((f) => f.parent === cls.id) ? groupFor(field!) : undefined;
        } else if (v.scope === "captured" && gs.has(`F:${v.declaredIn}`)) {
          group = `F:${v.declaredIn}`;
        } else if (v.scope !== "captured") {
          const near = nodeInFile(v.declaredIn ?? "");
          group = gs.add({ ...homeGroup(home), parent: near ? groupFor(near) : undefined });
        }
        vars.set(vid, variableBox(v, group ?? gs.add(homeGroup(home))));
      }
      edges.push(...variableEdges(v, steps, startOf.get(fn.id) ?? fn.id));
    }
  }
  nodes.push(...vars.values());
  // entry points from outside: endpoints into their handlers
  for (const fn of fns) {
    for (const e of m.in.get(fn.id) ?? []) {
      const ep = m.node(e.source);
      if (e.kind !== "handles" || !ep) continue;
      nodes.push({ id: ep.id, ref: ep.id, label: ep.name, sub: "endpoint", shape: "endpoint", group: groupFor(ep) });
      edges.push({ id: `${ep.id}>handles`, source: ep.id, target: `@${fn.id}`, style: "handles", count: 1 });
    }
  }
  nodes.push(...stores.values());
  // resolve call targets to the called function's start; drop calls leaving the scope
  const resolved = edges.flatMap((e) => {
    if (!e.target.startsWith("@")) return [e];
    const t = startOf.get(e.target.slice(1));
    return t ? [{ ...e, target: t }] : [];
  });
  return {
    // every function shows its inner workings: nothing folded until the reader folds it
    nodes, edges: resolved, direction: "DOWN", groups: gs.list(), budget: Infinity, layout: "compact",
    empty: "No functions with a body to show here.",
  };
}

/** The functions an all-layers view covers for a scope. */
function functionsBelow(m: Model, s: Scope): GraphNode[] {
  const callable = (n: GraphNode) => CALLABLE.has(n.kind) && !isAccessorNode(m, n);
  if (s.kind === "function" && s.id) {
    // the function and everything it calls (its whole call tree)
    const seen = new Set<string>([s.id]);
    const queue = [s.id];
    while (queue.length && seen.size < 150) {
      for (const e of m.out.get(queue.shift()!) ?? []) {
        const t = m.node(e.target);
        if (e.kind === "calls" && t && callable(t) && !seen.has(t.id)) {
          seen.add(t.id);
          queue.push(t.id);
        }
      }
    }
    return [...seen].map((id) => m.node(id)!).filter(Boolean);
  }
  if (s.kind === "database") return [];
  // a split module holds the code; its programs reach a subset and would list the same function twice
  const roots = s.id ? [s.id] : m.services().filter((svc) => !svc.attrs?.module).map((x) => x.id);
  const ids = new Set<string>();
  for (const r of roots) for (const id of m.codeScope(r)) ids.add(id);
  return [...ids].map((id) => m.node(id)!).filter((n) => n && callable(n))
    .filter((n) => controlFlowOf(n)?.length || (m.in.get(n.id) ?? []).some((e) => e.kind === "calls"));
}

function isAccessorNode(m: Model, n: GraphNode) {
  return isAccessor(m, n.id);
}

// ------------------------------------------------------------ choices on the canvas

/** One of several things a box leads into, laid out next to it on the canvas. */
export interface Choice {
  key: string;
  label: string;
  /** Graph node shown in the details panel. */
  ref?: string;
  sub?: string;
}

export const CHOICE = "pick:";

/**
 * Puts `choices` on the canvas beside box `from`, each linked to it with a dashed line,
 * so a box holding several things fans out in place instead of opening a menu.
 */
export function withChoices(view: ViewModel, from: string, choices: Choice[], label = "contains"): ViewModel {
  const box = view.nodes.find((n) => n.id === from);
  if (!box || !choices.length) return view;
  return {
    ...view,
    nodes: [...view.nodes, ...choices.map((c): VNode => ({
      id: CHOICE + c.key, ref: c.ref, label: c.label, sub: c.sub ?? "▸ Inside to open", shape: "function",
      group: box.group, enterable: true,
    }))],
    edges: [...view.edges, ...choices.map((c): VEdge => ({
      id: `${from}>${CHOICE}${c.key}`, source: from, target: CHOICE + c.key, style: "depends", count: 1, label,
    }))],
  };
}
