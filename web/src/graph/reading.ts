// How every diagram reads, the way the Program tab does:
//   - boxes say what they do (the effects of their code, their doc comment), not only a name;
//   - lines carry the data types that move along them, with the verb underneath;
//   - data comes in on the left (Data in) and goes out on the right (Data out); a store or
//     topic one part writes and another reads sits between them, with the parts;
//   - the parts that do the work are numbered in the order data moves through them;
//   - a system with many look-alike members (eight Kafka topics) starts folded;
//   - the same diagram as an outline: each part with what it receives and hands on.
import type { GraphEdge, GraphNode } from "../api";
import type { Model } from "./model";
import type { EdgeStyle, Row, Shape, VEdge, VGroup, VNode, ViewModel } from "./views";

const TYPES = new Set(["class", "interface", "enum"]);
const SIDE = new Set(["reads", "writes", "publishes", "consumes", "http_calls", "connects_to"]);

// ------------------------------------------------------------------ outline

/** Something a part receives or hands on. */
export interface PartLink {
  /** The other end: a data store, a topic, a client, or another part ("3. Publish to Kafka"). */
  label: string;
  /** Graph node of the other end, when it is one. */
  ref?: string;
  /** The other part's number, when the other end is a part. */
  part?: number;
  /** The data: types, fields, settings. */
  data: string;
  /** How it moves: via KafkaManager.submit, queue persistQueue, shared state, SELECT, publish. */
  via?: string;
  /** Only a start or a use (opens, starts, uses): no data is named along it. */
  control?: boolean;
}

/** One part of a diagram, as the outline lists it. */
export interface OutlinePart {
  /** Box id in the diagram. */
  id: string;
  /** Graph node shown when the part is picked. */
  ref: string;
  /** Position in the order data moves through the diagram. */
  n: number;
  title: string;
  /** What kind of thing it is: entry point, socket server · :5001, service, package… */
  kind: string;
  /** The code that does it (Class.method), when there is one. */
  code?: string;
  /** The first sentence of its doc comment. */
  doc?: string;
  inputs: PartLink[];
  outputs: PartLink[];
  /** What it does, in order (a function's steps, a class's members). */
  steps: Row[];
}

export interface Outline {
  title: string;
  /** How the program is started: java -jar producer-1.0.jar (maven-shade, pom.xml). */
  launch?: string;
  /** The entry point: producer.Main.main(String[]). */
  entry?: string;
  parts: OutlinePart[];
  /** What the outline's steps are called ("steps", "members", "columns"). */
  stepsLabel?: string;
  /** What links naming no data are called, coming in and going out (default "used by" / "uses"). */
  controlTerms?: [string, string];
}

// ------------------------------------------------------------- what code does

/** The data stores, topics and systems some code touches, by kind of effect. */
export function effectsOf(m: Model, ids: Iterable<string>): Map<string, GraphNode[]> {
  const out = new Map<string, GraphNode[]>();
  for (const id of ids) {
    for (const e of m.out.get(id) ?? []) {
      const t = m.node(e.target);
      if (!SIDE.has(e.kind) || !t) continue;
      const list = out.get(e.kind) ?? [];
      if (!list.some((x) => x.id === t.id)) list.push(t);
      out.set(e.kind, list);
    }
  }
  return out;
}

export function names(ns: GraphNode[], max = 2): string {
  const shown = ns.slice(0, max).map((n) => n.name);
  return ns.length > max ? `${shown.join(", ")} +${ns.length - max}` : shown.join(", ");
}

/** The messaging or storage system a node belongs to: Kafka, Redis, PostgreSQL. */
function systemName(m: Model, n: GraphNode): string | undefined {
  const sys = n.otel?.["messaging.system"] ?? n.otel?.["db.system"] ?? m.node(n.parent ?? "")?.otel?.["db.system"];
  if (!sys || sys === "unknown") return undefined;
  return { kafka: "Kafka", rabbitmq: "RabbitMQ", redis: "Redis", postgresql: "PostgreSQL", mysql: "MySQL", mongodb: "MongoDB" }[sys] ?? sys;
}

