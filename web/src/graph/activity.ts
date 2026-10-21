// UML activity diagram for one function, from its attrs.controlFlow: start → actions →
// decisions (if / switch / loop heads) with guarded branches, back edges for loops,
// try/catch branches, and end nodes for returns and throws.
import type { GraphNode } from "../api";
import { Model, locationText } from "./model";
import { withReading } from "./reading";
import { callableLabel } from "./views";
import type { Row, VEdge, VGroup, VNode, ViewModel } from "./views";
import { homeGroup, homeOf, OUTSIDE, ownVariableRows, variableBox, variableEdges, variablesOf, whatItDoes } from "./variables";

export interface CallStep {
  kind: string; // calls | reads | writes | publishes | consumes | http_calls
  target: string;
  name: string;
  text?: string;
  line?: number;
  when?: string;
  method?: string;
  httpMethod?: string;
  path?: string;
  /** Runs on another thread: "thread", "scheduled", "executor", "shutdown". */
  async?: string;
}

export interface Item {
  text: string;
  line?: number;
  calls?: CallStep[];
}

export interface Step {
  k: "do" | "if" | "switch" | "loop" | "try" | "return" | "throw" | "jump" | "sync" | "block";
  line?: number;
  items?: Item[];
  cond?: string;
  then?: Step[];
  else?: Step[];
  on?: string;
  cases?: { label: string; body: Step[] }[];
  kind?: string;
  text?: string;
  body?: Step[];
  catches?: { type: string; body: Step[] }[];
  finally?: Step[];
  calls?: CallStep[];
}

export function controlFlowOf(n: GraphNode | undefined): Step[] | undefined {
  return n?.attrs?.controlFlow as Step[] | undefined;
}

const IO_MARK: Record<string, string> = {
  reads: "⛁", writes: "⛁", publishes: "⇶", consumes: "⇶", http_calls: "⇄", connects_to: "⇄", calls: "→",
};

/** Dangling outgoing connection: from a node, with an optional edge label. */
interface Exit {
  from: string;
  label?: string;
  style?: VEdge["style"];
}

interface Ctx {
  loopHead?: string;
  breaks?: Exit[];
}

const MAX_NODES = 250;

class ActivityBuilder {
  nodes: VNode[] = [];
  edges: VEdge[] = [];
  groups: VGroup[] = [];
  private seq = 0;
  /** Region (loop / try / catch body) new nodes are created in. */
  private region?: string;

  constructor(private m: Model, region?: string) {
    this.region = region;
  }

  node(n: Omit<VNode, "id">): string {
    const id = `act:${this.seq++}`;
    this.nodes.push({ ...n, id, group: this.region });
    return id;
  }

  /** Runs `build` with new nodes placed inside a labelled region box. */
  inRegion<T>(label: string, build: () => T): T {
    const id = `act:region:${this.seq++}`;
    this.groups.push({ id, label: short(label, 60), kind: "region", parent: this.region });
    const outer = this.region;
    this.region = id;
    try {
      return build();
    } finally {
      this.region = outer;
    }
  }

  /**
   * Leading guard clauses (`if (bad) throw/return`) folded into one "checks" block with an
   * "all pass" path and an "any fails" exit. Returns how many steps were folded.
   */
  checks(steps: Step[], entry: Exit[]): { consumed: number; exits: Exit[] } {
    const isGuard = (s: Step) => s.k === "if" && !s.else?.length && !!s.then?.length && s.then.length <= 2
      && ["throw", "return"].includes(s.then[s.then.length - 1].k);
    let n = 0;
    while (n < steps.length && isGuard(steps[n])) n++;
    if (n < 2) return { consumed: 0, exits: entry };
    const guards = steps.slice(0, n);
    const id = this.node({
      label: `checks (${n})`,
      shape: "action",
      sections: [guards.map((g) => ({ marker: "?", text: short(g.cond ?? "", 60) }))],
      sub: guards[0].line ? `lines ${guards[0].line}–${guards[n - 1].line}` : undefined,
      lines: guards.map((g) => g.line).filter((l): l is number => !!l),
    });
    this.connect(entry, id);
    const throws = guards.some((g) => g.then![g.then!.length - 1].k === "throw");
    const fail = this.node({
      label: throws ? "rejected (throw)" : "early return",
      shape: throws ? "throw" : "end",
      sections: [guards.map((g) => ({ text: short(g.then![g.then!.length - 1].text ?? g.then![g.then!.length - 1].k, 50), muted: true }))],
    });
    this.connect([{ from: id, label: "any fails", style: "error" }], fail);
    return { consumed: n, exits: [{ from: id, label: "all pass" }] };
  }

