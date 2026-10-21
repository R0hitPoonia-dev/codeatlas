// Collapsible grouping for any diagram. A view declares groups (with parents) and assigns
// nodes to their innermost group; this module decides which groups are worth showing,
// collapses groups into single boxes (aggregating their edges), and picks a default
// expansion that keeps the diagram readable.
import type { GroupOverrides, RepoConfig } from "../api";
import type { Model } from "./model";
import type { VEdge, VGroup, VNode, ViewModel } from "./views";

/** A view ready to lay out: visible nodes (some may be collapsed groups) inside open containers. */
export interface GroupedView extends ViewModel {
  /** Expanded groups drawn as boxes; `parent` is the enclosing expanded group. */
  containers: (VGroup & { size: number })[];
  /** Collapsed group node id -> group id. */
  collapsedNodes: Map<string, string>;
}

export const GROUP_NODE = "group:";

/** Groups that help: at least two members (one for code regions) and not the whole diagram. */
export function usefulGroups(view: ViewModel): Map<string, VGroup> {
  const all = new Map((view.groups ?? []).map((g) => [g.id, g]));
  const groups = new Map(all);
  // members: direct nodes + direct child groups
  for (let changed = true; changed; ) {
    changed = false;
    const members = new Map<string, number>();
    for (const n of view.nodes) {
      const g = nearest(n.group, groups, all);
      if (g) members.set(g, (members.get(g) ?? 0) + 1);
    }
    for (const g of groups.values()) {
      const p = nearest(g.parent, groups, all);
      if (p) members.set(p, (members.get(p) ?? 0) + 1);
    }
    for (const id of [...groups.keys()]) {
      // code regions (loop / try bodies) and lanes matter even around one member; other groups need two
      const g = groups.get(id)!;
      // code regions, lanes and groups a user made by moving a node show even with one member
      const min = g.keep || ["region", "lane", "custom"].includes(g.kind) ? 1 : 2;
      if ((members.get(id) ?? 0) < min) {
        groups.delete(id);
        changed = true;
      }
    }
    // a single group wrapping everything adds nothing
    const roots = new Set<string>();
    for (const n of view.nodes) roots.add(rootOf(n.group, groups, all) ?? `node:${n.id}`);
    if (roots.size === 1) {
      const only = [...roots][0];
      if (groups.has(only)) {
        groups.delete(only);
        changed = true;
      }
    }
  }
  return groups;
}

/** Nearest ancestor-or-self of `id` that is still a kept group. */
export function nearest(id: string | undefined, kept: Map<string, VGroup>, all: Map<string, VGroup>): string | undefined {
  for (let g = id, guard = 0; g && guard < 50; g = all.get(g)?.parent, guard++) if (kept.has(g)) return g;
  return undefined;
}

function rootOf(id: string | undefined, kept: Map<string, VGroup>, all: Map<string, VGroup>): string | undefined {
  let root: string | undefined;
  for (let g = id, guard = 0; g && guard < 50; g = all.get(g)?.parent, guard++) if (kept.has(g)) root = g;
  return root;
}

/** Chain of kept groups from outermost to innermost for a node's group. */
function chain(id: string | undefined, kept: Map<string, VGroup>, all: Map<string, VGroup>): string[] {
  const out: string[] = [];
  for (let g = id, guard = 0; g && guard < 50; g = all.get(g)?.parent, guard++) if (kept.has(g)) out.unshift(g);
  return out;
}

