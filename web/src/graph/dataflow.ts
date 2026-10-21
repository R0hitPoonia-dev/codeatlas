// Data flow diagrams (DFD): external entities, processes and data stores, with every flow
// labelled by the data types it carries and the sensitive categories inside them.
//   Level 0 (context): the whole system is one process; only the outside world around it.
//   Level 1 (system): processes are services.
//   Level 2 (one service): processes are its entry points (endpoints, socket servers,
//   message consumers, scheduled jobs, threads, startup), grouped into pipelines.
import type { GraphEdge, GraphNode } from "../api";
import { CLASS_INFO, Classifier, ClassHits, highest, mergeHits, TypeInfo } from "./dataclass";
import { Model } from "./model";
import { effectsOf, effectText, lower, names, withReading } from "./reading";
import { FlowInfo, GroupSet, reachable, SIDE_EFFECTS, systemOf, VEdge, VGroup, VNode, ViewModel } from "./views";

const CLIENT = "dfd:client";
const SOCKET_CLIENT = "dfd:client:tcp";
const SYSTEM = "dfd:system";
const SERVICES = new Set(["service", "module"]);

type Source = FlowInfo["sources"][number];

interface Flow {
  from: string;
  to: string;
  types: Map<string, TypeInfo>;
  hits: ClassHits;
  sources: Source[];
}

/** Accumulates flows between two diagram nodes. */
class Flows {
  private flows = new Map<string, Flow>();

  constructor(private c: Classifier) {}

  add(from: string, to: string, types: TypeInfo[], source?: Source, extra?: ClassHits) {
    if (from === to) return;
    const key = `${from}→${to}`;
    let f = this.flows.get(key);
    if (!f) {
      f = { from, to, types: new Map(), hits: new Map(), sources: [] };
      this.flows.set(key, f);
    }
    for (const t of types) {
      if (!f.types.has(t.type)) {
        f.types.set(t.type, t);
        mergeHits(f.hits, this.c.ofPayload(t));
      }
    }
    if (extra) mergeHits(f.hits, extra);
    if (source && f.sources.length < 30 && !f.sources.some((s) => s.node === source.node && s.kind === source.kind)) {
      f.sources.push(source);
    }
  }

  /** The same flows with endpoints renamed by `to` (undefined drops a flow); flows that meet are merged. */
  remap(to: (id: string) => string | undefined): Flows {
    const out = new Flows(this.c);
    for (const f of this.flows.values()) {
      const from = to(f.from);
      const target = to(f.to);
      if (!from || !target || from === target) continue;
      out.add(from, target, [...f.types.values()], f.sources[0], f.hits);
      for (const src of f.sources.slice(1)) out.add(from, target, [], src);
    }
    return out;
  }

  /** Every node at either end of some flow. */
  ends(): Set<string> {
    return new Set([...this.flows.values()].flatMap((f) => [f.from, f.to]));
  }

  /** Flow keys (other end + direction + types) of a node, to spot processes that do the same thing. */
  signature(id: string): string {
    const parts: string[] = [];
    for (const f of this.flows.values()) {
      if (f.from === id) parts.push(`>${f.to}:${[...f.types.keys()].sort().join(",")}`);
      if (f.to === id) parts.push(`<${f.from}:${[...f.types.keys()].sort().join(",")}`);
    }
    return parts.sort().join("|");
  }

  edges(name: (id: string) => string): VEdge[] {
    return [...this.flows.values()].map((f) => {
      const types = [...f.types.values()];
      const typeText = types.length
        ? types.slice(0, 2).map((t) => shortType(t.type)).join(", ") + (types.length > 2 ? ` +${types.length - 2}` : "")
        : "data";
      const sensitive = [...f.hits.keys()]
        .filter((c) => CLASS_INFO[c].severity !== "low")
        .sort((a, b) => (CLASS_INFO[a].severity === "high" ? 0 : 1) - (CLASS_INFO[b].severity === "high" ? 0 : 1))
        .map((c) => CLASS_INFO[c].label);
      const sublabel = sensitive.length ? `⚠ ${sensitive.slice(0, 3).join(", ")}${sensitive.length > 3 ? ` +${sensitive.length - 3}` : ""}` : undefined;
      return {
        id: `${f.from}→${f.to}`,
        source: f.from,
        target: f.to,
        style: "data",
        count: Math.max(1, f.sources.length),
        label: typeText,
        sublabel,
        sensitivity: highest(f.hits),
        // dashed when every code site producing this flow runs only under some condition
        conditional: f.sources.length > 0 && f.sources.every((s) => s.conditions?.length),
        info: { title: `${name(f.from)} → ${name(f.to)}`, types, classes: f.hits, sources: f.sources },
      };
    });
  }
}

