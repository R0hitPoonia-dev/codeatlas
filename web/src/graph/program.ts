// Program: one program at a time, read as if it were a single file. Three lanes, left to right:
//   Data in  — where information comes from: socket and HTTP clients, topics consumed,
//              database and cache reads, config files, answers from external APIs.
//   Program  — its parts in the order data moves through them: start-up, the servers it opens,
//              the threads, tasks and consumers it starts. Each part is named by what it does
//              ("Receive ConnectorPacket", "Publish to Kafka (8 topics)"), with the function
//              that does it underneath, and the lines between parts carry the data handed on
//              (a task's captured arguments, a queue's element type, shared state).
//   Data out — where information goes: database and cache writes, published messages,
//              responses to clients, calls to other systems.
// programModel also returns the same program as an outline (entry point, then each part with
// what goes in and out), for reading top to bottom.
import type { GraphEdge, GraphNode } from "../api";
import { CallStep, controlFlowOf, isAccessor, Item, Step } from "./activity";
import { ClassHits, Classifier, highest, mergeHits, TypeInfo } from "./dataclass";
import { entryPoints } from "./dataflow";
import { Model } from "./model";
import { systemGroup } from "./roles";
import {
  capitalize, compressLinks, effectsOf, effectText, firstSentence, humanize, lower, names, short, type Outline, type OutlinePart,
  type PartLink,
} from "./reading";
import { FlowInfo, GroupSet, reachable, Row, Shape, SIDE_EFFECTS, VEdge, VNode, ViewModel } from "./views";

const SERVICES = new Set(["service", "module"]);
const TYPES = new Set(["class", "interface", "enum"]);

export interface ProgramRoot {
  /** The main (or Spring Boot class) the program starts at. */
  id: string;
  /** What the picker shows: the program and where it starts. */
  label: string;
  /** The program (service) name. */
  service?: string;
}

/**
 * Where the Program view can start: each program the build produces (a service that `runs` a
 * main), then mains no build packages into a jar.
 */
export function programRoots(m: Model): ProgramRoot[] {
  const programs: ProgramRoot[] = [];
  const seen = new Set<string>();
  for (const svc of m.ofKind("service")) {
    for (const e of m.out.get(svc.id) ?? []) {
      if (e.kind !== "runs" || !m.node(e.target) || seen.has(e.target)) continue;
      seen.add(e.target);
      programs.push({ id: e.target, label: `${svc.name} · ${fnLabel(m, e.target)}`, service: svc.name });
    }
  }
  const loose = m.graph.nodes
    .filter((n) => n.attrs?.entryPoint === "main" && !seen.has(n.id))
    .map((n) => {
      const service = m.appsOf(n.id).map((a) => a.name).join(", ") || undefined;
      const unpacked = n.attrs?.packaged === false ? " (not in a jar)" : "";
      return { id: n.id, label: `${service ? `${service} · ` : ""}${fnLabel(m, n.id)}${unpacked}`, service };
    });
  const byLabel = (a: ProgramRoot, b: ProgramRoot) => a.label.localeCompare(b.label);
  return [...programs.sort(byLabel), ...loose.sort(byLabel)];
}

type Kind = "main" | "runtime" | "thread" | "scheduled" | "executor" | "shutdown" | "socket" | "http" | "consumer";

/** Who starts a part: the part it runs in, the method making the start, and how. */
interface Starter {
  from: string;
  via?: string;
  how: string;
  conditions?: string[];
}

/** A unit of work the program runs: main itself, or something it starts. */
interface Component {
  /** Graph node the work starts at: a method, or an endpoint (its handler does the work). */
  start: string;
  body?: string;
  kind: Kind;
  /** Endpoints this part serves (several ports with one handler are one part). */
  endpoints: string[];
  starters: Starter[];
  reach: Set<string>;
  /**
   * The code whose data this part reads and writes: its reach, plus every method of its own
   * thread class (a consumer that subscribes in its constructor), minus code of another part's
   * thread class (creating that object does not make its work this part's).
   */
  own: Set<string>;
}

const KIND_TEXT: Record<Kind, string> = {
  main: "entry point", runtime: "started by the runtime", thread: "thread", scheduled: "scheduled job",
  executor: "task on an executor", shutdown: "runs on shutdown", socket: "socket server", http: "HTTP endpoint",
  consumer: "message consumer",
};

/** One part of a program, as the outline lists it (the outline every diagram has). */
export type ProgramPart = OutlinePart;
export type ProgramOutline = Outline;
export type { PartLink };

/** The Program diagram for one program (or every program together, rootId "all"). */
export function programView(m: Model, rootId = "all"): ViewModel {
  return programModel(m, rootId).view;
}

