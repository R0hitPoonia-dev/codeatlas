// Just enough SQL reading to say which tables a statement reads and writes, and which columns
// it names. A port of the Java analyzer's Sql.java so both analyzers name tables the same way.
// "*" stands for parts that could not be resolved statically (e.g. `INSERT INTO ${table}`).

export interface Statement {
  verb: string;
  writes: Set<string>;
  reads: Set<string>;
  /** table -> columns it names */
  columns: Map<string, string[]>;
}

export const UNKNOWN = "*";

const IDENT = String.raw`((?:["\`\[]?[A-Za-z_*][\w$*]*["\`\]]?\.)?["\`\[]?[A-Za-z_*][\w$*]*["\`\]]?)`;
const VERB = /^\s*(?:\/\*[\s\S]*?\*\/\s*)*(SELECT|WITH|INSERT|UPDATE|DELETE|MERGE|UPSERT|REPLACE|TRUNCATE|CALL|EXEC|COPY)\b/i;
const INSERT = new RegExp(String.raw`\b(?:INSERT|UPSERT|REPLACE)\s+(?:IGNORE\s+)?INTO\s+${IDENT}\s*(?:\(([^)]*)\))?`, "gi");
const UPDATE = new RegExp(String.raw`^\s*UPDATE\s+(?:ONLY\s+)?${IDENT}`, "gi");
const DELETE = new RegExp(String.raw`\bDELETE\s+FROM\s+(?:ONLY\s+)?${IDENT}`, "gi");
const MERGE = new RegExp(String.raw`\bMERGE\s+INTO\s+${IDENT}`, "gi");
const TRUNCATE = new RegExp(String.raw`\bTRUNCATE\s+(?:TABLE\s+)?(?:ONLY\s+)?${IDENT}`, "gi");
const COPY = new RegExp(String.raw`^\s*COPY\s+${IDENT}(?:\s*\(([^)]*)\))?\s+FROM\b`, "i");
const FROM = new RegExp(String.raw`\b(?:FROM|JOIN|USING)\s+(?:ONLY\s+)?${IDENT}`, "gi");
const SELECT_LIST = new RegExp(String.raw`^\s*SELECT\s+(?:DISTINCT\s+)?([\s\S]*?)\s+FROM\s+${IDENT}`, "i");
const NOT_TABLES = new Set(["select", "lateral", "unnest", "values", "dual", "generate_series"]);

/** Reads a statement, or undefined if the text does not look like SQL. */
export function readSql(sql: string | undefined): Statement | undefined {
  if (!sql) return undefined;
  const v = sql.match(VERB);
  if (!v) return undefined;
  const verb = v[1].toUpperCase();
  const writes = new Set<string>();
  const reads = new Set<string>();
  const columns = new Map<string, string[]>();
  const body = sql.replace(/'(?:[^']|'')*'/g, "''"); // ignore FROM inside string literals

  for (const m of body.matchAll(INSERT)) {
    const t = table(m[1]);
    writes.add(t);
    if (m[2] !== undefined) columns.set(t, columnList(m[2]));
  }
  for (const re of [UPDATE, DELETE, MERGE, TRUNCATE]) {
    for (const m of body.matchAll(re)) writes.add(table(m[1]));
  }
  const copy = body.match(COPY);
  if (copy) {
    const t = table(copy[1]);
    writes.add(t);
    if (copy[2] !== undefined) columns.set(t, columnList(copy[2]));
  }
  for (const m of body.matchAll(FROM)) {
    const t = table(m[1]);
    if (!NOT_TABLES.has(t.toLowerCase()) && !(verb === "DELETE" && writes.has(t))) reads.add(t);
  }
  if (verb === "SELECT") {
    const m = body.match(SELECT_LIST);
    if (m) {
      const cols = columnList(m[1]);
      const t = table(m[2]);
      if (cols.length && !cols.includes("*") && !columns.has(t)) columns.set(t, cols);
    }
  }
  // the target of UPDATE ... FROM other is written, not read
  if (verb === "UPDATE" || verb === "DELETE") for (const w of writes) reads.delete(w);
  if (!writes.size && !reads.size && verb !== "CALL" && verb !== "EXEC") return undefined;
  return { verb, writes, reads, columns };
}

function table(raw: string): string {
  let t = raw.replace(/["`[\]]/g, "");
  const dot = t.lastIndexOf(".");
  // keep schema-qualified names, but unresolved ("*") schemas are dropped
  if (dot > 0 && t.slice(0, dot) === UNKNOWN) t = t.slice(dot + 1);
  return t;
}

/** "a, b AS x, t.c" -> [a, x, c]; expressions without a plain name are skipped. */
function columnList(list: string): string[] {
  const out: string[] = [];
  let level = 0;
  let cur = "";
  for (const c of list + ",") {
    if (c === "(") level++;
    else if (c === ")") level--;
    if (c === "," && level === 0) {
      const col = column(cur.trim());
      if (col) out.push(col);
      cur = "";
    } else {
      cur += c;
    }
  }
  return out;
}

function column(expr: string): string | undefined {
  if (expr === "*") return "*";
  const alias = expr.match(/\s+AS\s+["`]?(\w+)["`]?$/i);
  if (alias) return alias[1];
  return expr.match(/^(?:\w+\.)?["`]?(\w+)["`]?$/)?.[1];
}