  connect(exits: Exit[], to: string) {
    for (const e of exits) {
      this.edges.push({
        id: `${e.from}->${to}#${this.edges.length}`,
        source: e.from,
        target: to,
        style: e.style ?? "call",
        label: e.label,
        count: 1,
        conditional: e.style === "error",
      });
    }
  }

  /** Builds steps after `entry`; returns the exits that fall through the end of the block. */
  block(steps: Step[], entry: Exit[], ctx: Ctx): Exit[] {
    let exits = entry;
    for (const s of steps) {
      if (!exits.length || this.nodes.length > MAX_NODES) break; // unreachable after return/throw/break
      exits = this.step(s, exits, ctx);
    }
    return exits;
  }

  private step(s: Step, entry: Exit[], ctx: Ctx): Exit[] {
    switch (s.k) {
      case "do": {
        const id = this.action(s.items ?? []);
        this.connect(entry, id);
        return [{ from: id }];
      }
      case "block":
        return this.block(s.body ?? [], entry, ctx);
      case "if": {
        const d = this.decision(`${s.cond}?`, s);
        this.connect(entry, d);
        const thenExits = this.block(s.then ?? [], [{ from: d, label: "yes" }], ctx);
        const elseExits = s.else?.length ? this.block(s.else, [{ from: d, label: "no" }], ctx) : [{ from: d, label: "no" }];
        return [...thenExits, ...elseExits];
      }
      case "switch": {
        const d = this.decision(`switch ${s.on}`, s);
        this.connect(entry, d);
        const sw: Ctx = { ...ctx, breaks: [] };
        const exits: Exit[] = [];
        for (const c of s.cases ?? []) {
          exits.push(...this.block(c.body, [{ from: d, label: c.label }], sw));
        }
        if (!(s.cases ?? []).some((c) => c.label === "default")) exits.push({ from: d, label: "other" });
        return [...exits, ...(sw.breaks ?? [])];
      }
      case "loop": {
        const head = this.decision(s.text ?? "loop", s, "loop");
        this.connect(entry, head);
        const lp: Ctx = { loopHead: head, breaks: [] };
        const bodyExits = this.inRegion(`loop · ${s.text ?? ""}`, () =>
          this.block(s.body ?? [], [{ from: head, label: s.kind === "foreach" ? "next" : "yes" }], lp));
        this.connect(bodyExits.map((e) => ({ ...e, style: "back" })), head);
        return [{ from: head, label: s.kind === "foreach" ? "done" : "no" }, ...(lp.breaks ?? [])];
      }
      case "try": {
        const { t, exits } = this.inRegion("try", () => {
          const t = this.node({ label: "try", sub: s.line ? `line ${s.line}` : undefined, shape: "action", lines: lineOf(s) });
          this.connect(entry, t);
          return { t, exits: this.block(s.body ?? [], [{ from: t }], ctx) };
        });
        for (const c of s.catches ?? []) {
          exits.push(...this.inRegion(`catch ${c.type}`, () => this.block(c.body, [{ from: t, label: `on ${c.type}`, style: "error" }], ctx)));
        }
        return s.finally?.length ? this.inRegion("finally", () => this.block(s.finally!, exits, ctx)) : exits;
      }
      case "sync": {
        const id = this.node({ label: s.text ?? "synchronized", shape: "action", lines: lineOf(s) });
        this.connect(entry, id);
        return this.block(s.body ?? [], [{ from: id }], ctx);
      }
      case "return": {
        const calls = s.calls ?? [];
        let from = entry;
        if (calls.length) {
          // the returned expression does work: show it as an action, then a plain end
          const id = this.action([{ text: `return ${s.text ?? ""}`, line: s.line, calls }]);
          this.connect(from, id);
          from = [{ from: id }];
        }
        const end = this.node({ label: s.text && !calls.length ? `return ${short(s.text)}` : "return", shape: "end",
          lines: calls.length ? undefined : lineOf(s) });
        this.connect(from, end);
        return [];
      }
      case "throw": {
        const end = this.node({ label: `throw ${short(s.text ?? "")}`, shape: "throw", lines: lineOf(s) });
        this.connect(entry, end);
        return [];
      }
      case "jump":
        if (s.text === "continue" && ctx.loopHead) this.connect(entry.map((e) => ({ ...e, style: "back" })), ctx.loopHead);
        else if (ctx.breaks) ctx.breaks.push(...entry);
        return [];
    }
    return entry;
  }