export function applyGroups(view: ViewModel, collapsed: Set<string>): GroupedView {
  const all = new Map((view.groups ?? []).map((g) => [g.id, g]));
  const kept = usefulGroups(view);
  const rep = new Map<string, string>(); // node id -> visible id
  const parentOf = new Map<string, string | undefined>(); // visible id -> container
  const collapsedNodes = new Map<string, string>();
  const size = new Map<string, number>(); // group -> node count
  const nodes: VNode[] = [];
  const groupNodes = new Map<string, VNode>();

  for (const n of view.nodes) {
    const c = chain(n.group, kept, all);
    for (const g of c) size.set(g, (size.get(g) ?? 0) + 1);
    const cut = c.findIndex((g) => collapsed.has(g));
    if (cut < 0) {
      rep.set(n.id, n.id);
      parentOf.set(n.id, c[c.length - 1]);
      nodes.push({ ...n, group: c[c.length - 1] });
      continue;
    }
    const g = c[cut];
    const id = GROUP_NODE + g;
    rep.set(n.id, id);
    if (!groupNodes.has(id)) {
      const group = all.get(g)!;
      const node: VNode = { id, label: group.label, shape: n.shape === "store" || n.shape === "table" ? n.shape : "package", group: c[cut - 1] };
      groupNodes.set(id, node);
      collapsedNodes.set(id, g);
      parentOf.set(id, c[cut - 1]);
      nodes.push(node);
    }
  }
  for (const [id, node] of groupNodes) {
    const g = all.get(collapsedNodes.get(id)!)!;
    const count = size.get(g.id) ?? 0;
    node.sub = `${g.sub ? g.sub + " · " : ""}×${count} — click to expand`;
    node.collapsed = true;
  }

  // containers: expanded kept groups that still hold something visible
  const used = new Set<string>();
  for (const n of nodes) for (let g = parentOf.get(n.id); g; g = nearest(all.get(g)?.parent, kept, all)) used.add(g);
  const containers = [...kept.values()]
    .filter((g) => used.has(g.id) && !collapsed.has(g.id))
    .map((g) => ({ ...g, parent: nearest(g.parent, kept, all), size: size.get(g.id) ?? 0 }));
  // parents before children (React Flow requirement)
  const depth = (g: { parent?: string }): number => (g.parent ? 1 + depth(containers.find((c) => c.id === g.parent) ?? {}) : 0);
  containers.sort((a, b) => depth(a) - depth(b));

  return { ...view, nodes, edges: aggregate(view.edges, rep), containers, collapsedNodes };
}

/** Re-points edges at visible nodes, dropping edges hidden inside a collapsed group and merging duplicates. */
function aggregate(edges: VEdge[], rep: Map<string, string>): VEdge[] {
  const out = new Map<string, VEdge & { labels: Set<string> }>();
  for (const e of edges) {
    const s = rep.get(e.source);
    const t = rep.get(e.target);
    if (!s || !t || s === t) continue;
    if (s === e.source && t === e.target) {
      out.set(e.id, { ...e, labels: new Set(e.label ? [e.label] : []) });
      continue;
    }
    const key = `${s}|${t}|${e.style}`;
    const prev = out.get(key);
    if (!prev) {
      out.set(key, { ...e, id: key, source: s, target: t, labels: new Set(e.label ? [e.label] : []) });
      continue;
    }
    prev.count += e.count;
    if (e.label) prev.labels.add(e.label);
    prev.conditional = prev.conditional && e.conditional;
    prev.sensitivity = maxSeverity(prev.sensitivity, e.sensitivity);
    if (e.sublabel && e.sublabel !== prev.sublabel) prev.sublabel = prev.sublabel ? `${prev.sublabel.split(" +")[0]} +` : e.sublabel;
    prev.info = undefined; // merged flows: open the group to see each one
  }
  return [...out.values()].map(({ labels, ...e }) => {
    const ls = [...labels];
    return { ...e, label: ls.length <= 1 ? ls[0] : `${ls[0]} +${ls.length - 1}` };
  });
}

const SEV = { low: 1, medium: 2, high: 3 } as const;
function maxSeverity(a?: "high" | "medium" | "low", b?: "high" | "medium" | "low") {
  if (!a) return b;
  if (!b) return a;
  return SEV[a] >= SEV[b] ? a : b;
}

/**
 * Default collapse state: start fully collapsed, then expand groups outside-in (largest
 * first) while the number of visible boxes stays within `budget`.
 */
