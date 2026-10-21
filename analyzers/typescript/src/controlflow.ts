// Structured control flow of a function body (attrs.controlFlow on function/method nodes):
// steps do / if / switch / loop / try / return / throw / jump, each listing the calls it
// makes, resolved to in-repo functions or to the stores/topics/remote services they touch.
// Same shape as the Java analyzer's, so the UI renders both the same way.
import { Node, SyntaxKind, Statement, ts } from "ts-morph";

export interface CallRef {
  kind: string; // calls | reads | writes | publishes | consumes | http_calls
  target: string;
  name: string;
  [extra: string]: unknown;
}

type Step = Record<string, unknown>;
type Guard = (parent: Node, child: Node) => string | undefined;

const MAX_STEPS = 400;

export function controlFlow(fn: Node, info: Map<ts.Node, CallRef>, guard: Guard): Step[] | undefined {
  if (Node.isSourceFile(fn)) {
    // module-level code of an entry file: everything except declarations and imports
    const runnable = fn.getStatements().filter((st) => !(Node.isImportDeclaration(st) || Node.isExportDeclaration(st)
      || Node.isFunctionDeclaration(st) || Node.isClassDeclaration(st) || Node.isInterfaceDeclaration(st)
      || Node.isTypeAliasDeclaration(st) || Node.isEnumDeclaration(st) || Node.isModuleDeclaration(st)));
    return new Builder(info, guard).block(runnable);
  }
  // functions, methods, constructors (bodyable: body may be absent) and arrows (bodied)
  const body = Node.isBodyable(fn) || Node.isBodied(fn) ? fn.getBody() : undefined;
  if (!body) return undefined;
  const b = new Builder(info, guard);
  if (Node.isBlock(body)) return b.block(body.getStatements());
  // expression-bodied arrow: `(x) => compute(x)`
  return [b.step("return", body, { text: text(body), ...b.callsOf(body, body) })];
}

function text(n: Node): string {
  const t = n.getText().replace(/\s+/g, " ").replace(/;$/, "").trim();
  return t.length > 90 ? t.slice(0, 87) + "..." : t;
}

class Builder {
  private steps = 0;

  constructor(private info: Map<ts.Node, CallRef>, private guard: Guard) {}

  step(k: string, at: Node, extra: Step): Step {
    return { k, line: at.getStartLineNumber(), ...extra };
  }

  block(stmts: Statement[]): Step[] {
    const out: Step[] = [];
    let pending: Step[] = [];
    let pendingStart: Node | undefined;
    const flush = () => {
      if (pending.length) out.push(this.step("do", pendingStart!, { items: pending }));
      pending = [];
    };
    for (const s of stmts) {
      if (this.steps++ > MAX_STEPS) break;
      if (Node.isExpressionStatement(s) || Node.isVariableStatement(s)) {
        if (!pending.length) pendingStart = s;
        pending.push({ text: text(s), line: s.getStartLineNumber(), ...this.callsOf(s, s) });
        continue;
      }
      flush();
      const st = this.statement(s);
      if (st) out.push(st);
    }
    flush();
    return out;
  }

  private branch(s: Statement | undefined): Step[] {
    if (!s) return [];
    return Node.isBlock(s) ? this.block(s.getStatements()) : this.block([s]);
  }

