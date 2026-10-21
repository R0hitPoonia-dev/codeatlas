// Sequence diagram for an endpoint or function, from control flow: lifelines per class
// (or module), data store, topic and remote service; messages for calls; alt / opt / loop /
// critical fragments from the decisions, loops and try blocks around them. HTTP calls into
// another service of the repo continue into that service's handler.
import type { Outline, PartLink } from "./reading";
import type { GraphNode } from "../api";
import { CallStep, controlFlowOf, isAccessor, Step } from "./activity";
import { Model } from "./model";

export interface Participant {
  id: string;
  label: string;
  kind: "actor" | "class" | "module" | "database" | "topic" | "external" | "service";
  /** Service it belongs to, for grouping boxes. */
  group?: string;
  ref?: string;
}

export type SeqItem =
  | { k: "msg"; from: string; to: string; label: string; style: "call" | "io" | "return" | "async"; ref?: string; line?: number }
  | { k: "frag"; type: "alt" | "opt" | "loop" | "critical"; sections: { label: string; items: SeqItem[] }[] }
  | { k: "note"; over: string; text: string };

export interface Sequence {
  participants: Participant[];
  items: SeqItem[];
  truncated: boolean;
  empty?: string;
}

const SERVICES = new Set(["service", "module"]);
const TYPES = new Set(["class", "interface", "enum"]);
const MAX_MESSAGES = 250;

class SeqBuilder {
  participants = new Map<string, Participant>();
  messages = 0;
  truncated = false;

  constructor(private m: Model, private maxDepth: number) {}

  private serviceName(id: string) {
    const apps = this.m.appsOf(id).filter((a) => a.kind === "service");
    if (apps.length === 1) return apps[0].name;
    return this.m.owner(id, SERVICES)?.name;
  }

  /** Lifeline that owns a method/function: its class, else its source file. */
  participantOf(fnId: string): string {
    const fn = this.m.node(fnId);
    const owner = fn?.parent ? this.m.node(fn.parent) : undefined;
    if (owner && TYPES.has(owner.kind)) {
      return this.add({ id: owner.id, label: owner.name, kind: "class", group: this.serviceName(owner.id), ref: owner.id });
    }
    const file = fn?.location?.file ?? fn?.id ?? "unknown";
    return this.add({ id: `file:${file}`, label: file.split("/").pop()!, kind: "module", group: fn ? this.serviceName(fn.id) : undefined });
  }

  resource(id: string): string {
    const n = this.m.node(id);
    if (!n) return this.add({ id, label: id, kind: "external" });
    if (n.kind === "table") {
      const db = this.m.node(n.parent ?? "") ?? n;
      return this.add({ id: db.id, label: db.name, kind: "database", ref: db.id });
    }
    if (n.kind === "topic" || n.kind === "queue") return this.add({ id, label: n.name, kind: "topic", ref: id });
    if (SERVICES.has(n.kind)) return this.add({ id, label: n.name, kind: "service", group: n.name, ref: id });
    return this.add({ id, label: n.name, kind: n.kind === "database" ? "database" : "external", ref: id });
  }

  add(p: Participant): string {
    if (!this.participants.has(p.id)) this.participants.set(p.id, p);
    return p.id;
  }

  msg(items: SeqItem[], from: string, to: string, label: string, style: "call" | "io" | "return" | "async", ref?: string, line?: number) {
    if (this.messages >= MAX_MESSAGES) {
      this.truncated = true;
      return;
    }
    this.messages++;
    items.push({ k: "msg", from, to, label, style, ref, line });
  }

  /** Messages for a function's body as executed by participant `self`. */
  body(fnId: string, self: string, depth: number, stack: string[]): SeqItem[] {
    const cf = controlFlowOf(this.m.node(fnId));
    return cf ? this.steps(cf, fnId, self, depth, [...stack, fnId]) : [];
  }

  private steps(steps: Step[], fnId: string, self: string, depth: number, stack: string[]): SeqItem[] {
    const out: SeqItem[] = [];
    for (const s of steps) {
      if (this.truncated) break;
      out.push(...this.step(s, fnId, self, depth, stack));
    }
    return out;
  }

