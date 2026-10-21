// Variables a function uses (attrs.variables from the analyzers) and what a function does,
// for the boxes that show a function's own variables inside it and outside state beside it.
import type { GraphNode } from "../api";
import { controlFlowOf, Step } from "./activity";
import { Model } from "./model";
import type { Row, VEdge, VGroup, VNode } from "./views";

export type VarScope = "param" | "local" | "captured" | "field" | "static" | "module" | "imported";

export interface Variable {
  name: string;
  scope: VarScope;
  type?: string;
  /** Field node id, enclosing function id, or the file a module variable lives in. */
  declaredIn?: string;
  line?: number;
  reads: number;
  writes: number;
  lines?: number[];
  writeLines?: number[];
  final?: boolean;
}

/** Declared somewhere else than the function that uses it. */
export const OUTSIDE: ReadonlySet<VarScope> = new Set(["captured", "field", "static", "module", "imported"]);

export const SCOPE_TEXT: Record<VarScope, string> = {
  param: "parameter", local: "local", captured: "captured", field: "field", static: "static",
  module: "module variable", imported: "imported",
};

const SCOPE_MARK: Record<VarScope, string> = {
  param: "in", local: "·", captured: "↖", field: "◆", static: "◈", module: "◈", imported: "◈",
};

export function variablesOf(n: GraphNode | undefined): Variable[] {
  return (n?.attrs?.variables as Variable[] | undefined) ?? [];
}

/** Where an outside variable is declared: the box it is attached to. */
export interface Home {
  id: string;
  label: string;
  sub: string;
  /** Graph node to open (class, function), if there is one. */
  ref?: string;
}