/** The Program diagram and the same program as an outline. */
export function programModel(m: Model, rootId = "all"): { view: ViewModel; outline?: ProgramOutline } {
  const roots = rootId === "all" ? programRoots(m).map((r) => r.id) : [rootId];
  const comps = new Map<string, Component>();
  const byHandler = new Map<string, string>(); // handler -> endpoint part serving it
  const queue: string[] = [];
  const add = (c: Omit<Component, "reach" | "own" | "endpoints" | "starters"> & { endpoints?: string[] }, starter?: Starter) => {
    const existing = comps.get(c.start);
    if (existing) {
      if (starter && !existing.starters.some((s) => s.from === starter.from && s.via === starter.via)) existing.starters.push(starter);
      return;
    }
    comps.set(c.start, { ...c, endpoints: c.endpoints ?? [], starters: starter ? [starter] : [], reach: new Set(), own: new Set() });
    queue.push(c.start);
  };
  /** A server endpoint; ports served by the same handler are one part. */
  const addEndpoint = (ep: GraphNode, starter: Starter, kind?: Kind) => {
    const handler = (m.out.get(ep.id) ?? []).find((e) => e.kind === "handles")?.target;
    const same = handler ? byHandler.get(handler) : undefined;
    if (same && comps.has(same)) {
      const c = comps.get(same)!;
      if (!c.endpoints.includes(ep.id)) c.endpoints.push(ep.id);
      if (!c.starters.some((s) => s.from === starter.from)) c.starters.push(starter);
      return;
    }
    if (handler) byHandler.set(handler, ep.id);
    add({ start: ep.id, body: handler, kind: kind ?? (ep.attrs?.protocol === "tcp" ? "socket" : "http"), endpoints: [ep.id] }, starter);
  };

  if (roots.length) {
    for (const r of roots) add({ start: r, kind: "main" });
  } else {
    // no main (e.g. a Node service): each service is started by its runtime, which runs its entry points
    for (const svc of m.services()) {
      if (entryPoints(m, svc.id).length) add({ start: svc.id, kind: "runtime" });
    }
  }
  if (!comps.size) {
    return { view: { nodes: [], edges: [], direction: "RIGHT", empty: "No main method or entry points found. Re-analyze the repo to pick up main methods." } };
  }

  while (queue.length) {
    const c = comps.get(queue.shift()!)!;
    const node = m.node(c.start);
    if (c.kind === "runtime") {
      for (const e of entryPoints(m, c.start)) entry(m, e, c.start, "runs", add, addEndpoint);
      continue;
    }
    // a Spring Boot class without a main: the framework is the start
    c.body ??= node?.kind === "endpoint" ? (m.out.get(c.start) ?? []).find((e) => e.kind === "handles")?.target
      : node && TYPES.has(node.kind) ? undefined : c.start;
    if (c.body) c.reach = new Set(reachable(m, c.body, 150, 12).keys());

    for (const id of c.reach) {
      for (const e of m.out.get(id) ?? []) {
        if (e.kind !== "calls" || !e.attrs?.async) continue;
        const how = String(e.attrs.async);
        const target = m.node(e.target);
        const schedule = target?.attrs?.schedule ? ` · ${String(target.attrs.schedule).replace(/^schedule/, "").slice(0, 60)}` : "";
        add({ start: e.target, kind: (["thread", "scheduled", "executor", "shutdown"].includes(how) ? how : "thread") as Kind }, {
          from: c.start, via: id, conditions: conditionsOf(e),
          how: `${how === "scheduled" ? "schedules" : how === "shutdown" ? "on shutdown" : "starts"}${schedule}`,
        });
      }
    }
    // creating a Runnable / Thread object: whatever starts it later (a pool, a list of
    // workers), its run() is work this part sets going
    for (const id of c.reach) {
      const n = m.node(id);
      if (n?.name !== "<init>" || !n.parent) continue;
      for (const sib of m.children.get(n.parent) ?? []) {
        if (sib.attrs?.entryPoint === "thread" && sib.id !== c.start) add({ start: sib.id, kind: "thread" }, { from: c.start, via: id, how: "creates" });
      }
    }
    for (const ep of m.ofKind("endpoint")) {
      const openers = (ep.attrs?.openedBy as string[] | undefined) ?? [];
      if (!openers.some((o) => c.reach.has(o))) continue;
      addEndpoint(ep, { from: c.start, how: ep.attrs?.protocol === "tcp" ? "opens" : `serves ${ep.attrs?.route ?? ep.name}` });
    }
    // a Spring Boot main hands over to the framework, which runs every entry point of the service
    if (c.kind === "main" && node && isFrameworkMain(m, node)) {
      const svc = runningService(m, node.id);
      for (const e of svc ? entryPoints(m, svc.id) : []) {
        if (e.kind !== "main") entry(m, e, c.start, "framework runs", add, addEndpoint);
      }
    }
  }

  ownCode(m, comps);
  return draw(m, comps, roots);
}

/** The class a thread part's body (run / call) belongs to, if the part is a thread class's work. */
function threadClass(m: Model, c: Component): string | undefined {
  const body = c.body ? m.node(c.body) : undefined;
  if (!body || body.attrs?.lambda || c.kind === "main" || c.kind === "socket" || c.kind === "http") return undefined;
  const owner = body.parent ? m.node(body.parent) : undefined;
  return owner && TYPES.has(owner.kind) ? owner.id : undefined;
}

function ownCode(m: Model, comps: Map<string, Component>) {
  const classPart = new Map<string, string>();
  for (const c of comps.values()) {
    const cls = threadClass(m, c);
    if (cls && !classPart.has(cls)) classPart.set(cls, c.start);
  }
  const typeOf = (id: string) => m.owner(id, TYPES)?.id;
  for (const c of comps.values()) {
    const cls = threadClass(m, c);
    const ids = new Set(c.reach);
    if (cls && classPart.get(cls) === c.start) {
      for (const k of m.children.get(cls) ?? []) if (k.kind === "method") ids.add(k.id);
    }
    for (const id of ids) {
      const t = typeOf(id);
      const owner = t ? classPart.get(t) : undefined;
      if (!owner || owner === c.start) c.own.add(id);
    }
  }
}

function entry(m: Model, e: ReturnType<typeof entryPoints>[number], parent: string, verb: string,
  add: (c: Omit<Component, "reach" | "own" | "endpoints" | "starters">, s?: Starter) => void,
  addEndpoint: (ep: GraphNode, s: Starter, kind?: Kind) => void) {
  const node = m.node(e.id);
  if (node?.kind === "endpoint") {
    addEndpoint(node, { from: parent, how: verb });
    return;
  }
  const kind: Kind = e.kind === "main" ? "thread" : (e.kind as Kind);
  add({ start: e.id, body: e.start, kind }, { from: parent, how: `${verb} ${KIND_TEXT[kind]}` });
}

