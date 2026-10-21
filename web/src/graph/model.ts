// Indexed access to a merged repo graph.
import type { Graph, GraphEdge, GraphNode } from "../api";

const CALLABLE = new Set(["method", "function"]);
const TYPES = new Set(["class", "interface", "enum"]);
/** Kinds a diagram treats as the box an edge lands on. Endpoints belong to their service. */
const ARCH = new Set(["service", "module", "database", "topic", "queue", "external"]);
const EMPTY = new Set<string>();
const REACH_LIMIT = 8000;

export class Model {
  readonly byId = new Map<string, GraphNode>();
  readonly children = new Map<string, GraphNode[]>();
  readonly out = new Map<string, GraphEdge[]>();
  readonly in = new Map<string, GraphEdge[]>();

  private reachCache: Map<string, Set<string>> | undefined;
  private scopeCache = new Map<string, Set<string>>();
  private splitCache: Set<string> | undefined;

  constructor(readonly graph: Graph) {
    for (const n of graph.nodes) this.byId.set(n.id, n);
    for (const n of graph.nodes) {
      if (n.parent) push(this.children, n.parent, n);
    }
    for (const e of graph.edges) {
      push(this.out, e.source, e);
      push(this.in, e.target, e);
    }
  }

  node(id: string) {
    return this.byId.get(id);
  }

  ofKind(...kinds: string[]) {
    const want = new Set(kinds);
    return this.graph.nodes.filter((n) => want.has(n.kind));
  }

  /** First ancestor (or self) whose kind is in `kinds`. */
  owner(id: string, kinds: Set<string>): GraphNode | undefined {
    for (let n = this.byId.get(id), guard = 0; n && guard < 64; n = n.parent ? this.byId.get(n.parent) : undefined, guard++) {
      if (kinds.has(n.kind)) return n;
    }
    return undefined;
  }

  /** All descendants of id (depth-first). */
  descendants(id: string): GraphNode[] {
    const out: GraphNode[] = [];
    const stack = [...(this.children.get(id) ?? [])];
    while (stack.length) {
      const n = stack.pop()!;
      out.push(n);
      stack.push(...(this.children.get(n.id) ?? []));
    }
    return out;
  }

