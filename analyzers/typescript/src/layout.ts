// Finds JS/TS packages (directories with a package.json and source files) in a repo.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", ".next", "coverage", "target", ".turbo"]);
const SOURCE_RE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const SERVER_DEPS = ["express", "@nestjs/core", "fastify", "koa", "@hapi/hapi", "next", "hono", "kafkajs", "amqplib", "ws",
  "socket.io", "node-cron", "cron", "bullmq", "bull"];

export interface Package {
  name: string;
  /** Repo-relative directory, "." for the root. */
  path: string;
  dir: string;
  tsconfig?: string;
  isService: boolean;
  dependencies: Set<string>;
  /** package.json main / bin targets, as absolute paths. */
  entryFiles: string[];
}

export function discoverPackages(root: string): Package[] {
  const found: Package[] = [];
  walk(root, (dir) => {
    const pj = join(dir, "package.json");
    if (!existsSync(pj) || !hasSources(dir)) return;
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(readFileSync(pj, "utf8"));
    } catch {
      // unreadable package.json: still analyse the sources
    }
    const deps = new Set<string>([
      ...Object.keys((json.dependencies as object) ?? {}),
      ...Object.keys((json.devDependencies as object) ?? {}),
    ]);
    const rel = relative(root, dir).replaceAll("\\", "/") || ".";
    const tsconfig = join(dir, "tsconfig.json");
    const bin = json.bin;
    const entryFiles = [json.main, ...(typeof bin === "string" ? [bin] : Object.values((bin as object) ?? {}))]
      .filter((f): f is string => typeof f === "string").map((f) => join(dir, f));
    found.push({
      name: typeof json.name === "string" && json.name ? json.name : rel === "." ? "root" : rel.split("/").pop()!,
      path: rel,
      dir,
      tsconfig: existsSync(tsconfig) ? tsconfig : undefined,
      isService: SERVER_DEPS.some((d) => deps.has(d)),
      dependencies: deps,
      entryFiles,
    });
  });
  return found;
}

function walk(dir: string, visit: (dir: string) => void) {
  visit(dir);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
      walk(join(dir, entry.name), visit);
    }
  }
}

function hasSources(dir: string, depth = 0): boolean {
  if (depth > 6) return false;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && SOURCE_RE.test(entry.name) && !entry.name.endsWith(".d.ts") && !isConfigFile(entry.name)) return true;
    if (entry.isDirectory() && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
      const sub = join(dir, entry.name);
      if (existsSync(join(sub, "package.json"))) continue; // nested package owns its own sources
      if (statSync(sub).isDirectory() && hasSources(sub, depth + 1)) return true;
    }
  }
  return false;
}

/** Tooling config files (vite.config.ts, jest.config.js, ...) are not application code. */
export function isConfigFile(name: string): boolean {
  return /\.config\.(ts|js|mjs|cjs)$/.test(name) || /^\..*rc\.(js|cjs)$/.test(name);
}

/** Test files are excluded from the architecture map. */
export function isTestFile(path: string): boolean {
  return /(\.|_)(test|spec)\.(ts|tsx|js|jsx)$/.test(path) || /(^|\/)(__tests__|__mocks__|test|tests)\//.test(path);
}