/** The program this main starts, when the code lives in a shared module; otherwise the service that contains it. */
function runningService(m: Model, id: string): GraphNode | undefined {
  const ran = (m.in.get(id) ?? []).find((e) => e.kind === "runs");
  const fromRun = ran && m.node(ran.source);
  if (fromRun?.kind === "service") return fromRun;
  const apps = m.appsOf(id).filter((a) => a.kind === "service");
  if (apps.length === 1) return apps[0];
  return m.owner(id, SERVICES);
}

function isFrameworkMain(m: Model, n: GraphNode): boolean {
  const owner = TYPES.has(n.kind) ? n : n.parent ? m.node(n.parent) : undefined;
  const anns = (owner?.attrs?.annotations as string[] | undefined) ?? [];
  return anns.includes("SpringBootApplication") || owner?.attrs?.stereotype === "SpringBootApplication";
}

function conditionsOf(e: GraphEdge): string[] | undefined {
  const c = e.attrs?.conditions as string[] | undefined;
  return c?.length && !e.attrs?.unconditional ? c : undefined;
}

// ------------------------------------------------------------------ naming parts

/** "Fill persistence thread" for FillPersistenceThread.run, "submit task" for a lambda in submit(). */
function humanName(m: Model, id: string): string {
  const n = m.node(id);
  if (!n) return id;
  if (n.attrs?.lambda) {
    const def = m.node(String(n.attrs.definedIn ?? ""));
    const defClass = def?.parent ? m.node(def.parent) : undefined;
    // a lambda in run() / main() / start(): its class says more than the method
    const by = def && /^(run|call|main|start|init|<init>|execute|setup)$/.test(def.name) && defClass && TYPES.has(defClass.kind)
      ? defClass.name : def?.name ?? "background";
    return capitalize(`${humanize(by)} task`);
  }
  const owner = n.parent ? m.node(n.parent) : undefined;
  const cls = owner && TYPES.has(owner.kind) ? owner.name : undefined;
  if (cls && ["run", "call", "handle", "execute", "accept", "apply", "process"].includes(n.name)) return capitalize(humanize(cls));
  return capitalize(cls ? `${humanize(cls)} · ${n.name}` : humanize(n.name));
}

/** Class names that say nothing about the work. */
const GENERIC_CLASS = /^(Main|App|Application|Worker|Task|Runner|Job|Thread|Handler|Impl|Service)$/;

/** What a part is called, what kind of work it is and where its code is. */
function describe(m: Model, c: Component): { title: string; kind: string; code: string; doc?: string } {
  const body = c.body ? m.node(c.body) : undefined;
  const start = m.node(c.start);
  const code = c.body ? fnLabel(m, c.body) : start?.name ?? c.start;
  const doc = firstSentence(body?.attrs?.doc)
    ?? (body?.attrs?.lambda ? firstSentence(m.node(String(body.attrs.definedIn ?? ""))?.attrs?.doc) : undefined);
  const fx = effectsOf(m, c.own);
  switch (c.kind) {
    case "main": {
      const does = effectText(m, fx);
      return { title: does ? `Start-up · ${does[0].toLowerCase()}${does.slice(1)}` : "Start-up", kind: "entry point", code, doc };
    }
    case "runtime":
      return { title: `${start?.name ?? c.start} runtime`, kind: KIND_TEXT.runtime, code: start?.name ?? c.start };
    case "socket":
    case "http": {
      const eps = c.endpoints.map((id) => m.node(id)).filter((n): n is GraphNode => !!n);
      const where = eps.map((e) => (c.kind === "socket" ? e.name.replace(/^TCP\s*/, "") : e.name)).join(", ");
      const req = eps.map((e) => (e.attrs?.request as TypeInfo | undefined)?.type).find(Boolean);
      const title = c.kind === "socket"
        ? req ? `Receive ${short(req, 32)}` : `Serve ${eps.map((e) => e.name).join(", ")}`
        : `Serve ${short(eps.map((e) => e.name).join(", "), 40)}`;
      return { title, kind: `${KIND_TEXT[c.kind]} · ${short(where, 40)}`, code, doc };
    }
  }
  const consumes = fx.get("consumes") ?? [];
  const then = effectText(m, fx, true, 1);
  const does = consumes.length ? `Consume ${names(consumes)}${then ? ` · ${lower(then)}` : ""}` : effectText(m, fx);
  const prefix = c.kind === "shutdown" ? "On shutdown" : c.kind === "scheduled" ? "Scheduled" : undefined;
  // a thread class's own name says what it is for (PriceEngine, SnapshotThread); lead with it
  const cls = threadClass(m, c);
  const named = cls && !GENERIC_CLASS.test(m.node(cls)?.name ?? "") ? capitalize(humanize(m.node(cls)!.name)) : undefined;
  const title = prefix ? (does ? `${prefix}: ${lower(does)}` : c.kind === "scheduled" ? `${prefix}: ${lower(humanName(m, c.body ?? c.start))}` : prefix)
    : named ? (does ? `${named} · ${lower(does)}` : named)
      : does ?? humanName(m, c.body ?? c.start);
  const schedule = body?.attrs?.schedule ? ` · ${String(body.attrs.schedule).replace(/^schedule/, "").slice(0, 40)}` : "";
  return { title, kind: (consumes.length && c.kind === "thread" ? "consumer thread" : KIND_TEXT[c.kind]) + schedule, code, doc };
}

// --------------------------------------------------------------- handing data on

/** A part handing data to another part: what a started task captures, a queue, shared state, or just a start. */
interface Handoff {
  from: string;
  to: string;
  kind: "pass" | "queue" | "state" | "start";
  data: string[];
  via?: string;
  conditions?: string[];
}

