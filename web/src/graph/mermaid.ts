// Mermaid export for every view: flowcharts for architecture-style views,
// classDiagram for classes and erDiagram for tables.
import { nearest, usefulGroups } from "./groups";
import type { Sequence, SeqItem } from "./sequence";
import type { VEdge, VGroup, VNode, ViewModel } from "./views";

export type ViewKind = "architecture" | "dataflow" | "program" | "components" | "classes" | "er" | "deployment" | "flow" | "activity";

export function toMermaid(kind: ViewKind, view: ViewModel): string {
  if (kind === "classes") return classDiagram(view);
  if (kind === "er") return erDiagram(view);
  return flowchart(view);
}

function ids(view: ViewModel) {
  const m = new Map<string, string>();
  view.nodes.forEach((n, i) => m.set(n.id, `n${i}`));
  return m;
}

/** Escape text for use inside a quoted Mermaid label. */
function esc(s: string) {
  return s.replace(/"/g, "#quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function q(s: string) {
  return `"${esc(s)}"`;
}

function shape(n: VNode, label: string): string {
  switch (n.shape) {
    case "database":
    case "table":
      return `[(${label})]`;
    case "topic":
    case "queue":
      return `>${label}]`;
    case "external":
    case "ingress":
      return `{{${label}}}`;
    case "endpoint":
      return `([${label}])`;
    case "package":
      return `[/${label}/]`;
    case "function":
      return `(${label})`;
    case "process":
      return `([${label}])`;
    case "store":
      return `[(${label})]`;
    case "entity":
      return `[${label}]`;
    case "start":
    case "end":
    case "throw":
      return `([${label}])`;
    case "decision":
      return `{${label}}`;
    case "action":
      return `[${label}]`;
    default:
      return `[${label}]`;
  }
}

const ARROW: Record<string, string> = {
  back: "-.->", error: "-.->",
  call: "-->", http: "==>", data: "-->", publish: "-->", consume: "-->", depends: "-.->",
  deploy: "-.->", connect: "-->", handles: "-->", fk: "-->", extends: "-->", implements: "-.->", association: "-->",
  uses: "-.->", sets: "-.->",
};

function flowchart(view: ViewModel): string {
  const id = ids(view);
  const lines = [`flowchart ${view.direction === "DOWN" ? "TB" : "LR"}`];
  // groups become (nested) subgraphs
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
  const groupIds = new Map([...kept.keys()].map((g, i) => [g, `g${i}`]));
  const emit = (scope: string | undefined, indent: string) => {
    for (const n of nodesIn.get(scope) ?? []) lines.push(`${indent}${id.get(n.id)}${shape(n, nodeLabel(n))}`);
    for (const g of groupsIn.get(scope) ?? []) {
      lines.push(`${indent}subgraph ${groupIds.get(g.id)}["${esc(g.label)}"]`);
      emit(g.id, indent + "  ");
      lines.push(`${indent}end`);
    }
  };
  emit(undefined, "  ");
  for (const e of view.edges) {
    const s = id.get(e.source);
    const t = id.get(e.target);
    if (!s || !t) continue;
    const label = [e.label, e.sublabel].filter(Boolean).join(" · ");
    lines.push(`  ${s} ${ARROW[e.style] ?? "-->"}${label ? `|${q(label)}|` : ""} ${t}`);
  }
  const faded = view.nodes.filter((n) => n.faded).map((n) => id.get(n.id));
  if (faded.length) {
    lines.push("  classDef faded opacity:0.6,stroke-dasharray:4 3");
    lines.push(`  class ${faded.join(",")} faded`);
  }
  return lines.join("\n") + "\n";
}

function nodeLabel(n: VNode): string {
  const icon = n.shape === "start" ? "● " : n.shape === "end" ? "◉ " : n.shape === "throw" ? "⊗ " : "";
  const rows = (n.sections ?? []).flat().map((r) => esc(`${r.marker ? r.marker + " " : ""}${r.text}`));
  const text = [n.label ? icon + esc(n.label) : "", ...rows].filter(Boolean);
  return `"${text.join("<br/>")}${n.sub ? `<br/><small>${esc(n.sub)}</small>` : ""}"`;
}

/** Mermaid class names must be identifiers; generics use ~T~. */
function className(s: string) {
  return s.replace(/[^A-Za-z0-9_]/g, "_");
}

function member(text: string) {
  return text.replace(/</g, "~").replace(/>/g, "~");
}

function classDiagram(view: ViewModel): string {
  const lines = ["classDiagram"];
  for (const n of view.nodes) {
    const name = className(n.label);
    const body: string[] = [];
    if (n.stereotype) body.push(`  <<${n.stereotype}>>`);
    for (const section of n.sections ?? []) {
      for (const r of section) {
        if (r.muted && r.text.startsWith("…")) continue;
        body.push(`  ${r.marker ?? ""}${member(r.text)}${r.muted ? "$" : ""}`);
      }
    }
    lines.push(body.length ? `class ${name} {\n${body.join("\n")}\n}` : `class ${name}`);
  }
  const label = (n?: VNode) => (n ? className(n.label) : "");
  const byId = new Map(view.nodes.map((n) => [n.id, n]));
  for (const e of view.edges) {
    const s = label(byId.get(e.source));
    const t = label(byId.get(e.target));
    if (!s || !t) continue;
    const rel = e.style === "extends" ? `${t} <|-- ${s}` : e.style === "implements" ? `${t} <|.. ${s}` : `${s} --> ${t}`;
    lines.push(e.label ? `${rel} : ${member(e.label)}` : rel);
  }
  return lines.join("\n") + "\n";
}

function erEntity(s: string) {
  return s.replace(/[^A-Za-z0-9_-]/g, "_").toUpperCase();
}

function erDiagram(view: ViewModel): string {
  const lines = ["erDiagram"];
  for (const n of view.nodes) {
    lines.push(`  ${erEntity(n.label)} {`);
    for (const r of n.sections?.[0] ?? []) {
      const [name, type = "unknown"] = r.text.split(/\s+/);
      const key = r.marker === "PK" ? " PK" : r.marker === "FK" ? " FK" : r.marker === "UQ" ? " UK" : "";
      // PK/FK/UK are keywords in erDiagram; a type literally named "fk" must be renamed.
      let t = type.replace(/[^A-Za-z0-9_]/g, "") || "unknown";
      if (/^(pk|fk|uk)$/i.test(t)) t = "ref";
      lines.push(`    ${t} ${name.replace(/[^A-Za-z0-9_]/g, "_")}${key}`);
    }
    lines.push("  }");
  }
  const byId = new Map(view.nodes.map((n) => [n.id, n]));
  const card = (e: VEdge) => (e.label?.startsWith("1 : 1") ? "|o--||" : e.label?.startsWith("N : M") ? "}o--o{" : "}o--||");
  for (const e of view.edges) {
    const s = byId.get(e.source);
    const t = byId.get(e.target);
    if (!s || !t) continue;
    const col = e.label?.replace(/^[N1M :]+/, "").trim() || "references";
    lines.push(`  ${erEntity(s.label)} ${card(e)} ${erEntity(t.label)} : "${col}"`);
  }
  return lines.join("\n") + "\n";
}

// ------------------------------------------------------------------ sequence

/** Mermaid sequenceDiagram with service boxes, alt/opt/loop/critical fragments. */
export function sequenceToMermaid(seq: Sequence): string {
  const id = new Map(seq.participants.map((p, i) => [p.id, `p${i}`]));
  const clean = (s: string) => s.replace(/[;#]/g, " ").replace(/\s+/g, " ").trim();
  const lines = ["sequenceDiagram"];
  let open: string | undefined;
  for (const p of seq.participants) {
    const group = p.kind === "actor" ? undefined : p.group;
    if (group !== open) {
      if (open !== undefined) lines.push("  end");
      if (group !== undefined) lines.push(`  box ${clean(group)}`);
      open = group;
    }
    const kw = p.kind === "actor" ? "actor" : p.kind === "database" ? "participant" : "participant";
    lines.push(`${open !== undefined ? "    " : "  "}${kw} ${id.get(p.id)} as ${clean(p.label)}`);
  }
  if (open !== undefined) lines.push("  end");
  const ARROWS = { call: "->>", io: "->>", async: "-)", return: "-->>" } as const;
  const walk = (items: SeqItem[], indent: string) => {
    for (const it of items) {
      if (it.k === "msg") {
        lines.push(`${indent}${id.get(it.from)}${ARROWS[it.style]}${id.get(it.to)}: ${clean(it.label) || " "}`);
      } else if (it.k === "note") {
        lines.push(`${indent}Note over ${id.get(it.over)}: ${clean(it.text)}`);
      } else {
        const between = it.type === "critical" ? "option" : "else";
        it.sections.forEach((s, i) => {
          lines.push(`${indent}${i === 0 ? it.type : between} ${clean(s.label)}`);
          walk(s.items, indent + "  ");
        });
        lines.push(`${indent}end`);
      }
    }
  };
  walk(seq.items, "  ");
  return lines.join("\n") + "\n";
}
