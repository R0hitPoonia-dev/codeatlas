// PlantUML export: structured activity diagrams straight from control flow, sequence
// diagrams with fragments, C4-PlantUML for the context diagram, class / entity diagrams for
// the class and data-model views, and component diagrams (groups as nested boxes) for the rest.
import { controlFlowOf, Item, Step } from "./activity";
import { nearest, usefulGroups } from "./groups";
import type { ViewKind } from "./mermaid";
import { Model } from "./model";
import type { Sequence, SeqItem } from "./sequence";
import type { VEdge, VGroup, VNode, ViewModel } from "./views";

/** Text safe inside quotes, action boxes and labels. */
function clean(s: string, max = 120): string {
  // a trailing ";" would end a PlantUML action early; inner ones become ","
  const t = s.replace(/;\s*$/, "").replace(/"/g, "'").replace(/;/g, ",").replace(/[\r\n]+/g, " ").replace(/</g, "‹").replace(/>/g, "›").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

function wrap(lines: string[]): string {
  return ["@startuml", ...lines, "@enduml", ""].join("\n");
}

// ------------------------------------------------------------------ views

export function toPlantUml(kind: ViewKind, view: ViewModel): string {
  if (kind === "classes") return classDiagram(view);
  if (kind === "er") return entityDiagram(view);
  if (kind === "dataflow" && view.nodes.some((n) => n.id === "dfd:system")) return c4Context(view);
  return components(view);
}

const ELEMENT: Record<string, string> = {
  database: "database", table: "database", store: "database",
  topic: "queue", queue: "queue",
  external: "cloud", ingress: "cloud", entity: "rectangle",
  process: "usecase", endpoint: "interface", package: "folder",
};

const ARROW: Record<string, string> = {
  back: "..>", error: "..>", depends: "..>", deploy: "..>", implements: "..|>", extends: "--|>", http: "==>",
};

function components(view: ViewModel): string {
  const id = new Map(view.nodes.map((n, i) => [n.id, `n${i}`]));
  const lines = [view.direction === "DOWN" ? "top to bottom direction" : "left to right direction", "skinparam shadowing false"];
  const kept = usefulGroups(view);
  const all = new Map((view.groups ?? []).map((g) => [g.id, g]));
  const nodesIn = new Map<string | undefined, VNode[]>();
  const groupsIn = new Map<string | undefined, VGroup[]>();
  for (const n of view.nodes) {
    const g = nearest(n.group, kept, all);
    nodesIn.set(g, [...(nodesIn.get(g) ?? []), n]);
  }
  for (const g of kept.values()) {
    const p = nearest(g.parent, kept, all);
    groupsIn.set(p, [...(groupsIn.get(p) ?? []), g]);
  }
  const emit = (scope: string | undefined, indent: string) => {
    for (const n of nodesIn.get(scope) ?? []) {
      const rows = (n.sections ?? []).flat().slice(0, 20).map((r) => `${r.marker ? r.marker + " " : ""}${r.text.replace(/\u00a0/g, " ")}`);
      const label = [n.label, n.sub, ...rows].filter(Boolean).map((t) => clean(t!, 80)).join("\\n");
      const stereo = n.shape === "entity" ? " <<external>>" : n.faded ? " <<other>>" : "";
      lines.push(`${indent}${ELEMENT[n.shape] ?? "rectangle"} "${label || " "}" as ${id.get(n.id)}${stereo}`);
    }
    for (const g of groupsIn.get(scope) ?? []) {
      lines.push(`${indent}rectangle "${clean(g.label, 80)}" {`);
      emit(g.id, indent + "  ");
      lines.push(`${indent}}`);
    }
  };
  emit(undefined, "");
  for (const e of view.edges) lines.push(edgeLine(e, id));
  return wrap(lines);
}

function edgeLine(e: VEdge, id: Map<string, string>): string {
  const s = id.get(e.source);
  const t = id.get(e.target);
  if (!s || !t) return "";
  const label = [e.label, e.sublabel].filter(Boolean).map((x) => clean(x!, 60)).join("\\n");
  return `${s} ${ARROW[e.style] ?? "-->"} ${t}${label ? ` : ${label}` : ""}`;
}

/** C4-PlantUML System Context: people, the system, external systems and shared queues. */
function c4Context(view: ViewModel): string {
  const id = new Map(view.nodes.map((n, i) => [n.id, `e${i}`]));
  const lines = ["!include <C4/C4_Context>", "LAYOUT_LEFT_RIGHT()"];
  const sys = view.nodes.find((n) => n.id === "dfd:system");
  if (sys) lines.push(`title System context: ${clean(sys.label)}`);
  for (const n of view.nodes) {
    const name = clean(n.label);
    const desc = n.sub ? clean(n.sub) : "";
    const x = id.get(n.id);
    if (n.id === "dfd:system") lines.push(`System(${x}, "${name}", "all services and their data stores")`);
    else if (n.id === "dfd:client") lines.push(`Person(${x}, "${name}", "${desc}")`);
    else if (n.shape === "store") lines.push(`SystemQueue_Ext(${x}, "${name}", "${desc}")`);
    else lines.push(`System_Ext(${x}, "${name}", "${desc}")`);
  }
  for (const e of view.edges) {
    const s = id.get(e.source);
    const t = id.get(e.target);
    if (!s || !t) continue;
    lines.push(`Rel(${s}, ${t}, "${clean(e.label ?? "data", 60)}"${e.sublabel ? `, "${clean(e.sublabel, 60)}"` : ""})`);
  }
  return wrap(lines);
}

function classDiagram(view: ViewModel): string {
  const id = new Map(view.nodes.map((n, i) => [n.id, `c${i}`]));
  const lines = ["skinparam classAttributeIconSize 0", "hide empty members"];
  for (const n of view.nodes) {
    const stereo = n.stereotype ? ` <<${clean(n.stereotype)}>>` : "";
    lines.push(`class "${clean(n.label)}" as ${id.get(n.id)}${stereo} {`);
    (n.sections ?? []).forEach((section, i) => {
      if (i > 0) lines.push("  --");
      for (const r of section) {
        if (r.muted && r.text.startsWith("…")) continue;
        lines.push(`  ${r.marker ?? ""}${clean(r.text, 100)}${r.muted ? " {static}" : ""}`);
      }
    });
    lines.push("}");
  }
  for (const e of view.edges) {
    const s = id.get(e.source);
    const t = id.get(e.target);
    if (!s || !t) continue;
    const rel = e.style === "extends" ? `${s} --|> ${t}` : e.style === "implements" ? `${s} ..|> ${t}` : `${s} --> ${t}`;
    lines.push(e.label ? `${rel} : ${clean(e.label, 60)}` : rel);
  }
  return wrap(lines);
}

function entityDiagram(view: ViewModel): string {
  const id = new Map(view.nodes.map((n, i) => [n.id, `t${i}`]));
  const lines = ["hide circle", "skinparam linetype ortho"];
  for (const n of view.nodes) {
    lines.push(`entity "${clean(n.label)}" as ${id.get(n.id)} {`);
    const rows = n.sections?.[0] ?? [];
    const keys = rows.filter((r) => r.marker === "PK");
    for (const r of keys) lines.push(`  * ${clean(r.text)} <<PK>>`);
    if (keys.length) lines.push("  --");
    for (const r of rows.filter((x) => x.marker !== "PK")) {
      lines.push(`  ${clean(r.text)}${r.marker ? ` <<${r.marker}>>` : ""}`);
    }
    lines.push("}");
  }
  for (const e of view.edges) {
    const s = id.get(e.source);
    const t = id.get(e.target);
    if (!s || !t) continue;
    const card = e.label?.startsWith("1 : 1") ? "|o--||" : e.label?.startsWith("N : M") ? "}o--o{" : "}o--||";
    const col = e.label?.replace(/^[N1M :]+/, "").trim();
    lines.push(`${s} ${card} ${t}${col ? ` : ${clean(col, 40)}` : ""}`);
  }
  return wrap(lines);
}

// ------------------------------------------------------------------ activity

const IO_MARK: Record<string, string> = {
  reads: "⛁ ", writes: "⛁ ", publishes: "⇶ ", consumes: "⇶ ", http_calls: "⇄ ",
};

/** PlantUML activity diagram (new syntax) for one function's control flow. */
export function activityToPlantUml(m: Model, fnId: string): string {
  const fn = m.node(fnId);
  const cf = controlFlowOf(fn);
  if (!fn || !cf?.length) return wrap([`note "${fn ? clean(fn.name) : "function"} has no body to chart" as N`]);
  const owner = fn.parent ? m.node(fn.parent) : undefined;
  const lines = [`title ${clean(`${owner && owner.kind !== "package" ? owner.name + "." : ""}${fn.name}`)}`, "start"];
  const ended = block(cf, lines, "");
  if (!ended) lines.push("stop");
  return wrap(lines);
}

/** Emits steps; returns true when the block always ends (return/throw) so nothing follows. */
function block(steps: Step[], out: string[], ind: string): boolean {
  for (const s of steps) {
    if (step(s, out, ind)) return true;
  }
  return false;
}

function action(items: Item[], out: string[], ind: string) {
  const rows = items.slice(0, 8).map((it) => {
    const io = (it.calls ?? []).find((c) => c.kind !== "calls");
    return `${io ? IO_MARK[io.kind] ?? "" : ""}${clean(it.text, 90)}`;
  });
  if (items.length > 8) rows.push(`… ${items.length - 8} more`);
  out.push(`${ind}:${rows.join("\n" + ind + " ") || " "};`);
}

function step(s: Step, out: string[], ind: string): boolean {
  const inner = ind + "  ";
  switch (s.k) {
    case "do":
      action(s.items ?? [], out, ind);
      return false;
    case "block":
      return block(s.body ?? [], out, ind);
    case "if": {
      out.push(`${ind}if (${clean(s.cond ?? "?", 90)}?) then (yes)`);
      const a = block(s.then ?? [], out, inner);
      let b = false;
      if (s.else?.length) {
        out.push(`${ind}else (no)`);
        b = block(s.else, out, inner);
      }
      out.push(`${ind}endif`);
      return a && b;
    }
    case "switch": {
      out.push(`${ind}switch (${clean(s.on ?? "?", 80)})`);
      for (const c of s.cases ?? []) {
        out.push(`${ind}case (${clean(c.label, 40)})`);
        block(c.body, out, inner);
      }
      out.push(`${ind}endswitch`);
      return false;
    }
    case "loop": {
      const label = clean(s.text ?? "loop", 90);
      out.push(`${ind}while (${label}) is (${s.kind === "foreach" ? "next" : "yes"})`);
      block(s.body ?? [], out, inner);
      out.push(`${ind}endwhile (${s.kind === "foreach" ? "done" : "no"})`);
      return false;
    }
    case "try": {
      out.push(`${ind}partition "try" {`);
      const ends = block(s.body ?? [], out, inner);
      out.push(`${ind}}`);
      for (const c of s.catches ?? []) {
        out.push(`${ind}partition "catch ${clean(c.type, 60)}" {`);
        block(c.body, out, inner);
        out.push(`${ind}}`);
      }
      if (s.finally?.length) {
        out.push(`${ind}partition "finally" {`);
        block(s.finally, out, inner);
        out.push(`${ind}}`);
      }
      return ends && !(s.catches ?? []).length && !s.finally?.length;
    }
    case "sync":
      out.push(`${ind}partition "${clean(s.text ?? "synchronized", 60)}" {`);
      block(s.body ?? [], out, inner);
      out.push(`${ind}}`);
      return false;
    case "return":
      out.push(`${ind}:return${s.text ? " " + clean(s.text, 80) : ""};`);
      out.push(`${ind}stop`);
      return true;
    case "throw":
      out.push(`${ind}:throw ${clean(s.text ?? "", 80)};`);
      out.push(`${ind}end`);
      return true;
    case "jump":
      out.push(s.text === "break" ? `${ind}break` : `${ind}:${clean(s.text ?? "jump")};`);
      return false;
  }
  return false;
}

// ------------------------------------------------------------------ sequence

const PARTICIPANT: Record<string, string> = {
  actor: "actor", database: "database", topic: "queue", external: "boundary", service: "participant",
  class: "participant", module: "participant",
};

/** PlantUML sequence diagram with service boxes and alt / opt / loop / critical groups. */
export function sequenceToPlantUml(seq: Sequence): string {
  const id = new Map(seq.participants.map((p, i) => [p.id, `p${i}`]));
  const lines = ["autonumber", "skinparam responseMessageBelowArrow true"];
  let open: string | undefined;
  for (const p of seq.participants) {
    const group = p.kind === "actor" ? undefined : p.group;
    if (group !== open) {
      if (open !== undefined) lines.push("end box");
      if (group !== undefined) lines.push(`box "${clean(group)}"`);
      open = group;
    }
    lines.push(`${PARTICIPANT[p.kind] ?? "participant"} "${clean(p.label)}" as ${id.get(p.id)}`);
  }
  if (open !== undefined) lines.push("end box");
  const ARROWS = { call: "->", io: "->", async: "->>", return: "-->" } as const;
  const walk = (items: SeqItem[], ind: string) => {
    for (const it of items) {
      if (it.k === "msg") {
        lines.push(`${ind}${id.get(it.from)} ${ARROWS[it.style]} ${id.get(it.to)} : ${clean(it.label, 80) || " "}`);
      } else if (it.k === "note") {
        lines.push(`${ind}note over ${id.get(it.over)} : ${clean(it.text, 80)}`);
      } else {
        it.sections.forEach((s, i) => {
          const kw = i === 0 ? (it.type === "critical" ? "critical" : it.type) : "else";
          lines.push(`${ind}${kw} ${clean(s.label, 80)}`);
          walk(s.items, ind + "  ");
        });
        lines.push(`${ind}end`);
      }
    }
  };
  walk(seq.items, "");
  return wrap(lines);
}