const QUEUE_TYPE = /\b(Blocking|Transfer|Concurrent|Linked|Array|Priority|Delay)?(Queue|Deque)\b|\bExchanger\b|\bRingBuffer\b|\bDisruptor\b/;
const STATE_TYPE = /\b(Map|List|Set|Collection|Atomic\w*|Concurrent\w*|Cache|Table)\b|\[\]$/;
const PUTS = "put|offer|add|addLast|addFirst|offerLast|offerFirst|push|transfer|tryTransfer|publishEvent";
const TAKES = "take|poll|pollFirst|pollLast|takeFirst|takeLast|drainTo|remove|peek";

/** The element type of a queue / collection type: FillAdded for BlockingQueue<FillAdded>. */
function elementType(type: string): string | undefined {
  const m = /<\s*([^<>]*(?:<[^<>]*>[^<>]*)*)\s*>\s*$/.exec(type);
  return m ? m[1].split(",").pop()!.trim() : undefined;
}

interface FieldUse {
  field: string;
  name: string;
  type: string;
  reads: boolean;
  writes: boolean;
  puts: boolean;
  takes: boolean;
}

/** Fields (and static state) a part's work uses, with whether it puts into or takes from a queue. */
function fieldUses(m: Model, c: Component): FieldUse[] {
  const out = new Map<string, FieldUse>();
  for (const id of c.own) {
    const n = m.node(id);
    const vars = (n?.attrs?.variables as { name: string; scope: string; type?: string; declaredIn?: string; reads?: number; writes?: number }[] | undefined) ?? [];
    let text: string | undefined;
    for (const v of vars) {
      if ((v.scope !== "field" && v.scope !== "static") || !v.declaredIn) continue;
      const field = m.node(v.declaredIn);
      const type = String(field?.attrs?.type ?? v.type ?? "");
      const name = v.name.split(".").pop()!;
      const use = out.get(v.declaredIn) ?? { field: v.declaredIn, name, type, reads: false, writes: false, puts: false, takes: false };
      use.reads ||= (v.reads ?? 0) > 0;
      use.writes ||= (v.writes ?? 0) > 0;
      if (QUEUE_TYPE.test(type)) {
        text ??= JSON.stringify(controlFlowOf(n) ?? []);
        const at = `(?:^|[^\\w.])(?:this\\.)?${name.replace(/[$]/g, "\\$")}\\s*\\.\\s*`;
        if (new RegExp(`${at}(?:${PUTS})\\s*\\(`).test(text)) use.puts = true;
        if (new RegExp(`${at}(?:${TAKES})\\s*\\(`).test(text)) use.takes = true;
      }
      out.set(v.declaredIn, use);
    }
  }
  return [...out.values()];
}

function handoffs(m: Model, comps: Map<string, Component>): Handoff[] {
  const out: Handoff[] = [];
  for (const c of comps.values()) {
    const body = c.body ? m.node(c.body) : undefined;
    for (const s of c.starters) {
      if (!comps.has(s.from)) continue;
      // a lambda carries what it captures from the method that starts it
      if (body?.attrs?.lambda) {
        const vars = (body.attrs.variables as { name: string; scope: string; type?: string }[] | undefined) ?? [];
        const captured = vars.filter((v) => v.scope === "captured").map((v) => (v.type ? `${v.name}: ${v.type}` : v.name));
        if (captured.length) {
          out.push({ from: s.from, to: c.start, kind: "pass", data: captured, via: `${s.how}${s.via ? ` · via ${fnLabel(m, s.via)}` : ""}`, conditions: s.conditions });
          continue;
        }
      }
      const ports = c.endpoints.length && c.kind === "socket"
        ? ` ${c.endpoints.map((id) => m.node(id)?.name.replace(/^TCP\s*/, "")).join(", ")}` : "";
      out.push({ from: s.from, to: c.start, kind: "start", data: [], via: `${s.how}${ports}`, conditions: s.conditions });
    }
  }
  // queues: what one part puts in, another takes out (matched by element type: the two ends
  // usually hold the same queue in fields of different classes)
  const uses = new Map([...comps.values()].map((c) => [c.start, fieldUses(m, c)]));
  const queues = new Map<string, { puts: Map<string, string>; takes: Map<string, string> }>();
  for (const [part, us] of uses) {
    for (const u of us) {
      if (!u.puts && !u.takes) continue;
      const key = elementType(u.type) ?? u.field;
      const q = queues.get(key) ?? { puts: new Map(), takes: new Map() };
      if (u.puts) q.puts.set(part, u.name);
      if (u.takes) q.takes.set(part, u.name);
      queues.set(key, q);
    }
  }
  for (const [elem, q] of queues) {
    for (const [from, fname] of q.puts) {
      for (const [to, tname] of q.takes) {
        if (from === to) continue;
        out.push({ from, to, kind: "queue", data: [elem], via: `queue ${fname === tname ? fname : `${fname} → ${tname}`}` });
      }
    }
  }
  // shared state: set by one part, read by another that does not set it
  const writers = new Map<string, Set<string>>();
  const fieldOf = new Map<string, FieldUse>();
  for (const [part, us] of uses) {
    for (const u of us) {
      if (QUEUE_TYPE.test(u.type) || !STATE_TYPE.test(u.type)) continue;
      fieldOf.set(u.field, u);
      if (u.writes) writers.set(u.field, (writers.get(u.field) ?? new Set()).add(part));
    }
  }
  const state = new Map<string, Handoff>();
  for (const [part, us] of uses) {
    for (const u of us) {
      const ws = writers.get(u.field);
      if (!u.reads || u.writes || !ws || !fieldOf.has(u.field)) continue;
      for (const w of ws) {
        if (w === part) continue;
        const key = `${w}→${part}`;
        const h = state.get(key) ?? { from: w, to: part, kind: "state" as const, data: [], via: "shared state" };
        if (h.data.length < 3) h.data.push(`${u.name}: ${u.type}`);
        state.set(key, h);
      }
    }
  }
  return [...out, ...state.values()];
}