export function homeOf(m: Model, v: Variable): Home {
  const d = v.declaredIn ?? "";
  if (v.scope === "field" || v.scope === "static") {
    const field = m.node(d);
    const cls = field?.parent ? m.node(field.parent) : undefined;
    const name = cls?.name ?? d.replace(/^field:/, "").replace(/#.*$/, "").split(/[./]/).pop() ?? "class";
    return { id: `home:${cls?.id ?? d.replace(/#[^#]*$/, "")}`, label: name, sub: "class state", ref: cls?.id };
  }
  if (v.scope === "captured") {
    const fn = m.node(d);
    return { id: `home:${d || "enclosing"}`, label: fn ? fn.name : "enclosing function", sub: "enclosing function", ref: fn?.id };
  }
  return { id: `home:file:${d}`, label: d.split("/").pop() || "module", sub: v.scope === "imported" ? `module · ${d}` : `this file · ${d}`, };
}

/** Stable id for one outside variable, shared by every function that uses it. */
export function variableId(v: Variable): string {
  // a field is one box however it is referenced (name, this.name, Class.name)
  if ((v.scope === "field" || v.scope === "static") && v.declaredIn) return `var:${v.declaredIn}`;
  return `var:${v.scope === "captured" ? "captured" : v.scope === "field" || v.scope === "static" ? "class" : "module"}:${v.declaredIn ?? ""}:${v.name}`;
}

export function variableBox(v: Variable, group?: string): VNode {
  // a final field still holds a changeable object; only shared finals are constants
  const what = !v.final ? SCOPE_TEXT[v.scope]
    : v.scope === "field" || v.scope === "captured" ? `${SCOPE_TEXT[v.scope]} · final` : `${SCOPE_TEXT[v.scope]} · constant`;
  return {
    id: variableId(v), ref: v.declaredIn?.startsWith("field:") ? v.declaredIn : undefined,
    label: v.name, sub: v.type ? `${v.type} · ${what}` : what, shape: "variable", group,
  };
}

export function homeGroup(h: Home, parent?: string): VGroup {
  return { id: h.id, label: h.label, sub: h.sub, kind: "scope", parent, keep: true };
}

/**
 * Edges between an outside variable and the steps that use it: variable → step for reads,
 * step → variable for writes. A use is pinned to the last step starting at or before its line.
 */
export function variableEdges(v: Variable, steps: { id: string; lines?: number[] }[], fallback: string, idOf = variableId): VEdge[] {
  const marks = steps.flatMap((s) => (s.lines ?? []).map((line) => ({ line, id: s.id }))).sort((a, b) => a.line - b.line);
  const at = (line: number) => {
    // on a tie (if (x) throw ...; on one line) the first step there, the one enclosing the others
    let hit: { line: number; id: string } | undefined;
    for (const x of marks) {
      if (x.line > line) break;
      if (!hit || x.line > hit.line) hit = x;
    }
    return hit?.id ?? fallback;
  };
  const vid = idOf(v);
  const writes = new Set((v.writeLines ?? []).map(at));
  const reads = new Set((v.lines ?? [v.line ?? 0]).filter((l) => !(v.writeLines ?? []).includes(l)).map(at));
  if (!v.lines?.length && v.writes) writes.add(fallback);
  if (!v.lines?.length && v.reads) reads.add(fallback);
  const out: VEdge[] = [];
  for (const s of reads) out.push({ id: `${vid}>uses>${s}`, source: vid, target: s, style: "uses", label: "reads", count: 1 });
  for (const s of writes) out.push({ id: `${s}>sets>${vid}`, source: s, target: vid, style: "sets", label: "changes", count: 1 });
  return out;
}

/** The function's own parameters and locals, one row each, with their scope. */
export function ownVariableRows(fn: GraphNode): Row[] {
  return variablesOf(fn).filter((v) => !OUTSIDE.has(v.scope)).slice(0, 14).map((v) => ({
    marker: SCOPE_MARK[v.scope],
    text: `${v.name}${v.type ? `: ${v.type}` : ""} — ${SCOPE_TEXT[v.scope]}${v.final ? " (const)" : ""}`,
    muted: v.scope === "local",
  }));
}

/** Plain-language summary of a function, from its doc comment, signature, effects and shape. */
export function whatItDoes(m: Model, fn: GraphNode): Row[] {
  const rows: Row[] = [];
  const doc = fn.attrs?.doc as string | undefined;
  if (doc) rows.push({ marker: "“", text: doc.length > 120 ? doc.slice(0, 117) + "…" : doc });
  for (const e of m.in.get(fn.id) ?? []) {
    const ep = m.node(e.source);
    if (e.kind === "handles" && ep) rows.push({ marker: "⇥", text: `handles ${ep.name}` });
  }
  const entry = fn.attrs?.entryPoint as string | undefined;
  if (entry) rows.push({ marker: "⇥", text: `starts work on its own (${entry})` });
  const params = (fn.attrs?.params as { name: string; type: string }[] | undefined) ?? [];
  if (params.length) rows.push({ marker: "in", text: `takes ${params.map((p) => `${p.name}: ${p.type}`).join(", ")}` });
  const ret = fn.attrs?.returnType as string | undefined;
  if (ret && ret !== "void" && ret !== "Promise<void>") rows.push({ marker: "out", text: `returns ${ret}` });

  const names = (kind: string) => [...new Set((m.out.get(fn.id) ?? []).filter((e) => e.kind === kind)
    .map((e) => m.node(e.target)?.name).filter(Boolean) as string[])];
  const list = (xs: string[]) => (xs.length > 3 ? `${xs.slice(0, 3).join(", ")} +${xs.length - 3}` : xs.join(", "));
  const io: [string, string, string][] = [
    ["reads", "⛁", "reads"], ["writes", "⛁", "writes"], ["publishes", "⇶", "publishes to"],
    ["consumes", "⇶", "consumes from"], ["http_calls", "⇄", "calls"], ["connects_to", "⇄", "connects to"],
  ];
  for (const [kind, marker, verb] of io) {
    const xs = names(kind);
    if (xs.length) rows.push({ marker, text: `${verb} ${list(xs)}` });
  }
  const callees = names("calls");
  if (callees.length) rows.push({ marker: "→", text: `uses ${list(callees)}` });
  const outside = variablesOf(fn).filter((v) => OUTSIDE.has(v.scope));
  const changed = outside.filter((v) => v.writes > 0).map((v) => v.name);
  if (changed.length && (fn.attrs as Record<string, unknown> | undefined)?.["constructor"] === true) rows.push({ marker: "◆", text: `sets up ${list(changed)}` });
  else if (changed.length) rows.push({ marker: "!", text: `changes state outside it: ${list(changed)}` });
  const shape = shapeOf(controlFlowOf(fn) ?? []);
  if (shape) rows.push({ marker: "?", text: shape, muted: true });
  if (!rows.length) rows.push({ text: "no effects found", muted: true });
  return rows;
}

/** "2 decisions, 1 loop, can fail" from the control flow. */
function shapeOf(steps: Step[]): string {
  let decisions = 0;
  let loops = 0;
  let throws = 0;
  let catches = 0;
  const walk = (xs: Step[] | undefined) => {
    for (const s of xs ?? []) {
      if (s.k === "if" || s.k === "switch") decisions++;
      if (s.k === "loop") loops++;
      if (s.k === "throw") throws++;
      catches += s.catches?.length ?? 0;
      walk(s.then);
      walk(s.else);
      walk(s.body);
      walk(s.finally);
      for (const c of s.cases ?? []) walk(c.body);
      for (const c of s.catches ?? []) walk(c.body);
    }
  };
  walk(steps);
  const parts = [
    decisions && `${decisions} decision${decisions > 1 ? "s" : ""}`,
    loops && `${loops} loop${loops > 1 ? "s" : ""}`,
    throws && `can fail (${throws} throw${throws > 1 ? "s" : ""})`,
    catches && `handles ${catches} error type${catches > 1 ? "s" : ""}`,
  ].filter(Boolean);
  return parts.join(", ");
}
