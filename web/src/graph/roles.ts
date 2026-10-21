// What a class / module / package does, inferred from annotations, names and its I/O edges.
// Used to group diagrams by role ("Ingress", "Persistence"...) when the structure alone
// (packages) doesn't explain the system.
import type { GraphNode } from "../api";
import type { Model } from "./model";

export type Role = "Ingress" | "Messaging" | "Persistence" | "Integration" | "Domain" | "Model" | "Config";

export const ROLE_INFO: Record<Role, { order: number; hint: string }> = {
  Ingress: { order: 0, hint: "receives requests: controllers, HTTP/socket handlers" },
  Messaging: { order: 1, hint: "produces or consumes messages" },
  Domain: { order: 2, hint: "business logic and processing" },
  Integration: { order: 3, hint: "calls other services and external APIs" },
  Persistence: { order: 4, hint: "reads and writes data stores" },
  Model: { order: 5, hint: "entities, DTOs, events and value types" },
  Config: { order: 6, hint: "wiring, configuration, bootstrapping" },
};

const TYPES = new Set(["class", "interface", "enum"]);
const CALLABLE = new Set(["method", "function"]);

function edgeKinds(m: Model, ids: string[]): Set<string> {
  const kinds = new Set<string>();
  for (const id of ids) {
    for (const e of m.out.get(id) ?? []) kinds.add(e.kind);
    for (const e of m.in.get(id) ?? []) if (e.kind === "handles") kinds.add("handled");
  }
  return kinds;
}

/** Role of a class/interface/enum. */
export function typeRole(m: Model, t: GraphNode): Role {
  const stereo = String(t.attrs?.stereotype ?? "");
  const anns = (t.attrs?.annotations as string[] | undefined) ?? [];
  if (["RestController", "Controller", "Resolver"].includes(stereo)) return "Ingress";
  if (["Entity", "MappedSuperclass", "Embeddable"].includes(stereo) || t.attrs?.record || t.kind === "enum") return "Model";
  if (["Configuration", "SpringBootApplication", "Module"].includes(stereo) || /(Config|Configuration|Application|Module)$/.test(t.name)) return "Config";
  if (stereo === "Repository" || /(Repository|Dao|Store)$/.test(t.name)) return "Persistence";
  if (stereo === "FeignClient" || anns.includes("FeignClient")) return "Integration";
  const methods = (m.children.get(t.id) ?? []).filter((c) => CALLABLE.has(c.kind));
  const kinds = edgeKinds(m, methods.map((x) => x.id));
  if (kinds.has("handled")) return "Ingress";
  if (methods.some((x) => (x.attrs?.annotations as string[] | undefined)?.some((a) => /Listener$/.test(a)))) return "Messaging";
  if (kinds.has("consumes")) return "Messaging";
  // data holders: fields and trivial accessors only
  if (methods.every((x) => /^(get|set|is|has|<init>|constructor|equals|hashCode|toString)/.test(x.name)) && t.kind !== "interface") return "Model";
  if (t.kind === "interface" && !methods.length) return "Model";
  if (/(Client|Gateway|Adapter)$/.test(t.name) && kinds.has("http_calls")) return "Integration";
  return "Domain";
}

/** Role of a function-based module (a file/directory of functions, as in Express code). */
function functionsRole(m: Model, fns: GraphNode[]): Role {
  const kinds = edgeKinds(m, fns.map((f) => f.id));
  if (kinds.has("handled")) return "Ingress";
  if (kinds.has("consumes") || kinds.has("publishes")) return "Messaging";
  if (kinds.has("reads") || kinds.has("writes")) return "Persistence";
  if (kinds.has("http_calls") || kinds.has("connects_to")) return "Integration";
  return "Domain";
}

/** Role of a package/directory: the most common role of what it contains. */
export function packageRole(m: Model, pkgId: string): Role {
  const kids = m.children.get(pkgId) ?? [];
  const counts = new Map<Role, number>();
  for (const t of kids.filter((k) => TYPES.has(k.kind))) {
    const r = typeRole(m, t);
    counts.set(r, (counts.get(r) ?? 0) + 1);
  }
  const fns = kids.filter((k) => k.kind === "function");
  if (fns.length) {
    const r = functionsRole(m, fns);
    counts.set(r, (counts.get(r) ?? 0) + fns.length);
  }
  let best: Role = "Domain";
  let max = 0;
  for (const [r, n] of counts) {
    if (n > max || (n === max && ROLE_INFO[r].order < ROLE_INFO[best].order)) [best, max] = [r, n];
  }
  return best;
}

/** Data-system group for a store/topic/external node: "PostgreSQL", "Kafka", "External systems". */
export function systemGroup(n: GraphNode, m: Model): { id: string; label: string } | undefined {
  const t = n.kind === "table" ? m.node(n.parent ?? "") ?? n : n;
  switch (t.kind) {
    case "database": {
      const sys = t.otel?.["db.system"];
      const label = !sys || sys === "unknown" ? "Databases" : SYSTEM_NAMES[sys] ?? sys;
      return { id: `sys:db:${label}`, label };
    }
    case "topic":
    case "queue": {
      const sys = t.otel?.["messaging.system"] ?? "messaging";
      return { id: `sys:msg:${sys}`, label: SYSTEM_NAMES[sys] ?? sys };
    }
    case "external":
      return t.attrs?.ingress ? { id: "sys:ingress", label: "Ingress" } : { id: "sys:external", label: "External systems" };
  }
  return undefined;
}

const SYSTEM_NAMES: Record<string, string> = {
  postgresql: "PostgreSQL", mysql: "MySQL", mariadb: "MariaDB", mongodb: "MongoDB", redis: "Redis", h2: "H2",
  mssql: "SQL Server", oracle: "Oracle", sqlite: "SQLite", kafka: "Kafka", rabbitmq: "RabbitMQ", jms: "JMS",
};