function shortType(t: string) {
  return t.length > 28 ? t.slice(0, 26) + "…" : t;
}

function list(e: GraphEdge, key: "payloads" | "responses"): TypeInfo[] {
  return (e.attrs?.[key] as TypeInfo[] | undefined) ?? [];
}

function source(e: GraphEdge, node = e.source): Source {
  return {
    node,
    kind: e.kind,
    location: e.locations?.[0],
    conditions: e.attrs?.unconditional ? undefined : (e.attrs?.conditions as string[] | undefined),
  };
}

/** The outside party that calls an endpoint: TCP clients for socket servers, else clients/users. */
function clientOf(ep: GraphNode): string {
  return ep.attrs?.protocol === "tcp" ? SOCKET_CLIENT : CLIENT;
}

/** Request body + path/query inputs of an endpoint, as payload descriptors. */
function endpointInput(ep: GraphNode): TypeInfo[] {
  const out: TypeInfo[] = [];
  if (ep.attrs?.request) out.push(ep.attrs.request as TypeInfo);
  const inputs = (ep.attrs?.inputs as { name: string }[] | undefined) ?? [];
  if (inputs.length) out.push({ type: `params(${inputs.map((i) => i.name).join(", ")})` });
  return out;
}

/** Payloads a consumer receives: its own declared type, else what producers publish to the topic. */
function consumedTypes(m: Model, consumes: GraphEdge): TypeInfo[] {
  const own = list(consumes, "payloads");
  if (own.length) return own;
  return (m.in.get(consumes.target) ?? []).filter((e) => e.kind === "publishes").flatMap((e) => list(e, "payloads"));
}

/** Services reachable from outside: behind an ingress, or not called by any other service. */
function publicServices(m: Model): Set<string> {
  const calledInternally = new Set<string>();
  const ingress = new Set<string>();
  for (const e of m.graph.edges) {
    if (e.kind === "http_calls" && SERVICES.has(m.node(e.target)?.kind ?? "")) calledInternally.add(e.target);
    if (e.kind === "connects_to" && m.node(e.source)?.attrs?.ingress) {
      for (const d of m.out.get(e.target) ?? []) if (d.kind === "deploys") ingress.add(d.target);
    }
  }
  return new Set(m.services().map((s) => s.id).filter((id) => ingress.has(id) || !calledInternally.has(id)));
}

function storeSub(m: Model, n: GraphNode) {
  if (n.kind === "table") return m.node(n.parent ?? "")?.name ?? "table";
  if (n.kind === "database") return n.otel?.["db.system"] && n.otel["db.system"] !== "unknown" ? n.otel["db.system"] : "database";
  return n.otel?.["messaging.system"] ?? n.kind;
}

function dfdNode(m: Model, id: string, faded = false): VNode {
  if (id === CLIENT) return { id, label: "Clients / users", sub: "external entity", shape: "entity" };
  if (id === SOCKET_CLIENT) return { id, label: "Socket clients", sub: "external entity · TCP", shape: "entity" };
  const n = m.node(id)!;
  switch (n.kind) {
    case "service":
    case "module":
      return { id, ref: id, label: n.name, sub: faded ? "other service" : "process", shape: faded ? "entity" : "process", faded };
    case "database":
    case "table":
    case "topic":
    case "queue":
      return { id, ref: id, label: n.name, sub: storeSub(m, n), shape: "store" };
    default:
      return { id, ref: id, label: n.name, sub: n.attrs?.ingress ? "ingress" : "external system", shape: "entity" };
  }
}

