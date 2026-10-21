// The variables a function uses, each with the scope it is declared in (attrs.variables).
// Same shape as the Java analyzer's: param and local are the function's own, captured comes
// from an enclosing function (closures), field / static is class state, module is a
// top-level variable of the same file and imported one of another file.
import { Node, SyntaxKind, ts } from "ts-morph";

export interface Variable {
  name: string;
  scope: "param" | "local" | "captured" | "field" | "static" | "module" | "imported";
  type?: string;
  /** Field node id, enclosing function id, or the file a module variable lives in. */
  declaredIn?: string;
  line?: number;
  reads: number;
  writes: number;
  /** Lines it is used on, and the ones that change it. */
  lines?: number[];
  writeLines?: number[];
  final?: boolean;
}

/** Calls that change the object they are called on. */
const MUTATORS = new Set(["push", "pop", "shift", "unshift", "splice", "sort", "reverse", "fill", "copyWithin",
  "set", "delete", "clear", "add", "assign"]);
const MAX_VARIABLES = 60;
const MAX_LINES = 40;

const ASSIGNMENTS = new Set([
  SyntaxKind.EqualsToken, SyntaxKind.PlusEqualsToken, SyntaxKind.MinusEqualsToken, SyntaxKind.AsteriskEqualsToken,
  SyntaxKind.SlashEqualsToken, SyntaxKind.PercentEqualsToken, SyntaxKind.AmpersandEqualsToken, SyntaxKind.BarEqualsToken,
  SyntaxKind.CaretEqualsToken, SyntaxKind.LessThanLessThanEqualsToken, SyntaxKind.GreaterThanGreaterThanEqualsToken,
  SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken, SyntaxKind.AsteriskAsteriskEqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken, SyntaxKind.BarBarEqualsToken, SyntaxKind.AmpersandAmpersandEqualsToken,
]);

export interface Resolve {
  /** IR id of a class field (property / parameter property) declaration. */
  fieldId(decl: Node): string | undefined;
  /** IR id of the function or method a declaration sits in. */
  functionId(decl: Node): string | undefined;
  /** Repo-relative path of a file. */
  file(path: string): string;
}

/**
 * Variables used by `fn` (function, method, arrow or an entry module's top-level code).
 * Bodies in `separate` are functions of their own and are left out.
 */
export function variablesOf(fn: Node, separate: Set<ts.Node>, resolve: Resolve): Variable[] {
  const found = new Map<string, Variable>();
  const add = (key: string, init: () => Omit<Variable, "reads" | "writes">, use: Node) => {
    let v = found.get(key);
    if (!v) {
      v = { ...init(), reads: 0, writes: 0 };
      found.set(key, v);
    }
    const line = use.getStartLineNumber();
    if (v.line === undefined) v.line = line;
    const write = isWrite(use);
    if (write) v.writes++;
    else v.reads++;
    // where each use is, so diagrams can attach the variable to the step that uses it
    v.lines ??= [];
    if (!v.lines.includes(line) && v.lines.length < MAX_LINES) v.lines.push(line);
    if (write) {
      v.writeLines ??= [];
      if (!v.writeLines.includes(line) && v.writeLines.length < MAX_LINES) v.writeLines.push(line);
    }
  };

  // parameters are listed even when unused: they are the function's inputs
  if (!Node.isSourceFile(fn) && (Node.isFunctionLikeDeclaration(fn) || Node.isArrowFunction(fn) || Node.isFunctionExpression(fn))) {
    for (const p of fn.getParameters()) {
      if (Node.isIdentifier(p.getNameNode())) {
        found.set(p.getName(), { name: p.getName(), scope: "param", type: typeText(p), line: p.getStartLineNumber(), reads: 0, writes: 0 });
      }
    }
  }

  const mine = (n: Node) => {
    for (let p: Node | undefined = n; p; p = p.getParent()) {
      if (p === fn) return true;
      if (separate.has(p.compilerNode)) return false;
    }
    return false;
  };

  for (const id of fn.getDescendantsOfKind(SyntaxKind.Identifier)) {
    if (!mine(id) || !isValueUse(id)) continue;
    const parent = id.getParent();
    // this.x / Class.x: class state
    if (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === id) {
      const decl = declarationOf(id);
      if (!decl || !(Node.isPropertyDeclaration(decl) || Node.isParameterDeclaration(decl))) continue;
      const isStatic = Node.isPropertyDeclaration(decl) && decl.isStatic();
      const target = parent.getExpression();
      if (!isStatic && !Node.isThisExpression(target)) continue; // someone else's object
      const name = isStatic && !Node.isThisExpression(target) ? `${target.getText()}.${id.getText()}` : id.getText();
      add(`F:${name}`, () => ({
        name, scope: isStatic ? "static" : "field", type: typeText(decl), declaredIn: resolve.fieldId(decl),
        final: (Node.isPropertyDeclaration(decl) || Node.isParameterDeclaration(decl)) && decl.isReadonly() || undefined,
      }), parent);
      continue;
    }
    const decl = declarationOf(id);
    if (!decl || !(Node.isVariableDeclaration(decl) || Node.isParameterDeclaration(decl) || Node.isBindingElement(decl))) continue;
    if (Node.isVariableDeclaration(decl) && isFunctionValue(decl)) continue; // a function: a call, not state
    const sf = decl.getSourceFile();
    if (sf.isDeclarationFile() || sf.isFromExternalLibrary() || sf.isInNodeModules()) continue; // console, process...
    const name = id.getText();
    const fin = isConst(decl) || undefined;
    if (inside(decl, fn)) {
      if (found.get(name)?.scope === "param") {
        add(name, () => found.get(name)!, id);
      } else {
        add(name, () => ({ name, scope: Node.isParameterDeclaration(decl) && decl.getParent() === fn ? "param" : "local",
          type: typeText(decl), line: decl.getStartLineNumber(), final: fin }), id);
      }
      continue;
    }
    const owner = enclosingFunction(decl);
    if (owner) {
      add(`C:${name}`, () => ({ name, scope: "captured", type: typeText(decl), declaredIn: resolve.functionId(owner), final: fin }), id);
    } else {
      const same = sf === fn.getSourceFile();
      add(`M:${name}`, () => ({ name, scope: same ? "module" : "imported", type: typeText(decl),
        declaredIn: resolve.file(sf.getFilePath()), final: fin }), id);
    }
  }
  return [...found.values()].filter((v) => v.reads + v.writes > 0 || v.scope === "param").slice(0, MAX_VARIABLES);
}