/** "publish to Kafka (8 topics)", "write trade_book" — the main things code does with data. */
export function effectText(m: Model, fx: Map<string, GraphNode[]>, skipConsumes = false, max = 2): string | undefined {
  const parts: string[] = [];
  const consumes = fx.get("consumes") ?? [];
  if (consumes.length && !skipConsumes) parts.push(`consume ${names(consumes)}`);
  const topics = fx.get("publishes") ?? [];
  if (topics.length) {
    const sys = systemName(m, topics[0]);
    parts.push(topics.length > 2 && sys ? `publish to ${sys} (${topics.length} topics)` : `publish ${names(topics)}`);
  }
  const writes = fx.get("writes") ?? [];
  if (writes.length) parts.push(`write ${names(writes)}`);
  const http = fx.get("http_calls") ?? [];
  if (http.length) parts.push(`call ${names(http)}`);
  const connects = fx.get("connects_to") ?? [];
  if (connects.length) parts.push(`connect to ${names(connects)}`);
  const reads = (fx.get("reads") ?? []).filter((r) => !writes.includes(r)); // a store it writes says enough
  if (reads.length && parts.length < max) parts.push(`read ${names(reads)}`);
  if (!parts.length) return undefined;
  const text = parts.slice(0, max).join(" · ");
  return capitalize(text);
}

/**
 * One row saying what a box's code does with data, from every method under it (or the
 * given code): "Consume fills · publish to Redis (3 topics)".
 */
export function doesRow(m: Model, code: Iterable<string>, max = 2): Row | undefined {
  const text = effectText(m, effectsOf(m, code), false, max);
  return text ? { marker: "↦", text } : undefined;
}

export function humanize(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z])([A-Z][a-z])/g, "$1 $2").toLowerCase();
}

export function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

export function lower(s: string): string {
  return s ? s[0].toLowerCase() + s.slice(1) : s;
}