// ------------------------------------------------------------------ level 1

export function systemDataFlow(m: Model, onlySensitive = false): ViewModel {
  const c = new Classifier(m);
  return withReading(finish(m, systemFlows(m, c), onlySensitive, new Set(), "No services or data flows found."),
    { title: "Data flow · system", middle: "Processes", middleSub: "services, in the order data moves through them" });
}

/** Level-1 flows: between services, their data stores, topics, external systems and clients. */
function systemFlows(m: Model, c: Classifier): Flows {
  const flows = new Flows(c);

  for (const e of m.graph.edges) {
    if (!SIDE_EFFECTS.has(e.kind)) continue;
    const procs = m.appsOf(e.source).filter((n) => SERVICES.has(n.kind));
    const target = m.node(e.target);
    if (!procs.length || !target) continue;
    const src = source(e);
    for (const proc of procs) {
      switch (e.kind) {
        case "http_calls":
        case "connects_to": {
          for (const other of m.appsOf(target.id)) {
            if (other.id === proc.id) continue;
            flows.add(proc.id, other.id, list(e, "payloads"), src);
            if (list(e, "responses").length) flows.add(other.id, proc.id, list(e, "responses"), src);
          }
          break;
        }
        case "reads":
        case "writes": {
          const db = target.kind === "table" ? m.node(target.parent ?? "") ?? target : target;
          const hits = target.kind === "table" ? c.ofTable(target) : undefined;
          if (e.kind === "writes") flows.add(proc.id, db.id, list(e, "payloads"), src, hits);
          else flows.add(db.id, proc.id, list(e, "responses"), src, hits);
          break;
        }
        case "publishes":
          flows.add(proc.id, target.id, list(e, "payloads"), src);
          break;
        case "consumes":
          flows.add(target.id, proc.id, consumedTypes(m, e), src);
          break;
      }
    }
  }

  const exposed = publicServices(m);
  for (const ep of m.ofKind("endpoint")) {
    const src: Source = { node: ep.id, kind: "endpoint", location: ep.location };
    for (const svc of m.appsOf(ep.id)) {
      if (!SERVICES.has(svc.kind) || !exposed.has(svc.id)) continue;
      flows.add(clientOf(ep), svc.id, endpointInput(ep), src);
      if (ep.attrs?.response) flows.add(svc.id, clientOf(ep), [ep.attrs.response as TypeInfo], src);
    }
  }
  return flows;
}

// ------------------------------------------------------------------ level 0

/**
 * Context diagram: the system as one process. Services and the data stores they use are
 * inside it; topics stay outside only when the system publishes or consumes them but not
 * both (someone else is on the other end). Everything else is an external entity.
 */
export function contextDataFlow(m: Model, systemName: string, onlySensitive = false): ViewModel {
  const c = new Classifier(m);
  const published = new Set<string>();
  const consumed = new Set<string>();
  for (const e of m.graph.edges) {
    if (e.kind === "publishes") published.add(e.target);
    if (e.kind === "consumes") consumed.add(e.target);
  }
  const inside = (id: string) => {
    const n = m.node(id);
    if (!n) return false;
    if (SERVICES.has(n.kind) || n.kind === "database" || n.kind === "table") return true;
    if (n.kind === "topic" || n.kind === "queue") return published.has(id) && consumed.has(id);
    return false;
  };
  const flows = systemFlows(m, c).remap((id) => (inside(id) ? SYSTEM : id));
  const system: VNode = { id: SYSTEM, label: systemName, sub: "the system · click to open level 1", shape: "process" };
  const view = finish(m, flows, onlySensitive, new Set(), "No data crosses the system boundary.", new Map([[SYSTEM, system]]));
  // the outside world grouped by kind; the system itself stays ungrouped
  const gs = new GroupSet();
  for (const v of view.nodes) {
    if (v.id === SYSTEM) {
      v.group = undefined;
      continue;
    }
    const n = m.node(v.ref ?? v.id);
    v.group = v.id === CLIENT || v.id === SOCKET_CLIENT ? gs.add({ id: "ctx:users", label: "Users & clients", kind: "role" })
      : n?.kind === "topic" || n?.kind === "queue" ? gs.add({ id: "ctx:messaging", label: "Shared topics & queues", kind: "role" })
        : gs.add({ id: "ctx:external", label: "External systems", kind: "role" });
  }
  return withReading({ ...view, groups: gs.list() }, { title: `Data flow · ${systemName}`, middle: "The system", middleSub: "everything in this repo" });
}