/** Parts in the order data moves through them: start-up first, then whatever it hands work to; shutdown hooks last. */
function dataOrder(comps: Map<string, Component>, links: Handoff[], roots: string[]): string[] {
  const late = (k: string) => comps.get(k)?.kind === "shutdown";
  const indeg = new Map([...comps.keys()].map((k) => [k, 0]));
  const next = new Map<string, string[]>();
  for (const h of links) {
    if (h.from === h.to || !comps.has(h.from) || !comps.has(h.to)) continue;
    next.set(h.from, [...(next.get(h.from) ?? []), h.to]);
    indeg.set(h.to, (indeg.get(h.to) ?? 0) + 1);
  }
  const discovery = [...comps.keys()];
  const order: string[] = [];
  const done = new Set<string>();
  const ready = [...roots.filter((r) => comps.has(r)), ...discovery.filter((k) => indeg.get(k) === 0 && !roots.includes(k))];
  while (order.length < discovery.length) {
    let id = ready.find((k) => !done.has(k) && !late(k)) ?? ready.find((k) => !done.has(k));
    if (!id) id = discovery.find((k) => !done.has(k) && !late(k)) ?? discovery.find((k) => !done.has(k))!; // a cycle: take the next part found
    done.add(id);
    order.push(id);
    for (const t of next.get(id) ?? []) {
      indeg.set(t, (indeg.get(t) ?? 1) - 1);
      if (indeg.get(t)! <= 0 && !done.has(t)) ready.push(t);
    }
  }
  return order;
}

// ------------------------------------------------------------------ drawing

interface Flow {
  from: string;
  to: string;
  types: Map<string, TypeInfo>;
  ops: Set<string>;
  hits: ClassHits;
  sources: FlowInfo["sources"];
}

/** Digest rows worth showing on a part's box: decisions, loops, calculations, I/O and starts. */
const BOX_ROWS = 7;