  private step(s: Step, fnId: string, self: string, depth: number, stack: string[]): SeqItem[] {
    const out: SeqItem[] = [];
    const calls = (cs: CallStep[] | undefined) => {
      for (const c of cs ?? []) out.push(...this.call(c, fnId, self, depth, stack));
    };
    const frag = (type: "alt" | "loop" | "critical", sections: { label: string; items: SeqItem[] }[]) => {
      if (!sections.some((x) => x.items.length)) return; // nothing observable happens inside
      // an alt where only the first branch does anything reads better as opt
      if (type === "alt" && sections.slice(1).every((x) => !x.items.length)) {
        out.push({ k: "frag", type: "opt", sections: [sections[0]] });
      } else {
        out.push({ k: "frag", type, sections });
      }
    };
    switch (s.k) {
      case "do":
        for (const it of s.items ?? []) calls(it.calls);
        break;
      case "block":
      case "sync":
        out.push(...this.steps(s.body ?? [], fnId, self, depth, stack));
        break;
      case "if": {
        calls(s.calls);
        // else-if chains become extra sections of the same alt
        const sections = [{ label: s.cond ?? "", items: this.steps(s.then ?? [], fnId, self, depth, stack) }];
        let els = s.else;
        while (els?.length === 1 && els[0].k === "if") {
          const e = els[0];
          sections.push({ label: `else if ${e.cond}`, items: this.steps(e.then ?? [], fnId, self, depth, stack) });
          els = e.else;
        }
        if (els?.length) sections.push({ label: "else", items: this.steps(els, fnId, self, depth, stack) });
        frag("alt", sections);
        break;
      }
      case "switch":
        calls(s.calls);
        frag("alt", (s.cases ?? []).map((c) => ({ label: `${s.on} = ${c.label}`, items: this.steps(c.body, fnId, self, depth, stack) })));
        break;
      case "loop": {
        calls(s.calls);
        frag("loop", [{ label: s.text ?? "loop", items: this.steps(s.body ?? [], fnId, self, depth, stack) }]);
        break;
      }
      case "try": {
        const sections = [{ label: "try", items: this.steps(s.body ?? [], fnId, self, depth, stack) }];
        for (const c of s.catches ?? []) sections.push({ label: `on ${c.type}`, items: this.steps(c.body, fnId, self, depth, stack) });
        frag("critical", sections);
        out.push(...this.steps(s.finally ?? [], fnId, self, depth, stack));
        break;
      }
      case "return":
        calls(s.calls);
        break;
      case "throw":
        calls(s.calls);
        out.push({ k: "note", over: self, text: `throws ${s.text ?? ""}` });
        break;
    }
    return out;
  }