export { SYSTEM as DFD_SYSTEM };

// ------------------------------------------------------------------ level 2

export type EntryKind = "http" | "socket" | "consumer" | "scheduled" | "thread" | "main";

export interface Entry {
  id: string;
  label: string;
  kind: EntryKind;
  start?: string;
  consumes?: GraphEdge[];
}

export const ENTRY_GROUPS: Record<EntryKind, string> = {
  http: "HTTP endpoints", socket: "Socket endpoints", consumer: "Message consumers",
  scheduled: "Scheduled jobs", thread: "Background threads", main: "Startup",
};
const ENTRY_ORDER: EntryKind[] = ["http", "socket", "consumer", "scheduled", "thread", "main"];

/**
 * Where work starts in a service: endpoints (HTTP and socket), methods that consume a topic,
 * and methods the analyzer marked as entry points (attrs.entryPoint: scheduled, thread, main).
 */
export function entryPoints(m: Model, serviceId: string): Entry[] {
  const inside = m.codeScope(serviceId);
  const out: Entry[] = [];
  for (const ep of m.ofKind("endpoint")) {
    if (!inside.has(ep.id)) continue;
    const handler = (m.out.get(ep.id) ?? []).find((e) => e.kind === "handles")?.target;
    out.push({ id: ep.id, label: ep.name, kind: ep.attrs?.protocol === "tcp" ? "socket" : "http", start: handler });
  }
  const consumers = new Map<string, GraphEdge[]>();
  for (const e of m.graph.edges) {
    if (e.kind === "consumes" && inside.has(e.source)) consumers.set(e.source, [...(consumers.get(e.source) ?? []), e]);
  }
  for (const [method, edges] of consumers) {
    out.push({ id: method, label: `on ${edges.map((e) => m.node(e.target)?.name).join(", ")}`, kind: "consumer", start: method, consumes: edges });
  }
  for (const id of inside) {
    const n = m.node(id)!;
    const kind = n.attrs?.entryPoint as EntryKind | undefined;
    if (!kind || consumers.has(id) || !ENTRY_ORDER.includes(kind)) continue;
    out.push({ id, label: `${ownerName(m, n)}${n.name}`, kind, start: id });
  }
  return out.sort((a, b) => ENTRY_ORDER.indexOf(a.kind) - ENTRY_ORDER.indexOf(b.kind) || a.label.localeCompare(b.label));
}

function ownerName(m: Model, n: GraphNode): string {
  const owner = n.parent ? m.node(n.parent) : undefined;
  return owner && ["class", "interface", "enum"].includes(owner.kind) ? `${owner.name}.` : "";
}