  private decision(label: string, s: Step, kind: "if" | "loop" = "if"): string {
    const calls = s.calls ?? [];
    const sub = calls.filter((c) => c.kind !== "calls").map((c) => `${IO_MARK[c.kind]} ${c.name}`).join(", ");
    const refs = this.callees(calls);
    return this.node({
      label: short(label, 70), sub: sub || (kind === "loop" ? "loop" : undefined), shape: "decision", ref: firstRef(calls),
      refs, enterable: refs.length > 0, touches: touches(calls), lines: lineOf(s),
    });
  }

  /** In-repo functions with a body that these calls run (for stepping into them). */
  private callees(calls: CallStep[]): { id: string; label: string }[] {
    const out: { id: string; label: string }[] = [];
    for (const c of calls) {
      const id = c.kind === "calls" ? c.target : c.method; // I/O through an in-repo wrapper method
      const n = id ? this.m.node(id) : undefined;
      if (!n || isAccessor(this.m, n.id) || !controlFlowOf(n)?.length || out.some((x) => x.id === n.id)) continue;
      out.push({ id: n.id, label: callableLabel(this.m, n) });
    }
    return out;
  }

  private action(items: Item[], title?: string): string {
    const rows: Row[] = [];
    for (const it of items.slice(0, 8)) {
      const calls = it.calls ?? [];
      const io = calls.find((c) => c.kind !== "calls");
      const local = calls.find((c) => c.kind === "calls" && !isAccessor(this.m, c.target));
      const guarded = calls.find((c) => c.when);
      rows.push({
        marker: io ? IO_MARK[io.kind] : local?.async ? "⇉" : local ? "→" : "",
        text: short(it.text, 64) + (guarded ? `   [${guarded.when}]` : ""),
      });
    }
    if (items.length > 8) rows.push({ text: `… ${items.length - 8} more`, muted: true });
    const allCalls = items.flatMap((i) => i.calls ?? []);
    const refs = this.callees(allCalls);
    return this.node({
      label: title ?? "",
      shape: "action",
      sections: [rows],
      ref: firstRef(allCalls.filter((c) => !isAccessor(this.m, c.target))),
      sub: items[0]?.line ? `line ${items[0].line}` : undefined,
      refs,
      enterable: refs.length > 0,
      touches: touches(allCalls),
      lines: items.map((i) => i.line).filter((l): l is number => !!l),
    });
  }
}

/** I/O targets of these calls (tables, topics, external systems), once each. */
function touches(calls: CallStep[]): { target: string; kind: string }[] | undefined {
  const out: { target: string; kind: string }[] = [];
  for (const c of calls) {
    if (c.kind !== "calls" && !out.some((t) => t.target === c.target && t.kind === c.kind)) out.push({ target: c.target, kind: c.kind });
  }
  return out.length ? out : undefined;
}