function draw(m: Model, comps: Map<string, Component>, roots: string[]): { view: ViewModel; outline: ProgramOutline } {
  const manyRoots = roots.length > 1;
  const c = new Classifier(m);
  const gs = new GroupSet();
  const lane = {
    in: gs.add({ id: "lane:in", label: "Data in", sub: "where information comes from", kind: "lane" }),
    prog: gs.add({ id: "lane:prog", label: "Program", sub: "its parts, in the order data moves through them", kind: "lane" }),
    out: gs.add({ id: "lane:out", label: "Data out", sub: "where information goes", kind: "lane" }),
  };
  const nodes = new Map<string, VNode>();
  const flows = new Map<string, Flow>();
  const edges: VEdge[] = [];
  const procId = (start: string) => `prog:${start}`;

  // where a part sits: under its main when several mains are shown
  const rootOf = (start: string, seen = new Set<string>()): string => {
    const from = comps.get(start)?.starters.find((s) => !seen.has(s.from))?.from;
    if (!from || roots.includes(start)) return start;
    seen.add(start);
    return rootOf(from, seen);
  };
  const programName = (root: string) => runningService(m, root)?.name ?? fnLabel(m, root);

  const links = handoffs(m, comps);
  const order = dataOrder(comps, links, roots);
  const number = new Map(order.map((id, i) => [id, i + 1]));
  const described = new Map(order.map((id) => [id, describe(m, comps.get(id)!)]));
  // two parts of one class with nothing else to tell them apart: say which method each is
  const seenTitle = new Map<string, number>();
  for (const d of described.values()) seenTitle.set(d.title, (seenTitle.get(d.title) ?? 0) + 1);
  for (const id of order) {
    const d = described.get(id)!;
    const body = comps.get(id)!.body ? m.node(comps.get(id)!.body!) : undefined;
    if ((seenTitle.get(d.title) ?? 0) > 1 && body && !body.attrs?.lambda) d.title = `${d.title} · ${humanize(body.name)}`;
  }
  const stepsOf = new Map(order.map((id) => [id, comps.get(id)!.body ? digest(m, comps.get(id)!.body!) : []]));

  for (const id of order) {
    const comp = comps.get(id)!;
    const node = m.node(comp.start);
    const d = described.get(id)!;
    const rows: Row[] = [];
    if (d.doc) rows.push({ text: `“${d.doc}”`, muted: true });
    for (const r of stepsOf.get(id)!) {
      if (rows.length >= BOX_ROWS) break;
      if (r.marker === "→" && r.muted) continue; // a call that neither decides nor touches data
      rows.push(r);
    }
    let group = lane.prog;
    if (manyRoots) {
      const root = rootOf(comp.start);
      group = gs.add({ id: `prog:root:${root}`, label: programName(root), sub: fnLabel(m, root), kind: "service", parent: lane.prog });
    }
    nodes.set(procId(comp.start), {
      id: procId(comp.start), ref: comp.body && node?.kind !== "endpoint" ? comp.body : comp.start,
      label: `${number.get(id)}. ${d.title}`, sub: `${d.kind} · ${d.code}`,
      shape: comp.kind === "main" || comp.kind === "runtime" ? "start" : "process",
      sections: rows.length ? [rows] : undefined, group,
    });
  }
  // part -> part: data handed on (solid, typed), shared state (dashed), or only a start
  const between = new Map<string, Handoff[]>();
  for (const h of links) {
    if (!comps.has(h.from) || !comps.has(h.to) || h.from === h.to) continue;
    const key = `${h.from}→${h.to}`;
    between.set(key, [...(between.get(key) ?? []), h]);
  }
  for (const [key, hs] of between) {
    const data = hs.filter((h) => h.kind === "pass" || h.kind === "queue");
    const state = hs.filter((h) => h.kind === "state");
    const start = hs.find((h) => h.kind === "start");
    const { from, to } = hs[0];
    const dataTypes = [...new Set(data.flatMap((h) => h.data))];
    const stateTypes = [...new Set(state.flatMap((h) => h.data))];
    const typed = dataTypes.length ? dataTypes : stateTypes;
    const via = [...new Set([...data, ...(dataTypes.length ? [] : state), ...(typed.length ? [] : start ? [start] : [])].map((h) => h.via).filter(Boolean))];
    edges.push({
      id: `hand:${key}`, source: procId(from), target: procId(to),
      style: typed.length ? "data" : "call",
      label: typed.length ? short(typed.slice(0, 3).join(", "), 64) + (typed.length > 3 ? ` +${typed.length - 3}` : "") : start?.via,
      sublabel: typed.length ? short(via.join(" · "), 60) : start?.conditions?.length ? `when ${start.conditions[0].replace(/^if /, "")}` : undefined,
      count: 1, conditional: !dataTypes.length && (!!stateTypes.length || !!start?.conditions?.length),
    });
  }

  const dataNode = (side: "in" | "out", graphId: string): string => {
    const id = `${side}:${graphId}`;
    if (nodes.has(id)) return id;
    const n = m.node(graphId);
    const sys = n ? mechanism(m, n) : PSEUDO[graphId.split(":")[0] === "config" ? "config" : graphId] ?? { id: graphId, label: graphId };
    const group = gs.add({ id: `${side}:sys:${sys.label}`, label: sys.label, kind: "system", parent: side === "in" ? lane.in : lane.out, keep: true });
    nodes.set(id, n
      ? { id, ref: n.id, label: n.name, sub: dataSub(m, n), shape: dataShape(n), group }
      : graphId.startsWith("config:")
        ? { id, label: graphId.slice("config:".length), sub: "config file", shape: "package", group }
        : { id, label: PSEUDO[graphId]?.node ?? graphId, sub: graphId === "env" ? "process environment" : "external", shape: "entity", group });
    return id;
  };

  const flow = (from: string, to: string, types: TypeInfo[], e: GraphEdge | undefined, ops: string[], hits?: ClassHits) => {
    const key = `${from}→${to}`;
    let f = flows.get(key);
    if (!f) flows.set(key, (f = { from, to, types: new Map(), ops: new Set(), hits: new Map(), sources: [] }));
    for (const t of types) {
      if (!f.types.has(t.type)) {
        f.types.set(t.type, t);
        mergeHits(f.hits, c.ofPayload(t));
      }
    }
    if (hits) mergeHits(f.hits, hits);
    ops.filter(Boolean).forEach((o) => f!.ops.add(o));
    if (e && f.sources.length < 30) {
      f.sources.push({ node: e.source, kind: e.kind, location: e.locations?.[0], conditions: conditionsOf(e) });
    }
  };

  for (const id of order) {
    const comp = comps.get(id)!;
    const proc = procId(comp.start);
    for (const epId of comp.endpoints) {
      const ep = m.node(epId);
      if (!ep) continue;
      const client = ep.attrs?.protocol === "tcp" ? "client:tcp" : "client:http";
      const req: TypeInfo[] = [];
      if (ep.attrs?.request) req.push(ep.attrs.request as TypeInfo);
      const inputs = (ep.attrs?.inputs as { name: string }[] | undefined) ?? [];
      if (inputs.length) req.push({ type: `params(${inputs.map((i) => i.name).join(", ")})` });
      flow(dataNode("in", client), proc, req, undefined, [ep.name]);
      if (ep.attrs?.response) flow(proc, dataNode("out", client), [ep.attrs.response as TypeInfo], undefined, ["response"]);
    }
    // settings the work reads: config files (by file) and environment variables
    const config = new Map<string, Set<string>>();
    const env = new Set<string>();
    for (const rid of comp.own) {
      const n = m.node(rid);
      for (const r of (n?.attrs?.configReads as { key: string; file: string }[] | undefined) ?? []) {
        if (!config.has(r.file)) config.set(r.file, new Set());
        config.get(r.file)!.add(r.key);
      }
      for (const v of (n?.attrs?.envReads as string[] | undefined) ?? []) env.add(v);
    }
    for (const [file, keys] of config) {
      flow(dataNode("in", `config:${file}`), proc, [...keys].map((k) => ({ type: k })), undefined, ["settings"]);
    }
    if (env.size) flow(dataNode("in", "env"), proc, [...env].map((k) => ({ type: k })), undefined, ["environment"]);

    for (const rid of comp.own) {
      for (const e of m.out.get(rid) ?? []) {
        if (!SIDE_EFFECTS.has(e.kind) || !m.node(e.target)) continue;
        const target = m.node(e.target)!;
        const ops = (e.attrs?.operations as string[] | undefined) ?? [];
        const tableHits = target.kind === "table" ? c.ofTable(target) : undefined;
        switch (e.kind) {
          case "consumes":
            flow(dataNode("in", e.target), proc, list(e, "payloads"), e, ["subscribe"]);
            break;
          case "reads":
            flow(dataNode("in", e.target), proc, list(e, "responses"), e, ops, tableHits);
            break;
          case "writes":
            flow(proc, dataNode("out", e.target), list(e, "payloads"), e, ops, tableHits);
            break;
          case "publishes":
            flow(proc, dataNode("out", e.target), list(e, "payloads"), e, ["publish"]);
            break;
          case "connects_to":
            flow(proc, dataNode("out", e.target), [], e, [String(e.attrs?.protocol ?? "tcp").toUpperCase()]);
            break;
          case "http_calls": {
            const call = [e.attrs?.method, e.attrs?.path].filter(Boolean).join(" ");
            flow(proc, dataNode("out", e.target), list(e, "payloads"), e, [call]);
            if (list(e, "responses").length) flow(dataNode("in", e.target), proc, list(e, "responses"), e, ["response"]);
            break;
          }
        }
      }
    }
  }

  const name = (id: string) => nodes.get(id)?.label ?? id;
  for (const f of flows.values()) {
    const types = [...f.types.values()];
    const typeText = types.length ? types.slice(0, 2).map((t) => short(t.type, 28)).join(", ") + (types.length > 2 ? ` +${types.length - 2}` : "") : "";
    const ops = [...f.ops].slice(0, 3).join(", ");
    edges.push({
      id: `${f.from}→${f.to}`, source: f.from, target: f.to, style: "data",
      label: typeText || ops || "data", sublabel: typeText && ops ? short(ops, 40) : undefined,
      count: Math.max(1, f.sources.length), sensitivity: highest(f.hits),
      conditional: f.sources.length > 0 && f.sources.every((s) => s.conditions?.length),
      info: { title: `${name(f.from)} → ${name(f.to)}`, types, classes: f.hits, sources: f.sources },
    });
  }

  // the same program as an outline: each part with what it receives and hands on
  const partOf = new Map(order.map((id) => [procId(id), id]));
  const end = (boxId: string): Omit<PartLink, "data" | "via"> => {
    const part = partOf.get(boxId);
    if (part) return { label: nodes.get(boxId)!.label, ref: nodes.get(boxId)!.ref, part: number.get(part) };
    const v = nodes.get(boxId);
    return { label: v ? `${v.label}${v.sub ? ` (${v.sub})` : ""}` : boxId, ref: v?.ref };
  };
  const parts: ProgramPart[] = order.map((id) => {
    const box = procId(id);
    const d = described.get(id)!;
    const link = (e: VEdge, other: string) => ({ link: { ...end(other), data: e.label ?? "", via: e.sublabel, control: e.style === "call" || undefined } as PartLink, other });
    const drawn: ViewModel = { nodes: [...nodes.values()], edges, direction: "RIGHT", groups: gs.list() };
    const compress = (ls: { link: PartLink; other: string }[]) => compressLinks(ls, drawn, (x) => partOf.has(x));
    return {
      id: box, ref: nodes.get(box)!.ref ?? id, n: number.get(id)!, title: d.title, kind: d.kind, code: d.code, doc: d.doc,
      inputs: compress(edges.filter((e) => e.target === box).map((e) => link(e, e.source))),
      outputs: compress(edges.filter((e) => e.source === box).map((e) => link(e, e.target))),
      steps: stepsOf.get(id)!,
    };
  });
  const root = roots.length === 1 ? roots[0] : undefined;
  const svc = root ? runningService(m, root) : undefined;
  const launchAttrs = svc?.attrs ?? {};
  const launch = root && svc
    ? [launchAttrs.jar ? `java -jar ${launchAttrs.jar}` : launchAttrs.mainClass ? `java ${launchAttrs.mainClass}` : undefined,
      launchAttrs.launch ? `(${[launchAttrs.launch, launchAttrs.declaredIn].filter(Boolean).join(", ")})` : undefined].filter(Boolean).join(" ")
    : undefined;
  const rootNode = root ? m.node(root) : undefined;
  const entryText = rootNode
    ? `${rootNode.otel?.["code.namespace"] ? `${rootNode.otel["code.namespace"]}.` : ""}${rootNode.name}(${((rootNode.attrs?.params as { type: string }[] | undefined) ?? []).map((p) => p.type).join(", ")})`
    : undefined;
  const outline: ProgramOutline = {
    controlTerms: ["started by", "starts"],
    title: root ? programName(root) : "All programs",
    launch: launch || undefined, entry: entryText, parts,
  };
  // a system with many look-alike members (eight Kafka topics) starts folded into one box
  const groups = gs.list().map((g) => {
    if (g.kind !== "system") return g;
    const members = [...nodes.values()].filter((v) => v.group === g.id).length;
    return members > 4 ? { ...g, fold: true } : g;
  });
  return { view: { nodes: [...nodes.values()], edges, direction: "RIGHT", groups, outline }, outline };
}