export function defaultCollapsed(view: ViewModel, budget = 36): Set<string> {
  const kept = usefulGroups(view);
  const folded = new Set([...kept.values()].filter((g) => g.fold).map((g) => g.id));
  if (!kept.size || view.nodes.length <= budget) return folded;
  const collapsed = new Set(kept.keys());
  const visible = () => applyGroups(view, collapsed).nodes.length;
  for (let progress = true; progress; ) {
    progress = false;
    // candidates: collapsed groups whose ancestors are all expanded (currently shown as a box)
    const shown = applyGroups(view, collapsed).collapsedNodes;
    const candidates = [...shown.values()].filter((g) => !folded.has(g)).sort((a, b) => sizeOf(view, b, kept) - sizeOf(view, a, kept));
    for (const g of candidates) {
      collapsed.delete(g);
      if (visible() <= budget) progress = true;
      else collapsed.add(g);
    }
  }
  return collapsed;
}

function sizeOf(view: ViewModel, g: string, kept: Map<string, VGroup>): number {
  const all = new Map((view.groups ?? []).map((x) => [x.id, x]));
  return view.nodes.filter((n) => chain(n.group, kept, all).includes(g)).length;
}

/** Ids of nodes (original ids) inside group g, for "focus group". */
export function membersOf(view: ViewModel, g: string): Set<string> {
  const all = new Map((view.groups ?? []).map((x) => [x.id, x]));
  const out = new Set<string>();
  for (const n of view.nodes) {
    for (let x = n.group, guard = 0; x && guard < 50; x = all.get(x)?.parent, guard++) {
      if (x === g) {
        out.add(n.id);
        break;
      }
    }
  }
  return out;
}

// ------------------------------------------------------------- user and repo edits

/**
 * Applies grouping edits to a view: renamed groups get their new label, and groups that end
 * up with the same label under the same parent merge. A node assigned to a group name joins
 * the group with that label if the view has one, else a new top-level group of that name.
 * Assignments only move nodes that stand for one graph node (not activity steps).
 */
export function applyOverrides(view: ViewModel, o?: GroupOverrides): ViewModel {
  const rename = o?.rename ?? {};
  const assign = o?.assign ?? {};
  if (!Object.keys(rename).length && !Object.keys(assign).length) return view;

  const groups: VGroup[] = (view.groups ?? []).map((g) => ({ ...g, label: rename[g.id] || g.label }));
  const byLabel = new Map<string, string>();
  for (const g of groups) if (!byLabel.has(g.label)) byLabel.set(g.label, g.id);
  const custom = new Map<string, VGroup>();
  let nodes = view.nodes.map((n) => {
    const key = n.ref && (n.id === n.ref || n.id === `dfd:p:${n.ref}`) ? n.ref : n.id;
    const name = assign[key];
    if (!name) return n;
    let id = byLabel.get(name);
    if (!id) {
      id = `custom:${name}`;
      if (!custom.has(id)) custom.set(id, { id, label: rename[id] || name, kind: "custom" });
    }
    return { ...n, group: id };
  });

  // merge groups that share a label within the same parent
  const all = [...groups, ...custom.values()];
  const alias = new Map<string, string>();
  const first = new Map<string, string>();
  for (const g of all) {
    const k = `${g.parent ?? ""}\u0000${g.label}`;
    const f = first.get(k);
    if (f) alias.set(g.id, f);
    else first.set(k, g.id);
  }
  const resolve = (id?: string) => (id ? alias.get(id) ?? id : id);
  nodes = nodes.map((n) => (alias.has(n.group ?? "") ? { ...n, group: resolve(n.group) } : n));
  const merged = all.filter((g) => !alias.has(g.id)).map((g) => ({ ...g, parent: resolve(g.parent) }));
  return { ...view, nodes, groups: merged };
}

/** Edits declared in the repo's .codeatlas.yml: globs resolved to node ids (with their members). */
export function configOverrides(config: RepoConfig | undefined, m: Model): GroupOverrides {
  const out: GroupOverrides = { rename: { ...(config?.rename ?? {}) }, assign: {} };
  for (const g of config?.groups ?? []) {
    const patterns = (g.members ?? []).map(glob);
    for (const n of m.graph.nodes) {
      if (out.assign[n.id]) continue;
      const names = [n.id, n.qualifiedName, n.name].filter(Boolean) as string[];
      if (!patterns.some((re) => names.some((x) => re.test(x)))) continue;
      out.assign[n.id] = g.name;
      for (const d of m.descendants(n.id)) out.assign[d.id] ??= g.name; // a class brings its methods
    }
  }
  return out;
}