export function short(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/** The first sentence of a doc comment, trimmed for a box. */
export function firstSentence(doc: unknown, max = 90): string | undefined {
  if (typeof doc !== "string" || !doc.trim()) return undefined;
  const s = doc.trim().split(/(?<=[.!?])\s/)[0].replace(/[.]$/, "");
  return short(s, max);
}

/** "OrderService.place" for a method, the bare name for a function. */
export function codeLabel(m: Model, id: string): string {
  const n = m.node(id);
  if (!n) return id;
  const owner = n.parent ? m.node(n.parent) : undefined;
  const name = n.name === "<init>" ? "new" : n.name;
  return owner && TYPES.has(owner.kind) ? `${owner.name}.${name}` : name;
}

/**
 * What a function is called on a diagram: its doc comment's first sentence, else what it does
 * with data, else its own name; the code it is (Class.method) goes underneath.
 */
export function functionTitle(m: Model, id: string): { title: string; code: string } {
  const n = m.node(id);
  const code = codeLabel(m, id);
  if (!n) return { title: code, code };
  const doc = firstSentence(n.attrs?.doc, 56);
  if (doc) return { title: doc, code };
  const does = effectText(m, effectsOf(m, [id]));
  return { title: does ?? code, code };
}

// ------------------------------------------------------------- typed lines

/** "a: int, b: String" → the types alone, generic arguments kept. */
function paramTypes(n: GraphNode | undefined): string[] {
  return ((n?.attrs?.params as { name: string; type: string }[] | undefined) ?? []).map((p) => p.type);
}

/**
 * The data types an edge carries the way it is drawn (from where data comes from): what is
 * written, published or sent; what a read or a consumed topic delivers; the arguments a call
 * passes; the request an endpoint receives.
 */
export function edgeTypes(m: Model, e: GraphEdge): string[] {
  const list = (key: string) => ((e.attrs?.[key] as { type: string }[] | undefined) ?? []).map((t) => t.type);
  switch (e.kind) {
    case "writes":
    case "publishes":
    case "consumes":
      return list("payloads");
    case "http_calls":
      return list("payloads").length ? list("payloads") : list("responses");
    case "reads":
      return list("responses");
    case "calls":
      return paramTypes(m.node(e.target));
    case "handles": {
      const req = m.node(e.source)?.attrs?.request as { type: string } | undefined;
      return req ? [req.type] : [];
    }
  }
  return [];
}

/** Up to three types for a line: "Order, Payment +2". */
export function typeText(types: Iterable<string>, max = 3, width = 28): string {
  const all = [...new Set(types)].filter(Boolean);
  const shown = all.slice(0, max).map((t) => short(t, width)).join(", ");
  return all.length > max ? `${shown} +${all.length - max}` : shown;
}

// -------------------------------------------------------------- lanes etc.

export interface ReadingOptions {
  /** The outline's title. */
  title: string;
  /** What the parts in the middle are: "Programs", "Packages", "Code". Without it, no lanes. */
  middle?: string;
  middleSub?: string;
  /** Number the parts on the diagram (the outline always numbers them). */
  number?: boolean;
  /** Which boxes are parts (do work); by default every box that is not data and not faded. */
  isPart?: (n: VNode) => boolean;
  /** What the outline's steps are called. */
  stepsLabel?: string;
}

const DATA_SHAPES = new Set<Shape>(["database", "table", "topic", "queue", "external", "ingress", "entity", "store"]);
/** Lines along which data or work moves (structure such as inheritance does not order anything). */
const MOVES = new Set<EdgeStyle>(["data", "publish", "consume", "http", "connect", "handles", "uses", "sets", "call", "depends"]);
const LANE_IN = "lane:in";
const LANE_MID = "lane:mid";
const LANE_OUT = "lane:out";

/**
 * Applies the reading rules to a diagram: lanes (when options.middle is set), numbering,
 * folding of big data systems, and the outline. Edges must already point the way data moves.
 */
export function withReading(view: ViewModel, opts: ReadingOptions): ViewModel {
  if (!view.nodes.length) return view;
  const isPart = opts.isPart ?? ((n: VNode) => !DATA_SHAPES.has(n.shape) && !n.faded);
  const parts = view.nodes.filter(isPart);
  const partIds = new Set(parts.map((p) => p.id));
  const byId = new Map(view.nodes.map((n) => [n.id, n]));

  // order: longest path from where data starts, over the lines that move data or work
  const next = new Map<string, string[]>();
  for (const e of view.edges) {
    if (!MOVES.has(e.style) || e.source === e.target || !byId.has(e.source) || !byId.has(e.target)) continue;
    next.set(e.source, [...(next.get(e.source) ?? []), e.target]);
  }
  const rank = ranks(view.nodes.map((n) => n.id), next, partIds);
  const index = new Map(view.nodes.map((n, i) => [n.id, i]));
  const order = [...parts].sort((a, b) => (rank.get(a.id)! - rank.get(b.id)!) || (index.get(a.id)! - index.get(b.id)!));
  const number = new Map(order.map((p, i) => [p.id, i + 1]));
  const numbered = (opts.number ?? true) && order.length > 1;

  let groups = view.groups ?? [];
  let nodes = view.nodes.map((n) => (numbered && number.has(n.id) ? { ...n, label: `${number.get(n.id)}. ${n.label}` } : n));

  const hasLanes = groups.some((g) => g.kind === "lane");
  if (opts.middle && !hasLanes) {
    // where each data box sits: only read -> in; only written, or read and written by the
    // same parts -> out; written by one part and read by another -> between them
    const writers = new Map<string, Set<string>>();
    const readers = new Map<string, Set<string>>();
    const note = (map: Map<string, Set<string>>, k: string, v: string) => map.set(k, (map.get(k) ?? new Set()).add(v));
    for (const e of view.edges) {
      if (!MOVES.has(e.style)) continue;
      if (partIds.has(e.source) && !partIds.has(e.target)) {
        note(writers, e.target, e.source);
        if (e.both) note(readers, e.target, e.source);
      } else if (!partIds.has(e.source) && partIds.has(e.target)) {
        note(readers, e.source, e.target);
        if (e.both) note(writers, e.source, e.target);
      }
    }
    const laneOf = (n: VNode): string => {
      if (partIds.has(n.id)) return LANE_MID;
      const w = writers.get(n.id) ?? new Set();
      const r = readers.get(n.id) ?? new Set();
      if (!w.size && !r.size) return n.faded ? LANE_OUT : LANE_MID;
      if (!w.size) return LANE_IN;
      if (!r.size || [...r].every((x) => w.has(x))) return LANE_OUT;
      return LANE_MID;
    };
    const all = new Map(groups.map((g) => [g.id, g]));
    const cloned = new Map<string, VGroup>();
    const midRoots = new Set<string>();
    /** The group a box sits in within its lane: data systems are copied per side. */
    const place = (gid: string | undefined, lane: string): string => {
      if (!gid || !all.has(gid)) return lane;
      if (lane === LANE_MID) {
        let root = gid;
        for (let g = all.get(gid), guard = 0; g?.parent && all.has(g.parent) && guard < 40; g = all.get(g.parent), guard++) root = g.parent;
        midRoots.add(root);
        return gid;
      }
      const id = `${lane}|${gid}`;
      if (!cloned.has(id)) {
        const g = all.get(gid)!;
        cloned.set(id, { ...g, id, parent: undefined });
        cloned.get(id)!.parent = place(g.parent, lane);
      }
      return id;
    };
    nodes = nodes.map((n) => ({ ...n, group: place(n.group, laneOf(n)) }));
    groups = [
      { id: LANE_IN, label: "Data in", sub: "where information comes from", kind: "lane" },
      { id: LANE_MID, label: opts.middle, sub: opts.middleSub ?? "in the order data moves through them", kind: "lane" },
      { id: LANE_OUT, label: "Data out", sub: "where information goes", kind: "lane" },
      ...groups.filter((g) => !cloned.has(g.id)).map((g) => (midRoots.has(g.id) ? { ...g, parent: LANE_MID } : g)),
      ...cloned.values(),
    ];
  }
  // a data system with many look-alike members starts folded into one box
  const members = new Map<string, number>();
  for (const n of nodes) if (n.group && DATA_SHAPES.has(n.shape)) members.set(n.group, (members.get(n.group) ?? 0) + 1);
  groups = groups.map((g) => (g.kind !== "lane" && (members.get(g.id) ?? 0) > 4 && !g.fold ? { ...g, fold: true } : g));

  const outline = outlineOf({ ...view, nodes, groups }, order.map((p) => p.id), number, opts);
  return { ...view, nodes, groups, outline };
}

/**
 * Longest-path rank of every box from where data starts; lines closing a cycle are ignored.
 * A part nothing feeds (a scheduled job, a timer) ranks with the parts its sources feed,
 * not ahead of them.
 */
function ranks(ids: string[], next: Map<string, string[]>, parts: Set<string>): Map<string, number> {
  const state = new Map<string, number>(); // 1 visiting, 2 done
  const back = new Set<string>();
  const visit = (id: string) => {
    state.set(id, 1);
    for (const t of next.get(id) ?? []) {
      if (state.get(t) === 1) back.add(`${id}>${t}`);
      else if (!state.has(t)) visit(t);
    }
    state.set(id, 2);
  };
  const indeg = new Map(ids.map((id) => [id, 0]));
  for (const ts of next.values()) for (const t of ts) indeg.set(t, (indeg.get(t) ?? 0) + 1);
  for (const id of [...ids].sort((a, b) => indeg.get(a)! - indeg.get(b)!)) if (!state.has(id)) visit(id);
  const rank = new Map(ids.map((id) => [id, parts.has(id) && !indeg.get(id) ? 1 : 0]));
  // relax in a topological order of the acyclic part
  const order: string[] = [];
  const seen = new Set<string>();
  const topo = (id: string) => {
    seen.add(id);
    for (const t of next.get(id) ?? []) if (!back.has(`${id}>${t}`) && !seen.has(t)) topo(t);
    order.push(id);
  };
  for (const id of ids) if (!seen.has(id)) topo(id);
  for (const id of order.reverse()) {
    for (const t of next.get(id) ?? []) {
      if (!back.has(`${id}>${t}`)) rank.set(t, Math.max(rank.get(t) ?? 0, (rank.get(id) ?? 0) + 1));
    }
  }
  return rank;
}

/** The diagram as an outline: its parts in data order, each with what goes in and out. */
function outlineOf(view: ViewModel, order: string[], number: Map<string, number>, opts: ReadingOptions): Outline {
  const byId = new Map(view.nodes.map((n) => [n.id, n]));
  const strip = (label: string) => label.replace(/^\d+\.\s/, "");
  const end = (id: string): Omit<PartLink, "data"> => {
    const v = byId.get(id);
    if (!v) return { label: id };
    if (number.has(id)) return { label: `${number.get(id)}. ${strip(v.label)}`, ref: v.ref, part: number.get(id) };
    return { label: `${v.label}${v.sub ? ` (${v.sub})` : ""}`, ref: v.ref };
  };
  const link = (e: VEdge, other: string): PartLink => ({
    ...end(other),
    data: e.label ?? "",
    via: e.sublabel,
    control: (!e.types?.length && (e.style === "call" || e.style === "depends" || e.style === "deploy")) || undefined,
  });
  const compress = (links: { link: PartLink; other: string }[]) => compressLinks(links, view, (id) => number.has(id));
  return {
    title: opts.title,
    stepsLabel: opts.stepsLabel,
    controlTerms: ["used by", "uses"],
    parts: order.map((id) => {
      const v = byId.get(id)!;
      const rows = v.sections?.flat() ?? [];
      const doc = rows.find((r) => r.muted && r.text.startsWith("“"))?.text.replace(/^“|”$/g, "");
      // an unnamed box (a run of statements in an activity) is called by its first line
      const body = rows.filter((r) => !(r.muted && r.text.startsWith("“")));
      const title = strip(v.label) || body[0]?.text.trim() || v.sub || id;
      return {
        id, ref: v.ref ?? id, n: number.get(id)!, title, kind: [v.stereotype, v.sub].filter(Boolean).join(" · "), doc,
        inputs: compress(view.edges.filter((e) => e.target === id && e.source !== id).map((e) => ({ link: link(e, e.source), other: e.source }))),
        outputs: compress(view.edges.filter((e) => e.source === id && e.target !== id).map((e) => ({ link: link(e, e.target), other: e.target }))),
        steps: strip(v.label) ? body : body.slice(1),
      };
    }),
  };
}

/**
 * Three or more links carrying the same data the same way into one system read as one line:
 * "byte[] → Kafka (8): live-prices, prices, fills +5".
 */
export function compressLinks(links: { link: PartLink; other: string }[], view: ViewModel, isPart: (id: string) => boolean): PartLink[] {
  const byId = new Map(view.nodes.map((n) => [n.id, n]));
  const groups = new Map((view.groups ?? []).map((g) => [g.id, g]));
  const strip = (label: string) => label.replace(/^\d+\.\s/, "");
  const buckets = new Map<string, { link: PartLink; other: string }[]>();
  for (const l of links) {
    const g = isPart(l.other) ? undefined : byId.get(l.other)?.group;
    const key = g ? `${l.link.data}|${l.link.via ?? ""}|${g}` : `single|${buckets.size}`;
    buckets.set(key, [...(buckets.get(key) ?? []), l]);
  }
  return [...buckets.values()].flatMap((bucket) => {
    if (bucket.length < 3) return bucket.map((b) => b.link);
    const g = groups.get(byId.get(bucket[0].other)?.group ?? "");
    const shown = bucket.slice(0, 3).map((b) => strip(byId.get(b.other)?.label ?? b.other));
    return [{ ...bucket[0].link, ref: undefined, label: `${g?.label ?? "several"} (${bucket.length}): ${shown.join(", ")}${bucket.length > 3 ? ` +${bucket.length - 3}` : ""}` }];
  });
}
