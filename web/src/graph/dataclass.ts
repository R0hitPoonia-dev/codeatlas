// Classifies fields and columns by name into data categories (PII, payment, credentials...),
// and computes which categories a type carries, following nested in-repo types.
import type { GraphNode } from "../api";
import type { Model } from "./model";

export type DataClass =
  | "credential" | "payment" | "government-id" | "email" | "phone" | "person-name"
  | "address" | "birth-date" | "location" | "ip-address" | "financial";

export const CLASS_INFO: Record<DataClass, { label: string; severity: "high" | "medium" | "low" }> = {
  credential: { label: "credentials", severity: "high" },
  payment: { label: "payment card", severity: "high" },
  "government-id": { label: "government ID", severity: "high" },
  email: { label: "email", severity: "medium" },
  phone: { label: "phone", severity: "medium" },
  "person-name": { label: "person name", severity: "medium" },
  address: { label: "address", severity: "medium" },
  "birth-date": { label: "birth date", severity: "medium" },
  location: { label: "location", severity: "medium" },
  "ip-address": { label: "IP address", severity: "low" },
  financial: { label: "financial", severity: "low" },
};

// Order matters: the first match wins ("cardToken" is payment, not a credential).
const RULES: [RegExp, DataClass][] = [
  [/(cardnumber|cardno|creditcard|card(token|num|holder)?$|^pan$|cvv|cvc|iban|bic$|swift|accountnumber|routingnumber|sortcode)/, "payment"],
  [/(password|passwd|pwd$|secret|apikey|accesstoken|refreshtoken|idtoken|authtoken|^token$|privatekey|otp$|pincode|^pin$|sessionid|credential)/, "credential"],
  [/(ssn|socialsecurity|passport|nationalid|taxid|^tin$|aadhaar|driverslicen[cs]e|licensenumber)/, "government-id"],
  [/(e?mail(address)?$|^to$|^cc$|^bcc$)/, "email"],
  [/(phone|mobile|msisdn|^tel$|telephone|fax)/, "phone"],
  [/(firstname|lastname|fullname|surname|givenname|middlename|customername|holdername|^name$)/, "person-name"],
  [/(address|street|city|zip(code)?$|postcode|postalcode)/, "address"],
  [/(birth|^dob$)/, "birth-date"],
  [/(latitude|longitude|^lat$|^lng$|^lon$|geolocation|coordinates)/, "location"],
  [/(^ip$|ipaddress|clientip|remoteaddr)/, "ip-address"],
  [/(amount|total|price|balance|salary|income|payment|charge|refund)/, "financial"],
];

const PERSON_OWNER = /(customer|user|person|employee|contact|member|patient|client|owner|holder|account|profile|recipient)/i;

/**
 * Category of a field/column name. `owner` is the enclosing type or table: a bare `name` only
 * counts as a person's name on person-like owners (Customer.name, not Product.name).
 */
export function classifyName(name: string, owner?: string): DataClass | undefined {
  const n = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!n) return undefined;
  for (const [re, cls] of RULES) {
    if (!re.test(n)) continue;
    if (cls === "person-name" && n === "name" && !(owner && PERSON_OWNER.test(owner))) return undefined;
    return cls;
  }
  return undefined;
}

/** Category -> example field paths ("customer.email"). */
export type ClassHits = Map<DataClass, string[]>;

function add(hits: ClassHits, cls: DataClass, path: string) {
  const list = hits.get(cls) ?? [];
  if (!list.includes(path) && list.length < 6) list.push(path);
  hits.set(cls, list);
}

export function mergeHits(into: ClassHits, from: ClassHits) {
  for (const [cls, paths] of from) for (const p of paths) add(into, cls, p);
}

/** Names of the fields declared on a type node (classes, records, interfaces). */
export function typeFields(m: Model, typeId: string): GraphNode[] {
  return (m.children.get(typeId) ?? []).filter((c) => c.kind === "field" && !c.attrs?.static);
}

/** Finds the in-repo type a field's declared type refers to (Customer, List<OrderLine>, ...). */
function fieldTypeId(m: Model, field: GraphNode, index: Map<string, string[]>): string | undefined {
  const text = String(field.attrs?.type ?? "");
  const names = text.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  // the parent type's file/package is the best tie-breaker for duplicate simple names
  const owner = field.parent ? m.node(field.parent) : undefined;
  const ownerPrefix = owner?.id.slice(0, owner.id.lastIndexOf(".") + 1);
  for (const n of names.reverse()) {
    const ids = index.get(n);
    if (!ids?.length) continue;
    return ids.find((id) => ownerPrefix && id.startsWith(ownerPrefix)) ?? ids[0];
  }
  return undefined;
}

export class Classifier {
  private index = new Map<string, string[]>(); // simple type name -> type ids
  private cache = new Map<string, ClassHits>();

  constructor(private m: Model) {
    for (const n of m.ofKind("class", "interface", "enum")) {
      this.index.set(n.name, [...(this.index.get(n.name) ?? []), n.id]);
    }
  }

  /** Categories carried by a type, looking into nested in-repo types up to `depth` levels. */
  ofType(typeId: string, depth = 2, prefix = "", seen = new Set<string>()): ClassHits {
    const key = `${typeId}|${depth}|${prefix}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const hits: ClassHits = new Map();
    if (seen.has(typeId)) return hits;
    seen.add(typeId);
    const owner = this.m.node(typeId)?.name;
    for (const f of typeFields(this.m, typeId)) {
      const path = prefix ? `${prefix}.${f.name}` : f.name;
      const cls = classifyName(f.name, owner);
      if (cls) add(hits, cls, path);
      const nested = depth > 0 ? fieldTypeId(this.m, f, this.index) : undefined;
      if (nested) mergeHits(hits, this.ofType(nested, depth - 1, path, seen));
    }
    this.cache.set(key, hits);
    return hits;
  }

  ofNames(names: string[], prefix = "", owner?: string): ClassHits {
    const hits: ClassHits = new Map();
    for (const n of names) {
      const cls = classifyName(n, owner ?? prefix);
      if (cls) add(hits, cls, prefix ? `${prefix}.${n}` : n);
    }
    return hits;
  }

  /** Categories stored in a table, from its column names. */
  ofTable(table: GraphNode): ClassHits {
    const cols = (table.attrs?.columns as { name: string }[] | undefined) ?? [];
    return this.ofNames(cols.map((c) => c.name), table.name);
  }

  /** Categories in a payload descriptor {type, typeId?, fields?}; "params(a, b)" lists parameter names. */
  ofPayload(p: TypeInfo): ClassHits {
    if (p.typeId && this.m.node(p.typeId)) {
      const hits = this.ofType(p.typeId);
      if (p.fields) mergeHits(hits, this.ofNames(p.fields));
      return hits;
    }
    const params = p.type.match(/^params\((.*)\)$/)?.[1];
    if (params) return this.ofNames(params.split(",").map((s) => s.trim()));
    if (p.fields) return this.ofNames(p.fields);
    // a bare named type we know by simple name (e.g. Prisma model / TypeORM entity)
    const ids = this.index.get(p.type.replace(/\[\]$/, ""));
    return ids?.length === 1 ? this.ofType(ids[0]) : new Map();
  }
}

export interface TypeInfo {
  type: string;
  typeId?: string;
  fields?: string[];
}

export function highest(hits: ClassHits): "high" | "medium" | "low" | undefined {
  let best: "high" | "medium" | "low" | undefined;
  for (const cls of hits.keys()) {
    const s = CLASS_INFO[cls].severity;
    if (s === "high") return "high";
    if (s === "medium" || !best) best = s;
  }
  return best;
}