/** The identifier names a value here, not a property name, declaration name, type or label. */
function isValueUse(id: Node): boolean {
  const p = id.getParent();
  if (!p) return false;
  if (Node.isPropertyAccessExpression(p)) return true; // both sides handled by the caller
  if (Node.isQualifiedName(p) || Node.isTypeReference(p) || Node.isImportSpecifier(p) || Node.isExportSpecifier(p)
    || Node.isImportClause(p) || Node.isNamespaceImport(p) || Node.isLabeledStatement(p)
    || Node.isBreakStatement(p) || Node.isContinueStatement(p) || Node.isJsxOpeningElement(p) || Node.isJsxClosingElement(p)
    || Node.isJsxSelfClosingElement(p) || Node.isJsxAttribute(p)) return false;
  // declaration names: const x, function f, (x) =>, { a: ... }
  if ((Node.isVariableDeclaration(p) || Node.isParameterDeclaration(p) || Node.isBindingElement(p) || Node.isFunctionDeclaration(p)
    || Node.isClassDeclaration(p) || Node.isMethodDeclaration(p) || Node.isPropertyDeclaration(p) || Node.isPropertyAssignment(p)
    || Node.isPropertySignature(p) || Node.isEnumMember(p) || Node.isInterfaceDeclaration(p) || Node.isTypeAliasDeclaration(p))
    && (p as Node & { getNameNode(): Node }).getNameNode() === id) return false;
  if (Node.isBindingElement(p) && p.getPropertyNameNode() === id) return false;
  return !id.getFirstAncestor((a) => Node.isTypeNode(a) && !Node.isExpressionWithTypeArguments(a));
}

function declarationOf(id: Node): Node | undefined {
  const p = id.getParent();
  if (Node.isShorthandPropertyAssignment(p)) {
    // { order } names the variable `order`, not the property
    const raw = id.getProject().getTypeChecker().compilerObject.getShorthandAssignmentValueSymbol(p.compilerNode);
    const d = raw?.declarations?.[0];
    return d ? (id as Node & { _getNodeFromCompilerNode(n: ts.Node): Node })._getNodeFromCompilerNode(d) : undefined;
  }
  let sym = id.getSymbol();
  if (sym?.isAlias()) sym = sym.getAliasedSymbol() ?? sym;
  return sym?.getDeclarations()[0];
}

function inside(n: Node, ancestor: Node) {
  for (let p: Node | undefined = n; p; p = p.getParent()) if (p === ancestor) return true;
  return false;
}

function enclosingFunction(n: Node): Node | undefined {
  return n.getFirstAncestor((a) => Node.isFunctionDeclaration(a) || Node.isMethodDeclaration(a) || Node.isConstructorDeclaration(a)
    || Node.isArrowFunction(a) || Node.isFunctionExpression(a) || Node.isGetAccessorDeclaration(a) || Node.isSetAccessorDeclaration(a));
}

function isFunctionValue(d: Node) {
  const init = Node.isVariableDeclaration(d) ? d.getInitializer() : undefined;
  return !!init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init));
}

function isConst(d: Node) {
  const list = d.getFirstAncestorByKind(SyntaxKind.VariableDeclarationList);
  return !!list && (list.getFlags() & ts.NodeFlags.Const) !== 0;
}

function typeText(d: Node): string | undefined {
  const node = (d as Node & { getTypeNode?: () => Node | undefined }).getTypeNode?.();
  let t = node?.getText();
  if (!t) {
    try {
      let ty = d.getType();
      if (ty.isLiteral() || ty.isBooleanLiteral()) ty = ty.getBaseTypeOfLiteralType(); // 10 -> number
      t = ty.getText(d, ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope);
    } catch {
      return undefined;
    }
  }
  t = t.replace(/import\([^)]*\)\./g, "").replace(/\s+/g, " ");
  if (t === "any" && !node) return undefined;
  return t.length > 60 ? t.slice(0, 57) + "..." : t;
}

/** Assigned, incremented, or the object of a mutating call (list.push(x), map.set(k, v)). */
function isWrite(use: Node): boolean {
  const p = use.getParent();
  if (Node.isBinaryExpression(p) && p.getLeft() === use && ASSIGNMENTS.has(p.getOperatorToken().getKind())) return true;
  if ((Node.isPrefixUnaryExpression(p) || Node.isPostfixUnaryExpression(p))
    && [SyntaxKind.PlusPlusToken, SyntaxKind.MinusMinusToken].includes(p.getOperatorToken())) return true;
  if (Node.isPropertyAccessExpression(p) && p.getExpression() === use) {
    const call = p.getParent();
    return Node.isCallExpression(call) && call.getExpression() === p && MUTATORS.has(p.getName());
  }
  return false;
}