  private statement(s: Statement): Step | undefined {
    if (Node.isBlock(s)) {
      const body = this.block(s.getStatements());
      return body.length ? this.step("block", s, { body }) : undefined;
    }
    if (Node.isEmptyStatement(s)) return undefined;
    if (Node.isLabeledStatement(s)) return this.statement(s.getStatement());
    if (Node.isIfStatement(s)) {
      const cond = s.getExpression();
      const extra: Step = { cond: text(cond), ...this.callsOf(cond, s), then: this.branch(s.getThenStatement()) };
      const els = s.getElseStatement();
      if (els) extra.else = this.branch(els);
      return this.step("if", s, extra);
    }
    if (Node.isSwitchStatement(s)) {
      const on = s.getExpression();
      const cases = s.getCaseBlock().getClauses().map((c) => ({
        label: Node.isCaseClause(c) ? text(c.getExpression()) : "default",
        body: this.block(c.getStatements()),
      }));
      return this.step("switch", s, { on: text(on), ...this.callsOf(on, s), cases });
    }
    if (Node.isForOfStatement(s)) {
      const v = text(s.getInitializer()).replace(/^(const|let|var) /, "");
      return this.step("loop", s, {
        kind: "foreach", text: `for each ${v} of ${text(s.getExpression())}`,
        ...this.callsOf(s.getExpression(), s), body: this.branch(s.getStatement()),
      });
    }
    if (Node.isForInStatement(s)) {
      const v = text(s.getInitializer()).replace(/^(const|let|var) /, "");
      return this.step("loop", s, {
        kind: "foreach", text: `for each key ${v} in ${text(s.getExpression())}`,
        ...this.callsOf(s.getExpression(), s), body: this.branch(s.getStatement()),
      });
    }
    if (Node.isForStatement(s)) {
      const c = s.getCondition();
      return this.step("loop", s, {
        kind: "for", text: c ? `while ${text(c)}` : "loop", ...(c ? this.callsOf(c, s) : {}), body: this.branch(s.getStatement()),
      });
    }
    if (Node.isWhileStatement(s)) {
      return this.step("loop", s, {
        kind: "while", text: `while ${text(s.getExpression())}`, ...this.callsOf(s.getExpression(), s), body: this.branch(s.getStatement()),
      });
    }
    if (Node.isDoStatement(s)) {
      return this.step("loop", s, {
        kind: "do", text: `repeat while ${text(s.getExpression())}`, ...this.callsOf(s.getExpression(), s), body: this.branch(s.getStatement()),
      });
    }
    if (Node.isTryStatement(s)) {
      const extra: Step = { body: this.block(s.getTryBlock().getStatements()) };
      const c = s.getCatchClause();
      if (c) {
        const type = c.getVariableDeclaration()?.getTypeNode()?.getText() ?? "error";
        extra.catches = [{ type, body: this.block(c.getBlock().getStatements()) }];
      }
      const f = s.getFinallyBlock();
      if (f) extra.finally = this.block(f.getStatements());
      return this.step("try", s, extra);
    }
    if (Node.isReturnStatement(s)) {
      const e = s.getExpression();
      return this.step("return", s, e ? { text: text(e), ...this.callsOf(e, s) } : {});
    }
    if (Node.isThrowStatement(s)) {
      const e = s.getExpression();
      return this.step("throw", s, { text: text(e), ...this.callsOf(e, s) });
    }
    if (Node.isBreakStatement(s)) return this.step("jump", s, { text: "break" });
    if (Node.isContinueStatement(s)) return this.step("jump", s, { text: "continue" });
    // nested function/class declarations, etc.
    return this.step("do", s, { items: [{ text: text(s), line: s.getStartLineNumber(), ...this.callsOf(s, s) }] });
  }

  /** {calls: [...]} for resolved calls inside `expr`, in evaluation order; {} when none. */
  callsOf(expr: Node, stmt: Node): { calls?: Step[] } {
    const found: Node[] = [
      ...(Node.isCallExpression(expr) || Node.isNewExpression(expr) ? [expr] : []),
      ...expr.getDescendantsOfKind(SyntaxKind.CallExpression),
      ...expr.getDescendantsOfKind(SyntaxKind.NewExpression),
    ];
    found.sort((a, b) => a.getEnd() - b.getEnd() || b.getStart() - a.getStart());
    const calls: Step[] = [];
    for (const n of found) {
      const ref = this.info.get(n.compilerNode);
      if (!ref) continue;
      const when = this.guardsWithin(n, stmt);
      calls.push({ ...ref, text: text(n), line: n.getStartLineNumber(), ...(when.length ? { when: when.join(" › ") } : {}) });
    }
    return calls.length ? { calls } : {};
  }

  private guardsWithin(n: Node, stmt: Node): string[] {
    const out: string[] = [];
    let child = n;
    for (let p = n.getParent(); p && p !== stmt; child = p, p = p.getParent()) {
      const g = this.guard(p, child);
      if (g) out.push(g);
    }
    return out.reverse();
  }
}
