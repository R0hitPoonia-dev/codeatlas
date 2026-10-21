#!/usr/bin/env node
// codeatlas-ts <repo-dir> [--repo NAME] [--commit SHA] [--branch NAME] [--out FILE]
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { VERSION, analyze } from "./analyzer.js";

function git(dir: string, ...args: string[]): string | undefined {
  try {
    const out = execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return out && out !== "HEAD" ? out : undefined;
  } catch {
    return undefined;
  }
}

function usage(code: number): never {
  process.stderr.write("usage: codeatlas-ts <repo-dir> [--repo NAME] [--commit SHA] [--branch NAME] [--out FILE]\n");
  process.exit(code);
}

const opts: Record<string, string> = {};
let dir: string | undefined;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "-h" || a === "--help") usage(0);
  if (["--repo", "--commit", "--branch", "--out"].includes(a)) {
    if (i + 1 >= argv.length) usage(2);
    opts[a.slice(2)] = argv[++i];
  } else if (!a.startsWith("-") && !dir) {
    dir = a;
  } else {
    usage(2);
  }
}
if (!dir) usage(2);

const root = resolve(dir);
const commit = opts.commit ?? git(root, "rev-parse", "HEAD");
if (!commit) {
  process.stderr.write("codeatlas-ts: not a git checkout; pass --commit\n");
  process.exit(2);
}
const doc = analyze(root, {
  repo: opts.repo ?? basename(root),
  commit,
  branch: opts.branch ?? git(root, "rev-parse", "--abbrev-ref", "HEAD"),
  analyzer: { name: "typescript", version: VERSION },
  generatedAt: new Date().toISOString(),
});
const json = JSON.stringify(doc);
if (opts.out) {
  writeFileSync(opts.out, json);
  process.stderr.write(`codeatlas-ts: wrote ${doc.nodes.length} nodes, ${doc.edges.length} edges to ${opts.out}\n`);
} else {
  process.stdout.write(json + "\n");
}