/** Sources and sinks that are not graph nodes. */
const PSEUDO: Record<string, { id: string; label: string; node?: string }> = {
  "client:tcp": { id: "tcp", label: "Socket (TCP)", node: "Socket clients" },
  "client:http": { id: "http", label: "HTTP", node: "HTTP clients" },
  config: { id: "config", label: "Configuration" },
  env: { id: "env", label: "Configuration", node: "Environment variables" },
};

function list(e: GraphEdge, key: "payloads" | "responses"): TypeInfo[] {
  return (e.attrs?.[key] as TypeInfo[] | undefined) ?? [];
}

/** How data moves: "PostgreSQL", "Kafka", "Redis", "External systems", "Other services". */
function mechanism(m: Model, n: GraphNode): { id: string; label: string } {
  if (SERVICES.has(n.kind)) return { id: "services", label: "Other services" };
  return systemGroup(n, m) ?? { id: n.kind, label: n.kind };
}

function dataSub(m: Model, n: GraphNode): string {
  if (n.kind === "table") {
    const db = m.node(n.parent ?? "");
    return n.attrs?.keyPattern ? `${db?.name ?? "redis"} · ${n.attrs?.redisType ?? "key"}` : `${db?.name ?? "database"} · table`;
  }
  if (n.kind === "topic" || n.kind === "queue") {
    return n.attrs?.channel ? "pub/sub channel" : `${n.otel?.["messaging.system"] ?? "messaging"} ${n.kind}`;
  }
  if (n.kind === "database") return `${n.otel?.["db.system"] ?? "database"}`;
  if (SERVICES.has(n.kind)) return "service";
  return n.attrs?.ingress ? "ingress" : "external API";
}