  /** Message(s) for one call, expanding in-repo callees up to maxDepth. */
  private call(c: CallStep, fnId: string, self: string, depth: number, stack: string[]): SeqItem[] {
    const out: SeqItem[] = [];
    if (c.kind === "calls") {
      if (isAccessor(this.m, c.target)) return out;
      const target = this.m.node(c.target);
      if (!target) return out;
      const to = this.participantOf(c.target);
      if (c.async) {
        // started on another thread: it does not run inside this request
        this.msg(out, self, to, `${c.async === "scheduled" ? "schedule" : c.async === "shutdown" ? "on shutdown" : "start"} ${target.name}()`, "async", c.target, c.line);
        return c.when ? [{ k: "frag", type: "opt", sections: [{ label: c.when, items: out }] }] : out;
      }
      const expand = depth < this.maxDepth && !stack.includes(c.target);
      this.msg(out, self, to, `${c.name === "<init>" ? "new" : c.name}()`, "call", c.target, c.line);
      if (expand && controlFlowOf(target)) {
        out.push(...this.body(c.target, to, depth + 1, stack));
      } else if (expand) {
        // no body (interface / declarative client such as Feign): use its recorded effects
        for (const e of this.m.out.get(c.target) ?? []) {
          if (!["http_calls", "publishes", "reads", "writes"].includes(e.kind)) continue;
          const verb = e.attrs?.method as string | undefined;
          const path = e.attrs?.path as string | undefined;
          const name = e.kind === "http_calls" ? [verb, path].filter(Boolean).join(" ") : String((e.attrs?.operations as string[] | undefined)?.[0] ?? e.kind);
          out.push(...this.call({ kind: e.kind, target: e.target, name, httpMethod: verb, path }, c.target, to, depth + 1, [...stack, c.target]));
        }
      }
      const ret = target.attrs?.returnType as string | undefined;
      if (to !== self && ret && ret !== "void" && !/^Promise<void>$/.test(ret)) this.msg(out, to, self, short(ret), "return", c.target);
    } else {
      const to = this.resource(c.target);
      const edge = (this.m.out.get(fnId) ?? []).find((e) => e.target === c.target && e.kind === c.kind);
      const response = (edge?.attrs?.responses as { type: string }[] | undefined)?.[0]?.type;
      const payload = (edge?.attrs?.payloads as { type: string }[] | undefined)?.[0]?.type;
      const label = c.kind === "http_calls" ? c.name || "HTTP" : `${c.name}${payload && c.kind !== "reads" ? `(${short(payload)})` : "()"}`;
      this.msg(out, self, to, label, c.kind === "publishes" ? "async" : "io", c.target, c.line);
      // continue into the handler when the HTTP target is a service of this repo
      const handler = c.kind === "http_calls" ? this.remoteHandler(c) : undefined;
      if (handler && depth < this.maxDepth && !stack.includes(handler.id)) {
        const remote = this.participantOf(handler.id);
        this.msg(out, to, remote, handler.name, "call", handler.id);
        out.push(...this.body(handler.id, remote, depth + 1, stack));
      }
      if (response && c.kind !== "publishes") this.msg(out, to, self, short(response), "return", c.target);
    }
    if (c.when && out.length) return [{ k: "frag", type: "opt", sections: [{ label: c.when, items: out }] }];
    return out;
  }

  /** The handler of the endpoint an HTTP call hits, when the target is a service in this repo. */
  private remoteHandler(c: CallStep): GraphNode | undefined {
    const svc = this.m.node(c.target);
    if (!svc || !SERVICES.has(svc.kind) || !c.path) return undefined;
    for (const ep of this.m.ofKind("endpoint")) {
      if (!this.m.appsOf(ep.id).some((a) => a.id === svc.id)) continue;
      const verb = ep.attrs?.method as string | undefined;
      if (c.httpMethod && verb && verb !== "ANY" && verb !== c.httpMethod) continue;
      if (!routeMatches(String(ep.attrs?.route ?? ""), c.path)) continue;
      const h = (this.m.out.get(ep.id) ?? []).find((e) => e.kind === "handles");
      if (h) return this.m.node(h.target);
    }
    return undefined;
  }
}

/** "/orders/{id}" or "/orders/:id" matches "/orders/42" and "/orders/{x}". */
export function routeMatches(route: string, path: string): boolean {
  const re = new RegExp("^" + route.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\{[^}]+\}|:[A-Za-z_]\w*/g, "[^/]+") + "/?$");
  return re.test(path);
}

function short(s: string, n = 40) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

export function sequenceOf(m: Model, startId: string, maxDepth = 3): Sequence {
  const start = m.node(startId);
  if (!start) return { participants: [], items: [], truncated: false, empty: "Pick an endpoint or function." };
  const b = new SeqBuilder(m, maxDepth);
  const items: SeqItem[] = [];
  let fnId = startId;
  let caller: string;
  if (start.kind === "endpoint") {
    const h = (m.out.get(startId) ?? []).find((e) => e.kind === "handles");
    if (!h) return { participants: [], items: [], truncated: false, empty: "This endpoint has no handler in the code (spec only)." };
    fnId = h.target;
    caller = b.add({ id: "actor:client", label: "Client", kind: "actor" });
    const self = b.participantOf(fnId);
    const req = (start.attrs?.request as { type: string } | undefined)?.type;
    b.msg(items, caller, self, `${start.name}${req ? ` (${short(req, 30)})` : ""}`, "call", start.id);
    items.push(...b.body(fnId, self, 1, []));
    const res = (start.attrs?.response as { type: string } | undefined)?.type;
    if (res) b.msg(items, self, caller, short(res), "return", start.id);
  } else {
    caller = b.add({ id: "actor:caller", label: "caller", kind: "actor" });
    const self = b.participantOf(fnId);
    b.msg(items, caller, self, `${start.name}()`, "call", fnId);
    items.push(...b.body(fnId, self, 1, []));
  }
  // order lifelines by first appearance, keeping each service's lifelines together
  const seen = [...b.participants.values()];
  const ps: Participant[] = [];
  for (const p of seen) {
    if (ps.includes(p)) continue;
    if (!p.group || p.kind === "actor") ps.push(p);
    else ps.push(...seen.filter((q) => q.group === p.group && q.kind !== "actor"));
  }
  return {
    participants: ps,
    items,
    truncated: b.truncated,
    empty: items.length <= 1 ? "No calls to show." : undefined,
  };
}