export function serviceDataFlow(m: Model, serviceId: string, onlySensitive = false): ViewModel {
  const svc = m.node(serviceId);
  if (!svc) return { nodes: [], edges: [], direction: "RIGHT", empty: "Pick a service." };
  const c = new Classifier(m);
  const flows = new Flows(c);
  const processes = new Map<string, VNode>();
  const exposed = publicServices(m).has(serviceId);
  const otherServices = new Set<string>();

  const entries = entryPoints(m, serviceId);
  entries.forEach((entry) => {
    const pid = `dfd:p:${entry.id}`;
    const n = m.node(entry.id)!;
    processes.set(pid, { id: pid, ref: entry.id, label: entryTitle(m, entry), sub: `${entry.label} · ${svc.name}`, shape: "process" });

    if (n.kind === "endpoint") {
      const src: Source = { node: n.id, kind: "endpoint", location: n.location };
      // A caller is shown as "clients" when the service is public, else as the calling services.
      const callers = n.attrs?.protocol === "tcp" ? [SOCKET_CLIENT] : exposed ? [CLIENT] : callersOf(m, serviceId);
      for (const caller of callers.length ? callers : [CLIENT]) {
        if (caller !== CLIENT) otherServices.add(caller);
        flows.add(caller, pid, endpointInput(n), src);
        if (n.attrs?.response) flows.add(pid, caller, [n.attrs.response as TypeInfo], src);
      }
    }
    for (const e of entry.consumes ?? []) flows.add(e.target, pid, consumedTypes(m, e), source(e));

    if (!entry.start) return;
    for (const id of reachable(m, entry.start).keys()) {
      for (const e of m.out.get(id) ?? []) {
        if (!SIDE_EFFECTS.has(e.kind) || e.kind === "consumes") continue;
        const target = m.node(e.target);
        if (!target) continue;
        const src = source(e);
        switch (e.kind) {
          case "http_calls":
          case "connects_to": {
            for (const other of m.appsOf(target.id)) {
              if (other.id === serviceId) continue;
              if (SERVICES.has(other.kind)) otherServices.add(other.id);
              flows.add(pid, other.id, list(e, "payloads"), src);
              if (list(e, "responses").length) flows.add(other.id, pid, list(e, "responses"), src);
            }
            break;
          }
          case "reads":
            flows.add(target.id, pid, list(e, "responses"), src, target.kind === "table" ? c.ofTable(target) : undefined);
            break;
          case "writes":
            flows.add(pid, target.id, list(e, "payloads"), src, target.kind === "table" ? c.ofTable(target) : undefined);
            break;
          case "publishes":
            flows.add(pid, target.id, list(e, "payloads"), src);
            break;
        }
      }
    }
  });

  // processes that receive and send exactly the same data are one flow with variants
  const bySignature = new Map<string, string[]>();
  for (const entry of entries) {
    const pid = `dfd:p:${entry.id}`;
    const sig = flows.signature(pid);
    // only real work counts as "the same flow": two endpoints that just answer the caller differ by route
    const touchesData = sig.split("|").some((part) => !part.startsWith(`<${CLIENT}:`) && !part.startsWith(`>${CLIENT}:`)
      && !part.startsWith(`<${SOCKET_CLIENT}:`) && !part.startsWith(`>${SOCKET_CLIENT}:`));
    if (sig && touchesData) bySignature.set(`${entry.kind}|${sig}`, [...(bySignature.get(`${entry.kind}|${sig}`) ?? []), pid]);
  }
  const foldedInto = new Map<string, string>();
  for (const pids of bySignature.values()) {
    if (pids.length < 2) continue;
    const keep = processes.get(pids[0])!;
    keep.label = `${keep.label} ×${pids.length}`;
    keep.sub = `same flow in ${pids.map((p) => variantName(m, processes.get(p)!)).join(", ")}`;
    for (const p of pids.slice(1)) foldedInto.set(p, pids[0]);
  }
  const folded = foldedInto.size ? flows.remap((id) => foldedInto.get(id) ?? id) : flows;
  for (const p of foldedInto.keys()) processes.delete(p);

  // group what is drawn (processes that move data): kind of entry point, then pipeline; the
  // reading pass numbers them in the order data moves
  const groups: VGroup[] = [];
  const drawn = folded.ends();
  for (const entry of entries) {
    const v = processes.get(`dfd:p:${entry.id}`);
    if (!v || !drawn.has(v.id)) continue;
    const kindId = `proc:${entry.kind}`;
    if (!groups.some((g) => g.id === kindId)) groups.push({ id: kindId, label: ENTRY_GROUPS[entry.kind], kind: "role" });
    v.group = kindId;
    const topics = (entry.consumes ?? []).map((e) => m.node(e.target)?.name).filter(Boolean);
    if (topics.length === 1) {
      const pipeId = `pipe:${topics[0]}`;
      if (!groups.some((g) => g.id === pipeId)) {
        groups.push({ id: pipeId, label: `${topics[0]} pipeline`, sub: `consumers of ${topics[0]}`, kind: "role", parent: kindId });
      }
      v.group = pipeId;
    }
  }
  return withReading(finish(m, folded, onlySensitive, otherServices, `${svc.name} has no entry points.`, processes, groups),
    { title: `Data flow · inside ${svc.name}`, middle: "Processes", middleSub: `where work starts in ${svc.name}` });
}