function lineOf(s: Step): number[] | undefined {
  return s.line ? [s.line] : undefined;
}

function short(s: string, n = 48) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function firstRef(calls: CallStep[]): string | undefined {
  return calls.find((c) => c.kind !== "calls")?.target ?? calls.find((c) => c.kind === "calls")?.target;
}

/** Trivial getters/setters: no control flow of their own beyond a single statement. */
export function isAccessor(m: Model, id: string): boolean {
  const n = m.node(id);
  if (!n || !/^(get|set|is|has)[A-Z]/.test(n.name)) return false;
  const cf = controlFlowOf(n);
  return !cf || (cf.length === 1 && !(cf[0].calls?.length || cf[0].items?.some((i) => i.calls?.length)));
}

/** The box around a function's own steps; what it uses from outside sits beside it. */
export const FN_BOX = "act:fn";

/**
 * Activity diagram of a function: its steps inside a box named after it, the start box saying
 * what it does and listing its own parameters and locals, and (unless `outside` is false)
 * the fields, statics, module variables and captured variables it uses as separate boxes
 * outside, grouped by where they are declared and linked to the steps that read or change them.
 */
export function activityView(m: Model, fnId: string, opts: { outside?: boolean } = {}): ViewModel {
  const fn = m.node(fnId);
  const cf = controlFlowOf(fn);
  if (!fn || !cf?.length) {
    return { nodes: [], edges: [], direction: "DOWN", empty: fn ? `${fn.name} has no body to chart.` : "Pick a function or method." };
  }
  const b = new ActivityBuilder(m, FN_BOX);
  const owner = fn.parent ? m.node(fn.parent) : undefined;
  const label = `${owner && owner.kind !== "package" ? owner.name + "." : ""}${fn.name}`;
  const own = ownVariableRows(fn);
  const start = b.node({
    label, sub: locationText(fn), shape: "start", ref: fnId,
    sections: [whatItDoes(m, fn), ...(own.length ? [own] : [])],
  });
  const checked = b.checks(cf, [{ from: start }]);
  const exits = b.block(cf.slice(checked.consumed), checked.exits, {});
  if (exits.length) {
    const end = b.node({ label: "end", shape: "end" });
    b.connect(exits, end);
  }
  const groups: VGroup[] = [{ id: FN_BOX, label: callableLabel(m, fn), sub: "defined here", kind: "function", keep: true }, ...b.groups];
  // the function's steps as an outline, top to bottom like its code
  const view: ViewModel = withReading({ nodes: b.nodes, edges: b.edges, direction: "DOWN", groups, budget: 150 },
    { title: `${label} · steps`, number: false, isPart: (n) => !["start", "end", "variable"].includes(n.shape) && !n.faded });
  if (opts.outside !== false) attachOutside(m, fn, view, start);
  return view;
}

/** Variables declared outside the function, as boxes beside it linked to the steps using them. */
function attachOutside(m: Model, fn: GraphNode, view: ViewModel, start: string) {
  const steps = view.nodes.filter((n) => n.lines?.length);
  const homes = new Map<string, VGroup>();
  for (const v of variablesOf(fn)) {
    if (!OUTSIDE.has(v.scope)) continue;
    const home = homeOf(m, v);
    if (!homes.has(home.id)) homes.set(home.id, homeGroup(home));
    view.nodes.push(variableBox(v, home.id));
    view.edges.push(...variableEdges(v, steps, start));
  }
  view.groups!.push(...homes.values());
}

/** Functions and methods that have a charted body, for the pickers. */
export function chartableFunctions(m: Model): GraphNode[] {
  return m.graph.nodes.filter((n) => (n.kind === "method" || n.kind === "function") && controlFlowOf(n)?.length);
}