/** b's edits win over a's. */
export function mergeOverrides(a: GroupOverrides, b?: GroupOverrides): GroupOverrides {
  return { rename: { ...a.rename, ...(b?.rename ?? {}) }, assign: { ...a.assign, ...(b?.assign ?? {}) } };
}

/** "com.acme.*" -> /^com\.acme\..*$/ ; "**" and "*" both match any run of characters. */
function glob(pattern: string): RegExp {
  const re = pattern.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${re.replace(/(\.\*)+/g, ".*")}$`);
}

// ------------------------------------------------------------- detail levels

/** One step of detail in a nested diagram: boxes at `depth` and below are folded. */
export interface Level {
  /** 1 = only the outermost boxes; the last level shows everything. */
  level: number;
  /** Default name, from what the boxes folded at this level are; also the rename key. */
  key: string;
  name: string;
  /** Boxes you see folded at this level (0 on the last level). */
  boxes: number;
}

const KIND_NAME: Record<VGroup["kind"], string> = {
  service: "Services", system: "Data systems", package: "Packages", class: "Classes", function: "Functions",
  region: "Blocks", scope: "Outside state", database: "Databases", role: "Roles", lane: "Lanes", custom: "Groups",
  deployment: "Deployments",
};

/** Depth of each shown group: 1 for outermost, nested groups one deeper than their parent. */
export function groupDepths(view: ViewModel): Map<string, number> {
  const all = new Map((view.groups ?? []).map((g) => [g.id, g]));
  const kept = usefulGroups(view);
  const depth = new Map<string, number>();
  for (const id of kept.keys()) depth.set(id, chain(id, kept, all).length);
  return depth;
}

/**
 * The detail levels of a nested diagram, as many as its boxes are deep: level n shows the
 * boxes n deep folded (named after what most of them are: Services, Packages, Classes,
 * Functions, Blocks...), the last level shows everything open.
 */
export function detailLevels(view: ViewModel, names: Record<string, string> = {}): Level[] {
  const all = new Map((view.groups ?? []).map((g) => [g.id, g]));
  const depths = groupDepths(view);
  const max = Math.max(0, ...depths.values());
  // how much each box holds: a level is named after the boxes holding most of the diagram
  const kept = usefulGroups(view);
  const size = new Map<string, number>();
  for (const n of view.nodes) for (const g of chain(n.group, kept, all)) size.set(g, (size.get(g) ?? 0) + 1);
  const levels: Level[] = [];
  const used = new Map<string, number>();
  for (let d = 1; d <= max; d++) {
    const at = [...depths].filter(([, x]) => x === d).map(([id]) => ({ kind: all.get(id)!.kind, size: size.get(id) ?? 0 }));
    const weight = new Map<string, number>();
    for (const g of at) weight.set(g.kind, (weight.get(g.kind) ?? 0) + g.size);
    const total = at.reduce((t, g) => t + g.size, 0);
    const [first, second] = [...weight].sort((a, b) => b[1] - a[1]);
    let base = KIND_NAME[first[0] as VGroup["kind"]];
    // a level of mixed boxes (classes in Java, functions straight in a TS folder) says both
    if (second && second[1] >= total / 4) base += ` & ${KIND_NAME[second[0] as VGroup["kind"]].toLowerCase()}`;
    // the same kind again, deeper (blocks inside blocks, packages inside packages)
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    const key = n === 1 ? base : `Inner ${base.toLowerCase()}${n > 2 ? ` ${n - 1}` : ""}`;
    levels.push({ level: d, key, name: names[key] ?? key, boxes: at.length });
  }
  levels.push({ level: max + 1, key: "Everything", name: names.Everything ?? "Everything", boxes: 0 });
  return levels;
}

/** Groups to fold to show a diagram at `level`: every box `level` deep or deeper. */
export function collapsedAtLevel(view: ViewModel, level: number): Set<string> {
  return new Set([...groupDepths(view)].filter(([, d]) => d >= level).map(([id]) => id));
}