function dataShape(n: GraphNode): Shape {
  if (n.kind === "table") return "table";
  if (n.kind === "database") return "database";
  if (n.kind === "topic" || n.kind === "queue") return "topic";
  if (SERVICES.has(n.kind)) return "service";
  return "external";
}

// ------------------------------------------------------------------ digest

const MAX_ROWS = 18;
const IO_MARK: Record<string, string> = { reads: "⛁", writes: "⛁", publishes: "⇶", consumes: "⇶", http_calls: "⇄" };

/**
 * What a piece of work does, in order: conditions (?), loops (↻), calculations (=), calls into
 * the program (→, opened one level when they decide or touch data), work started elsewhere (⇉),
 * I/O (⛁ ⇶ ⇄), errors (!, ✕).
 */
export function digest(m: Model, fnId: string): Row[] {
  const rows: Row[] = [];
  let truncated = 0;
  const push = (marker: string, text: string, level: number, muted = false) => {
    if (rows.length >= MAX_ROWS) {
      truncated++;
      return;
    }
    const prev = rows[rows.length - 1];
    const t = "  ".repeat(level) + short(text, 72 - level * 2);
    if (prev && prev.text === t && prev.marker === marker) return;
    rows.push({ marker, text: t, muted });
  };

  const calls = (cs: CallStep[] | undefined, level: number, stack: string[]) => {
    const depth = stack.length - 1; // calls opened so far, independent of indentation
    for (const c of cs ?? []) {
      if (c.kind !== "calls") {
        push(IO_MARK[c.kind] ?? "•", c.name || `${c.kind} ${m.node(c.target)?.name ?? ""}`, level);
        continue;
      }
      const target = m.node(c.target);
      if (!target || isAccessor(m, c.target)) continue;
      if (c.async) {
        push("⇉", `${c.async === "scheduled" ? "schedule" : c.async === "shutdown" ? "on shutdown" : "start"} ${fnLabel(m, c.target)}`, level);
        continue;
      }
      push("→", fnLabel(m, c.target), level, !worthOpening(m, c.target));
      if (depth < 2 && !stack.includes(c.target) && worthOpening(m, c.target)) {
        walk(controlFlowOf(target) ?? [], level + 1, [...stack, c.target]);
      }
    }
  };
  const items = (its: Item[], level: number, stack: string[]) => {
    for (const it of its) {
      if (it.calls?.length) calls(it.calls, level, stack);
      else if (isCalculation(it.text)) push("=", it.text.replace(/;\s*$/, ""), level);
    }
  };
  const walk = (steps: Step[], level: number, stack: string[]) => {
    for (const s of steps) {
      if (rows.length >= MAX_ROWS) {
        truncated++;
        return;
      }
      switch (s.k) {
        case "do":
          items(s.items ?? [], level, stack);
          break;
        case "block":
        case "sync":
          walk(s.body ?? [], level, stack);
          break;
        case "if":
          calls(s.calls, level, stack);
          push("?", `if ${s.cond ?? ""}`, level);
          walk(s.then ?? [], level + 1, stack);
          if (s.else?.length) {
            push("?", "else", level);
            walk(s.else, level + 1, stack);
          }
          break;
        case "switch":
          calls(s.calls, level, stack);
          push("?", `switch ${s.on ?? ""}`, level);
          for (const c of s.cases ?? []) {
            push("?", `case ${c.label}`, level + 1);
            walk(c.body, level + 2, stack);
          }
          break;
        case "loop":
          calls(s.calls, level, stack);
          push("↻", s.text ?? "loop", level);
          walk(s.body ?? [], level + 1, stack);
          break;
        case "try":
          calls(s.calls, level, stack); // try (resources) { ... }
          walk(s.body ?? [], level, stack);
          for (const c of s.catches ?? []) {
            push("!", `on ${c.type}`, level);
            walk(c.body, level + 1, stack);
          }
          walk(s.finally ?? [], level, stack);
          break;
        case "throw":
          push("✕", `throw ${s.text ?? ""}`, level);
          break;
        case "return":
          calls(s.calls, level, stack);
          break;
        case "jump":
          if (s.text === "continue" || s.text === "break") push("↷", s.text, level, true);
          break;
      }
    }
  };

  walk(controlFlowOf(m.node(fnId)) ?? [], 0, [fnId]);
  if (truncated) rows.push({ text: `… more (open Activity for the full flow)`, muted: true });
  return rows;
}

/** A callee is opened when it decides something or touches data (directly or below it). */
function worthOpening(m: Model, id: string): boolean {
  const cf = controlFlowOf(m.node(id));
  if (cf?.some((s) => ["if", "switch", "loop", "try"].includes(s.k))) return true;
  for (const r of reachable(m, id, 40, 4).keys()) {
    if ((m.out.get(r) ?? []).some((e) => SIDE_EFFECTS.has(e.kind))) return true;
  }
  return false;
}

/** `double pnl = (mid - avg) * qty;` and `total += x;` — arithmetic, not string building or construction. */
export function isCalculation(text: string): boolean {
  const t = text.trim().replace(/;\s*$/, "");
  const mm = /^(?:[\w<>[\],?. ]+\s+)?[\w.[\]]+\s*([-+*/%]?=)(?!=)\s*(.+)$/.exec(t);
  if (!mm) return false;
  const rhs = mm[2];
  if (/["']/.test(rhs) || /^new\s/.test(rhs)) return false;
  return mm[1] !== "=" || /[-+*/%]/.test(rhs.replace(/->/g, ""));
}

function fnLabel(m: Model, id: string): string {
  const n = m.node(id);
  if (!n) return id;
  const owner = n.parent ? m.node(n.parent) : undefined;
  const name = n.name === "<init>" ? "new" : n.name;
  return owner && TYPES.has(owner.kind) ? `${owner.name}.${name}` : name;
}