/**
 * Collapses the lifelines of the given services into one lifeline each: messages between
 * their classes disappear, messages crossing the boundary are kept, and fragments that end up
 * empty are dropped.
 */
export function collapseServices(seq: Sequence, services: Set<string>): Sequence {
  if (!services.size) return seq;
  const map = new Map<string, string>();
  const participants: Participant[] = [];
  for (const p of seq.participants) {
    if (p.group && services.has(p.group) && p.kind !== "actor") {
      const id = `collapsed:${p.group}`;
      map.set(p.id, id);
      if (!participants.some((x) => x.id === id)) {
        participants.push({ id, label: p.group, kind: "service", group: p.group });
      }
    } else {
      map.set(p.id, p.id);
      participants.push(p);
    }
  }
  const walk = (items: SeqItem[]): SeqItem[] => {
    const out: SeqItem[] = [];
    for (const it of items) {
      if (it.k === "msg") {
        const from = map.get(it.from) ?? it.from;
        const to = map.get(it.to) ?? it.to;
        if (from === to && from.startsWith("collapsed:")) continue; // internal to a collapsed service
        out.push({ ...it, from, to });
      } else if (it.k === "note") {
        out.push({ ...it, over: map.get(it.over) ?? it.over });
      } else {
        const sections = it.sections.map((s) => ({ ...s, items: walk(s.items) }));
        if (sections.some((s) => s.items.length)) out.push({ ...it, sections });
      }
    }
    return out;
  };
  return { ...seq, participants, items: walk(seq.items) };
}

/** A sequence as an outline: each participant in the order it first appears, with the messages it receives and sends. */
export function sequenceOutline(seq: Sequence, title: string): Outline {
  const msgs: Extract<SeqItem, { k: "msg" }>[] = [];
  const walk = (items: SeqItem[], when?: string) => {
    for (const it of items) {
      if (it.k === "msg") msgs.push(when ? { ...it, label: `${it.label} · ${when}` } : it);
      else if (it.k === "frag") for (const sec of it.sections) walk(sec.items, [it.type, sec.label].filter(Boolean).join(" "));
    }
  };
  walk(seq.items);
  const byId = new Map(seq.participants.map((p) => [p.id, p]));
  const order: string[] = [];
  for (const mm of msgs) for (const id of [mm.from, mm.to]) if (!order.includes(id) && byId.has(id)) order.push(id);
  const n = new Map(order.map((id, i) => [id, i + 1]));
  const end = (id: string) => ({ label: `${n.get(id) ?? "?"}. ${byId.get(id)?.label ?? id}`, ref: byId.get(id)?.ref, part: n.get(id) });
  const link = (mm: Extract<SeqItem, { k: "msg" }>, other: string): PartLink => ({
    ...end(other), data: mm.label, via: mm.style === "return" ? "returns" : mm.style === "async" ? "async" : mm.style === "io" ? "I/O" : "call",
  });
  return {
    title, stepsLabel: "messages", controlTerms: ["called by", "calls"],
    parts: order.map((id) => {
      const p = byId.get(id)!;
      return {
        id, ref: p.ref ?? id, n: n.get(id)!, title: p.label, kind: p.group ? `${p.kind} · ${p.group}` : p.kind,
        inputs: msgs.filter((mm) => mm.to === id && mm.from !== id).map((mm) => link(mm, mm.from)),
        outputs: msgs.filter((mm) => mm.from === id && mm.to !== id).map((mm) => link(mm, mm.to)),
        steps: [],
      };
    }),
  };
}