/**
 * What an entry point does, for its process box: "Receive ConnectorPacket", "Serve GET
 * /orders", "Consume fills · write fill:*", else what its work does with data.
 */
function entryTitle(m: Model, entry: Entry): string {
  const n = m.node(entry.id);
  const reach = entry.start ? [...reachable(m, entry.start, 150, 12).keys()] : [];
  if (n?.kind === "endpoint") {
    const req = (n.attrs?.request as TypeInfo | undefined)?.type;
    return entry.kind === "socket" ? (req ? `Receive ${req}` : `Serve ${n.name}`) : `Serve ${n.name}`;
  }
  const fx = effectsOf(m, reach);
  if (entry.kind === "main") {
    // start-up: what it does itself (the consumers it creates subscribe in their own process box)
    const does = effectText(m, fx, true);
    return does ? `Start-up · ${lower(does)}` : "Start-up";
  }
  const consumed = (entry.consumes ?? []).map((e) => m.node(e.target)).filter((t): t is GraphNode => !!t);
  if (consumed.length) {
    const then = effectText(m, fx, true, 1);
    return `Consume ${names(consumed)}${then ? ` · ${lower(then)}` : ""}`;
  }
  const does = effectText(m, fx);
  if (entry.kind === "scheduled") return does ? `Scheduled: ${lower(does)}` : entry.label;
  return does ?? entry.label;
}

/** "TradeConsumerThread" for a process started at TradeConsumerThread.run. */
function variantName(m: Model, v: VNode): string {
  const n = m.node(v.ref ?? "");
  if (!n) return v.label;
  if (n.kind === "endpoint") return n.name;
  const owner = n.parent ? m.node(n.parent) : undefined;
  return owner && ["class", "interface", "enum"].includes(owner.kind) ? owner.name : n.name;
}

function callersOf(m: Model, serviceId: string): string[] {
  const callers = new Set<string>();
  for (const e of m.in.get(serviceId) ?? []) {
    if (e.kind !== "http_calls") continue;
    for (const caller of m.appsOf(e.source)) {
      if (SERVICES.has(caller.kind) && caller.id !== serviceId) callers.add(caller.id);
    }
  }
  return [...callers];
}

function finish(m: Model, flows: Flows, onlySensitive: boolean, faded: Set<string>, empty: string,
  extra = new Map<string, VNode>(), extraGroups: VGroup[] = []): ViewModel {
  const name = (id: string) => extra.get(id)?.label ?? (id === CLIENT ? "Clients" : m.node(id)?.name ?? id);
  let edges = flows.edges(name);
  if (onlySensitive) edges = edges.filter((e) => e.sensitivity === "high" || e.sensitivity === "medium");
  const used = new Set(edges.flatMap((e) => [e.source, e.target]));
  const nodes: VNode[] = [...used].map((id) => extra.get(id) ?? dfdNode(m, id, faded.has(id)));

  // stores grouped by data system (tables inside their database), other services together,
  // and level-2 processes split into HTTP endpoints vs message consumers
  const gs = new GroupSet();
  extraGroups.forEach((g) => gs.add(g));
  for (const v of nodes) {
    const n = m.node(v.ref ?? v.id);
    if (extra.has(v.id)) {
      // processes arrive grouped by the caller (or not at all)
    } else if (n?.kind === "table") {
      const db = m.node(n.parent ?? "");
      const sys = systemOf(gs, m, n);
      v.group = db ? gs.add({ id: `db:${db.id}`, label: db.name, kind: "database", parent: sys }) : sys;
    } else if (n && faded.has(n.id)) {
      v.group = gs.add({ id: "other-services", label: "Other services", kind: "service" });
    } else if (n) {
      v.group = systemOf(gs, m, n);
    }
  }
  return { nodes, edges, direction: "RIGHT", empty: onlySensitive ? "No flows carry sensitive data." : empty, groups: gs.list() };
}

export { CLIENT as DFD_CLIENT };
