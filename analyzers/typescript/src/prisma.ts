// Minimal Prisma schema reader: datasource provider, models, fields and relations.

export interface PrismaField {
  name: string;
  column: string;
  type: string;
  list: boolean;
  optional: boolean;
  id: boolean;
  unique: boolean;
  relation?: { fields: string[]; references: string[] };
  line: number;
}

export interface PrismaModel {
  name: string;
  table: string;
  fields: PrismaField[];
  line: number;
  endLine: number;
}

export interface PrismaSchema {
  provider?: string;
  models: PrismaModel[];
}

export function parsePrisma(text: string): PrismaSchema {
  const lines = text.split(/\r?\n/);
  const schema: PrismaSchema = { models: [] };
  let block: { kind: string; name: string; start: number } | undefined;
  let model: PrismaModel | undefined;

  lines.forEach((raw, i) => {
    const line = raw.replace(/\/\/.*$/, "").trim();
    if (!line) return;
    const oneLine = line.match(/^datasource\s+\w+\s*\{(.*)\}$/);
    if (oneLine) {
      schema.provider = oneLine[1].match(/provider\s*=\s*"([^"]+)"/)?.[1] ?? schema.provider;
      return;
    }
    const open = line.match(/^(model|datasource|generator|enum|view|type)\s+(\w+)\s*\{$/);
    if (open) {
      block = { kind: open[1], name: open[2], start: i + 1 };
      if (open[1] === "model") {
        model = { name: open[2], table: open[2], fields: [], line: i + 1, endLine: i + 1 };
      }
      return;
    }
    if (line === "}") {
      if (model) {
        model.endLine = i + 1;
        schema.models.push(model);
      }
      block = undefined;
      model = undefined;
      return;
    }
    if (!block) return;
    if (block.kind === "datasource") {
      const p = line.match(/^provider\s*=\s*"([^"]+)"/);
      if (p) schema.provider = p[1];
      return;
    }
    if (!model) return;
    const map = line.match(/^@@map\(\s*"([^"]+)"\s*\)/);
    if (map) {
      model.table = map[1];
      return;
    }
    if (line.startsWith("@@")) return;
    const f = line.match(/^(\w+)\s+(\w+)(\[\])?(\?)?\s*(.*)$/);
    if (!f) return;
    const attrs = f[5] ?? "";
    const field: PrismaField = {
      name: f[1],
      column: attrs.match(/@map\(\s*"([^"]+)"\s*\)/)?.[1] ?? f[1],
      type: f[2],
      list: !!f[3],
      optional: !!f[4],
      id: /@id\b/.test(attrs),
      unique: /@unique\b/.test(attrs),
      line: i + 1,
    };
    const rel = attrs.match(/@relation\(([^)]*)\)/);
    if (rel) {
      const list = (key: string) =>
        rel[1].match(new RegExp(`${key}\\s*:\\s*\\[([^\\]]*)\\]`))?.[1].split(",").map((s) => s.trim()).filter(Boolean) ?? [];
      const fields = list("fields");
      if (fields.length) field.relation = { fields, references: list("references") };
    }
    model.fields.push(field);
  });
  return schema;
}

/** Prisma client operation -> data access direction. */
export function prismaOperation(op: string): "reads" | "writes" | undefined {
  if (/^(find|count|aggregate|groupBy)/.test(op)) return "reads";
  if (/^(create|update|upsert|delete)/.test(op)) return "writes";
  return undefined;
}