  services() {
    return this.ofKind("service", "module").sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Modules whose code is shared by several programs. Each program is its own service
   * (`attrs.module` points here) with a `runs` edge to the main it starts.
   */
  splitModules(): Set<string> {
    if (this.splitCache) return this.splitCache;
    const out = new Set<string>();
    for (const n of this.graph.nodes) {
      const mod = n.attrs?.module;
      if (n.kind === "service" && typeof mod === "string") out.add(mod);
    }
    this.splitCache = out;
    return out;
  }

  /**
   * Methods and endpoints a split-out service runs: everything reachable from the main it
   * `runs`, including work it starts on other threads and the servers it opens. A Spring Boot
   * main also runs every endpoint, consumer and scheduled job of its module. Empty for a
   * service that contains its own code.
   */
  reachedBy(serviceId: string): Set<string> {
    return this.ensureReach().get(serviceId) ?? EMPTY;
  }

  /**
   * Nodes that count as inside a service. A service that contains its code: itself and its
   * descendants. A program split out of a module: what that program reaches, plus the classes
   * and packages around it.
   */
  codeScope(serviceId: string): Set<string> {
    const cached = this.scopeCache.get(serviceId);
    if (cached) return cached;
    const desc = this.descendants(serviceId);
    let scope: Set<string>;
    const reached = desc.length ? EMPTY : this.reachedBy(serviceId);
    if (desc.length || !reached.size) {
      scope = new Set([serviceId, ...desc.map((d) => d.id)]);
    } else {
      scope = new Set(reached);
      for (const id of reached) {
        for (let n = this.byId.get(id), g = 0; n && g < 32; n = n.parent ? this.byId.get(n.parent) : undefined, g++) {
          scope.add(n.id);
        }
      }
    }
    this.scopeCache.set(serviceId, scope);
    return scope;
  }

  /**
   * Who an edge's endpoint counts as. Code in a split module counts for every program whose
   * main reaches it (shared code counts for each of them); everything else counts for the
   * service or module that contains it.
   */
  appsOf(id: string): GraphNode[] {
    const self = this.owner(id, ARCH);
    if (!self) return [];
    if (self.kind !== "module" || !this.splitModules().has(self.id)) return [self];
    const reach = this.ensureReach();
    const apps: GraphNode[] = [];
    for (const [svc, ids] of reach) {
      const n = this.byId.get(svc);
      if (n?.attrs?.module === self.id && ids.has(id)) apps.push(n);
    }
    // not reached itself (a callback the framework calls, an overload, a stop() nobody wires
    // up): it runs in whichever programs use its class, innermost class first
    for (let t = this.owner(id, TYPES), g = 0; !apps.length && t && g < 16; t = t.parent ? this.owner(t.parent, TYPES) : undefined, g++) {
      for (const [svc, types] of this.ensureTypes()) {
        const n = this.byId.get(svc);
        if (n?.attrs?.module === self.id && types.has(t.id)) apps.push(n);
      }
    }
    return apps.length ? apps : [self];
  }

  private typesCache: Map<string, Set<string>> | undefined;

  /** Per split-out program, the classes (and their enclosing classes) holding something it reaches. */
  private ensureTypes(): Map<string, Set<string>> {
    if (this.typesCache) return this.typesCache;
    this.typesCache = new Map();
    for (const [svc, ids] of this.ensureReach()) {
      const types = new Set<string>();
      for (const id of ids) {
        for (let t = this.owner(id, TYPES), g = 0; t && !types.has(t.id) && g < 16; t = t.parent ? this.owner(t.parent, TYPES) : undefined, g++) {
          types.add(t.id);
        }
      }
      this.typesCache.set(svc, types);
    }
    return this.typesCache;
  }

  /** Like {@link appsOf}, but a class or package counts when a program reaches something inside it. */
  appsTouching(id: string): GraphNode[] {
    const exact = this.appsOf(id);
    if (exact.some((a) => a.kind === "service")) return exact;
    const self = this.owner(id, new Set(["service", "module"]));
    if (!self || !this.splitModules().has(self.id)) return exact;
    const apps: GraphNode[] = [];
    for (const [svc, ids] of this.ensureReach()) {
      const n = this.byId.get(svc);
      if (n?.attrs?.module !== self.id) continue;
      for (const reached of ids) {
        if (reached === id || this.isUnder(reached, id)) {
          apps.push(n);
          break;
        }
      }
    }
    return apps.length ? apps : exact;
  }

  private isUnder(id: string, ancestor: string): boolean {
    for (let n = this.byId.get(id), g = 0; n && g < 32; n = n.parent ? this.byId.get(n.parent) : undefined, g++) {
      if (n.id === ancestor) return true;
    }
    return false;
  }

  private ensureReach(): Map<string, Set<string>> {
    if (this.reachCache) return this.reachCache;
    const cache = new Map<string, Set<string>>();
    this.reachCache = cache;
    for (const e of this.graph.edges) {
      if (e.kind !== "runs") continue;
      const svc = this.byId.get(e.source);
      const moduleId = svc?.attrs?.module;
      if (svc?.kind !== "service" || typeof moduleId !== "string") continue;
      const seeds = [e.target];
      if (this.frameworkLaunch(svc, e.target)) {
        for (const d of this.descendants(moduleId)) {
          if (d.kind === "endpoint") seeds.push(d.id);
          else if (d.attrs?.entryPoint && d.attrs.entryPoint !== "main") seeds.push(d.id);
          else if (CALLABLE.has(d.kind) && (this.in.get(d.id) ?? []).some((x) => x.kind === "consumes")) seeds.push(d.id);
        }
      }
      const reached = this.walkCalls(seeds);
      for (const n of this.ofKind("endpoint")) {
        const openers = (n.attrs?.openedBy as string[] | undefined) ?? [];
        if (!openers.some((o) => reached.has(o))) continue;
        reached.add(n.id);
        const handler = (this.out.get(n.id) ?? []).find((h) => h.kind === "handles")?.target;
        if (handler) this.walkCalls([handler], reached);
      }
      cache.set(svc.id, reached);
    }
    return cache;
  }

  /** Spring Boot's main returns into the framework, which runs the module's other entry points. */
  private frameworkLaunch(svc: GraphNode, targetId: string): boolean {
    if (svc.attrs?.launch === "spring-boot") return true;
    const n = this.byId.get(targetId);
    const cls = n?.kind === "class" || n?.kind === "interface" ? n : n?.parent ? this.byId.get(n.parent) : undefined;
    const anns = (cls?.attrs?.annotations as string[] | undefined) ?? [];
    return anns.includes("SpringBootApplication") || cls?.attrs?.stereotype === "SpringBootApplication";
  }

  /**
   * Calls, including ones that start work on another thread, and handlers an endpoint
   * dispatches to. Two steps a static call graph misses are taken too: a call to an abstract
   * method reaches its in-repo implementations, and creating an object reaches its thread
   * body (run / call), since whatever starts it (a pool, a list of workers) runs it in the
   * same program.
   */
  private walkCalls(seeds: string[], into = new Set<string>()): Set<string> {
    const queue: string[] = [];
    const visit = (id: string) => {
      if (into.has(id) || !CALLABLE.has(this.byId.get(id)?.kind ?? "")) return;
      into.add(id);
      queue.push(id);
    };
    for (const id of seeds) {
      if (!into.has(id)) {
        into.add(id);
        queue.push(id);
      }
    }
    while (queue.length && into.size < REACH_LIMIT) {
      const id = queue.shift()!;
      const n = this.byId.get(id);
      for (const e of this.out.get(id) ?? []) {
        if (e.kind === "calls" || e.kind === "handles") visit(e.target);
      }
      if (n?.attrs?.abstract) for (const impl of this.implementations(n)) visit(impl);
      if (n?.name === "<init>" && n.parent) {
        for (const c of this.children.get(n.parent) ?? []) if (c.attrs?.entryPoint === "thread") visit(c.id);
      }
    }
    return into;
  }

  private subtypeCache: Map<string, string[]> | undefined;

  /** In-repo methods overriding abstract method n: same name and parameters in a subtype. */
  implementations(n: GraphNode): string[] {
    if (!this.subtypeCache) {
      this.subtypeCache = new Map();
      for (const e of this.graph.edges) {
        if (e.kind === "implements" || e.kind === "extends") push(this.subtypeCache, e.target, e.source);
      }
    }
    const hash = n.id.indexOf("#");
    if (!n.parent || hash < 0) return [];
    const signature = n.id.slice(hash);
    const out: string[] = [];
    const seen = new Set([n.parent]);
    const stack = [...(this.subtypeCache.get(n.parent) ?? [])];
    while (stack.length) {
      const t = stack.pop()!;
      if (seen.has(t)) continue;
      seen.add(t);
      const impl = `method:${t.replace(/^class:/, "")}${signature}`;
      if (this.byId.has(impl)) out.push(impl);
      stack.push(...(this.subtypeCache.get(t) ?? []));
    }
    return out;
  }
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
}

export function locationText(n: { location?: { file: string; startLine?: number } }) {
  if (!n.location) return "";
  return n.location.startLine ? `${n.location.file}:${n.location.startLine}` : n.location.file;
}
