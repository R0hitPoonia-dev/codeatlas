// CodeAtlas IR v1 (see ir/schema/ir.v1.schema.json) and a de-duplicating builder.

export interface Location {
  file: string;
  startLine?: number;
  endLine?: number;
}

export interface IrNode {
  id: string;
  kind: string;
  name: string;
  qualifiedName?: string;
  parent?: string;
  language?: string;
  location?: Location;
  otel?: Record<string, string>;
  attrs?: Record<string, unknown>;
}

export interface IrEdge {
  source: string;
  target: string;
  kind: string;
  locations?: Location[];
  attrs?: Record<string, unknown>;
}

export interface Source {
  repo: string;
  commit: string;
  branch?: string;
  analyzer: { name: string; version: string };
  generatedAt?: string;
}

export interface Document {
  irVersion: "1";
  source: Source;
  nodes: IrNode[];
  edges: IrEdge[];
}

const MAX_LOCATIONS = 20;

export class Builder {
  private nodes = new Map<string, IrNode>();
  private edges = new Map<string, IrEdge>();

  node(id: string, kind: string, name: string): IrNode {
    let n = this.nodes.get(id);
    if (!n) {
      n = { id, kind, name };
      this.nodes.set(id, n);
    }
    return n;
  }

  get(id: string): IrNode | undefined {
    return this.nodes.get(id);
  }

  has(id: string): boolean {
    return this.nodes.has(id);
  }

  /**
   * Adds or merges an edge. With `guards`, also records the conditions this occurrence runs
   * under: attrs.conditions lists distinct guard chains, attrs.unconditional is set when
   * any occurrence always runs.
   */
  edge(source: string, target: string, kind: string, at?: Location, guards?: string[]): IrEdge {
    const e = this.plainEdge(source, target, kind, at);
    if (guards) {
      if (!guards.length) setAttr(e, "unconditional", true);
      else {
        const conditions = ((e.attrs ??= {}).conditions as string[] | undefined) ?? [];
        const chain = guards.join(" › ");
        if (conditions.length < 10 && !conditions.includes(chain)) conditions.push(chain);
        e.attrs.conditions = conditions;
      }
    }
    return e;
  }

  private plainEdge(source: string, target: string, kind: string, at?: Location): IrEdge {
    const key = `${source}\0${target}\0${kind}`;
    let e = this.edges.get(key);
    if (!e) {
      e = { source, target, kind };
      this.edges.set(key, e);
    }
    if (at) {
      e.locations ??= [];
      if (e.locations.length < MAX_LOCATIONS && !e.locations.some((l) => l.file === at.file && l.startLine === at.startLine)) {
        e.locations.push(at);
      }
    }
    return e;
  }

  /** Points every edge targeting `from` at `to` instead (merging with existing edges). */
  retarget(from: string, to: string) {
    for (const [key, e] of [...this.edges]) {
      if (e.target !== from) continue;
      this.edges.delete(key);
      const merged = this.edge(e.source, to, e.kind);
      merged.attrs = { ...e.attrs, ...merged.attrs };
      for (const l of e.locations ?? []) this.edge(e.source, to, e.kind, l);
    }
  }

  /** Drops edges and parents that reference unknown nodes, so the document always validates. */
  build(source: Source): Document {
    const edges = [...this.edges.values()].filter(
      (e) => this.nodes.has(e.source) && this.nodes.has(e.target) && e.source !== e.target,
    );
    for (const n of this.nodes.values()) {
      if (n.parent && (!this.nodes.has(n.parent) || n.parent === n.id)) delete n.parent;
    }
    return { irVersion: "1", source, nodes: [...this.nodes.values()], edges };
  }
}

export function setAttr(n: { attrs?: Record<string, unknown> }, key: string, value: unknown) {
  (n.attrs ??= {})[key] = value;
}

export function addToList(n: { attrs?: Record<string, unknown> }, key: string, value: unknown) {
  const attrs = (n.attrs ??= {});
  const list = (attrs[key] as unknown[] | undefined) ?? [];
  if (!list.includes(value)) list.push(value);
  attrs[key] = list;
}

export function setOtel(n: IrNode, key: string, value: string) {
  (n.otel ??= {})[key] = value;
}
