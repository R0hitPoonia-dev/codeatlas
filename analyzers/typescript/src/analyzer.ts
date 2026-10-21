// Turns a JS/TS repository into CodeAtlas IR: packages/services, directories, classes,
// functions, the call graph, and framework facts (Express/NestJS routes, Prisma/TypeORM
// tables, kafkajs topics, fetch/axios HTTP calls).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import {
  CallExpression,
  ClassDeclaration,
  Decorator,
  Expression,
  MethodDeclaration,
  Node,
  ObjectLiteralExpression,
  Project,
  SourceFile,
  SyntaxKind,
  ts,
} from "ts-morph";
import { Builder, Document, IrEdge, IrNode, Location, Source, addToList, setAttr, setOtel } from "./ir.js";
import { Package, SKIP_DIRS, discoverPackages, isConfigFile, isTestFile } from "./layout.js";
import { CallRef, controlFlow } from "./controlflow.js";
import { variablesOf } from "./variables.js";
import { parsePrisma, prismaOperation } from "./prisma.js";
import { readSql, Statement, UNKNOWN } from "./sql.js";

export const VERSION = "0.1.0";

const HTTP_VERBS = new Set(["get", "post", "put", "delete", "patch", "all"]);
const NEST_VERBS: Record<string, string> = { Get: "GET", Post: "POST", Put: "PUT", Delete: "DELETE", Patch: "PATCH", All: "ANY" };
const TYPEORM_COLUMNS = new Set([
  "Column", "PrimaryColumn", "PrimaryGeneratedColumn", "CreateDateColumn", "UpdateDateColumn", "DeleteDateColumn", "VersionColumn",
]);

interface Ctx {
  pkg: Package;
  serviceId: string;
  root: string;
}

export function analyze(root: string, source: Source): Document {
  return new Analyzer(root).run(source);
}

class Analyzer {
  private b = new Builder();
  /** compiler node -> IR node id, for functions/methods/classes we declared. */
  private ids = new Map<ts.Node, string>();
  /** Express router variable declaration -> mount prefixes. */
  private mounts = new Map<ts.Node, string[]>();
  /** entity class / prisma model name -> table id, per service. */
  private tables = new Map<string, string>();
  /** Declared functions/methods (for control flow) and what each call expression resolved to. */
  private callables: { node: Node; id: string }[] = [];
  private callInfo = new Map<ts.Node, CallRef>();
  private files = 0;

  constructor(private root: string) {}

  run(source: Source): Document {
    const packages = discoverPackages(this.root);
    for (const pkg of packages) this.analyzePackage(pkg, packages);
    process.stderr.write(`codeatlas-ts: ${packages.length} packages, ${this.files} files\n`);
    return this.b.build(source);
  }

  // ------------------------------------------------------------ packages

  private analyzePackage(pkg: Package, all: Package[]) {
    const serviceId = (pkg.isService ? "svc:" : "mod:") + pkg.name;
    const svc = this.b.node(serviceId, pkg.isService ? "service" : "module", pkg.name);
    svc.language = "typescript";
    setAttr(svc, "path", pkg.path);
    if (pkg.isService) setOtel(svc, "service.name", pkg.name);
    const ctx: Ctx = { pkg, serviceId, root: this.root };

    const project = new Project({
      ...(pkg.tsconfig ? { tsConfigFilePath: pkg.tsconfig, skipAddingFilesFromTsConfig: true } : {}),
      compilerOptions: { allowJs: true, experimentalDecorators: true, noEmit: true, skipLibCheck: true },
      skipFileDependencyResolution: true,
    });
    const nested = all.filter((p) => p !== pkg && p.dir.startsWith(pkg.dir + "/")).map((p) => p.dir);
    for (const file of sourceFiles(pkg.dir, nested)) project.addSourceFileAtPath(file);
    project.resolveSourceFileDependencies();
    const files = project.getSourceFiles().filter((sf) => sf.getFilePath().startsWith(pkg.dir + "/") && !sf.isDeclarationFile());
    this.files += files.length;

    this.prismaTables(ctx);
    for (const sf of files) this.declareFile(sf, ctx);
    for (const sf of files) this.typeormTable(sf, ctx);
    for (const sf of files) this.collectMounts(sf);
    for (const sf of files) this.entryModules(sf, ctx, files);
    for (const sf of files) this.scheduledAndThreads(sf, ctx);
    for (const sf of files) {
      this.relateFile(sf, ctx);
      this.routes(sf, ctx);
      this.calls(sf, ctx);
    }
    const separate = new Set(this.callables.map((c) => c.node.compilerNode));
    const resolve = {
      fieldId: (decl: Node) => {
        const cls = decl.getFirstAncestorByKind(SyntaxKind.ClassDeclaration);
        const name = (decl as Node & { getName?: () => string }).getName?.();
        return cls && name ? `field:${ctx.pkg.name}/${this.pkgRel(decl.getSourceFile(), ctx)}#${cls.getName() ?? "default"}.${name}` : undefined;
      },
      functionId: (decl: Node) => this.ids.get(decl.compilerNode),
      file: (path: string) => this.rel(path),
    };
    for (const { node, id } of this.callables) {
      const n = this.b.get(id)!;
      const cf = controlFlow(node, this.callInfo, guard);
      if (cf?.length) setAttr(n, "controlFlow", cf);
      const own = new Set(separate);
      own.delete(node.compilerNode);
      const vars = variablesOf(node, own, resolve);
      if (vars.length) setAttr(n, "variables", vars);
      const doc = docOf(node);
      if (doc) setAttr(n, "doc", doc);
    }
    this.callables = [];
  }

  private rel(file: string) {
    return relative(this.root, file).replaceAll("\\", "/");
  }

  private loc(n: Node): Location {
    return { file: this.rel(n.getSourceFile().getFilePath()), startLine: n.getStartLineNumber(), endLine: n.getEndLineNumber() };
  }

  private line(n: Node): Location {
    return { file: this.rel(n.getSourceFile().getFilePath()), startLine: n.getStartLineNumber() };
  }

  /** Path of a file relative to its package, used in ids: src/routes/x.ts */
  private pkgRel(sf: SourceFile, ctx: Ctx) {
    return relative(ctx.pkg.dir, sf.getFilePath()).replaceAll("\\", "/");
  }

  private dirNode(sf: SourceFile, ctx: Ctx): string {
    const dir = dirname(this.pkgRel(sf, ctx));
    if (dir === ".") return ctx.serviceId;
    const id = `pkg:${ctx.pkg.name}/${dir}`;
    const n = this.b.node(id, "package", dir);
    n.parent = ctx.serviceId;
    n.language = "typescript";
    return id;
  }

  // -------------------------------------------------------- declarations

  private declareFile(sf: SourceFile, ctx: Ctx) {
    const parent = this.dirNode(sf, ctx);
    const base = `${ctx.pkg.name}/${this.pkgRel(sf, ctx)}`;
    const lang = /\.(ts|tsx)$/.test(sf.getFilePath()) ? "typescript" : "javascript";

    for (const fn of sf.getFunctions()) {
      const name = fn.getName();
      if (!name) continue;
      this.declareFunction(fn, `fn:${base}#${name}`, name, parent, lang, base);
    }
    for (const stmt of sf.getVariableStatements()) {
      for (const decl of stmt.getDeclarations()) {
        const init = decl.getInitializer();
        if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
          const id = `fn:${base}#${decl.getName()}`;
          this.declareFunction(init, id, decl.getName(), parent, lang, base);
          this.ids.set(decl.compilerNode, id);
        }
      }
    }
    for (const cls of sf.getClasses()) this.declareClass(cls, base, parent, lang);
    for (const iface of sf.getInterfaces()) {
      const id = `class:${base}#${iface.getName()}`;
      const n = this.b.node(id, "interface", iface.getName());
      Object.assign(n, { parent, language: lang, location: this.loc(iface), qualifiedName: `${base}#${iface.getName()}` });
      this.ids.set(iface.compilerNode, id);
      for (const p of iface.getProperties()) {
        const f = this.b.node(`field:${base}#${iface.getName()}.${p.getName()}`, "field", p.getName());
        Object.assign(f, { parent: id, language: lang, location: this.loc(p) });
        setAttr(f, "type", p.getTypeNode()?.getText() ?? "unknown");
        if (p.hasQuestionToken()) setAttr(f, "optional", true);
      }
    }
    for (const en of sf.getEnums()) {
      const id = `class:${base}#${en.getName()}`;
      const n = this.b.node(id, "enum", en.getName());
      Object.assign(n, { parent, language: lang, location: this.loc(en) });
      setAttr(n, "values", en.getMembers().map((m) => m.getName()));
      this.ids.set(en.compilerNode, id);
    }
  }

  private declareFunction(fn: Node, id: string, name: string, parent: string, lang: string, base: string) {
    const n = this.b.node(id, "function", name);
    Object.assign(n, { parent, language: lang, location: this.loc(fn), qualifiedName: `${base}#${name}` });
    if (Node.isFunctionLikeDeclaration(fn)) this.signature(n, fn);
    setOtel(n, "code.function", name);
    setOtel(n, "code.filepath", n.location!.file);
    this.ids.set(fn.compilerNode, id);
    this.callables.push({ node: fn, id });
  }

  private signature(n: IrNode, fn: Node) {
    if (!Node.isFunctionLikeDeclaration(fn) && !Node.isArrowFunction(fn) && !Node.isFunctionExpression(fn)) return;
    const params = fn.getParameters().map((p) => ({ name: p.getName(), type: p.getTypeNode()?.getText() ?? "any" }));
    if (params.length) setAttr(n, "params", params);
    const ret = fn.getReturnTypeNode()?.getText();
    if (ret) setAttr(n, "returnType", ret);
    if (Node.isAsyncable(fn) && fn.isAsync()) setAttr(n, "async", true);
  }

  private declareClass(cls: ClassDeclaration, base: string, parent: string, lang: string) {
    const name = cls.getName() ?? "default";
    const id = `class:${base}#${name}`;
    const n = this.b.node(id, "class", name);
    Object.assign(n, { parent, language: lang, location: this.loc(cls), qualifiedName: `${base}#${name}` });
    this.ids.set(cls.compilerNode, id);
    const doc = docOf(cls);
    if (doc) setAttr(n, "doc", doc);
    const decorators = cls.getDecorators().map((d) => d.getName());
    if (decorators.length) setAttr(n, "annotations", decorators);
    const stereotype = decorators.find((d) => ["Controller", "Injectable", "Entity", "Module", "Resolver"].includes(d));
    if (stereotype) setAttr(n, "stereotype", stereotype);
    if (cls.isAbstract()) setAttr(n, "abstract", true);

    const field = (fname: string, type: string, node: Node, visibility: string, isStatic = false, readonly = false) => {
      const f = this.b.node(`field:${base}#${name}.${fname}`, "field", fname);
      Object.assign(f, { parent: id, language: lang, location: this.loc(node) });
      setAttr(f, "type", type);
      setAttr(f, "visibility", visibility);
      if (isStatic) setAttr(f, "static", true);
      if (readonly) setAttr(f, "final", true);
    };
    for (const p of cls.getProperties()) {
      field(p.getName(), p.getTypeNode()?.getText() ?? "any", p, p.getScope() ?? "public", p.isStatic(), p.isReadonly());
    }
    for (const ctor of cls.getConstructors()) {
      for (const p of ctor.getParameters()) {
        if (p.isParameterProperty()) field(p.getName(), p.getTypeNode()?.getText() ?? "any", p, p.getScope() ?? "public", false, p.isReadonly());
      }
      const mid = `method:${base}#${name}.constructor`;
      const m = this.b.node(mid, "method", "constructor");
      Object.assign(m, { parent: id, language: lang, location: this.loc(ctor) });
      setAttr(m, "constructor", true);
      this.signature(m, ctor);
      this.ids.set(ctor.compilerNode, mid);
      this.callables.push({ node: ctor, id: mid });
    }
    for (const method of cls.getMethods()) {
      const mid = `method:${base}#${name}.${method.getName()}`;
      const m = this.b.node(mid, "method", method.getName());
      Object.assign(m, { parent: id, language: lang, location: this.loc(method) });
      setAttr(m, "visibility", method.getScope() ?? "public");
      if (method.isStatic()) setAttr(m, "static", true);
      const decs = method.getDecorators().map((d) => d.getName());
      if (decs.length) setAttr(m, "annotations", decs);
      this.signature(m, method);
      setOtel(m, "code.namespace", name);
      setOtel(m, "code.function", method.getName());
      this.ids.set(method.compilerNode, mid);
      this.callables.push({ node: method, id: mid });
    }
  }

  // ------------------------------------------------------------ relations

  private relateFile(sf: SourceFile, ctx: Ctx) {
    const from = this.dirNode(sf, ctx);
    for (const imp of sf.getImportDeclarations()) {
      const target = imp.getModuleSpecifierSourceFile();
      if (!target || !target.getFilePath().startsWith(ctx.pkg.dir + "/") || target.isDeclarationFile()) continue;
      const to = this.dirNode(target, ctx);
      if (to !== from && to !== ctx.serviceId && from !== ctx.serviceId) {
        const e = this.b.edge(from, to, "depends_on");
        setAttr(e, "imports", ((e.attrs?.imports as number) ?? 0) + 1);
      }
    }
    for (const cls of sf.getClasses()) {
      const id = this.ids.get(cls.compilerNode)!;
      const ext = cls.getExtends();
      if (ext) this.relateType(id, ext.getExpression(), "extends", ext.getText());
      for (const impl of cls.getImplements()) this.relateType(id, impl.getExpression(), "implements", impl.getText());
      const typed: [string, Node | undefined][] = [
        ...cls.getProperties().map((p) => [p.getName(), p.getTypeNode()] as [string, Node | undefined]),
        ...cls.getConstructors().flatMap((c) =>
          c.getParameters().filter((p) => p.isParameterProperty()).map((p) => [p.getName(), p.getTypeNode()] as [string, Node | undefined]),
        ),
      ];
      for (const [fieldName, typeNode] of typed) {
        if (!typeNode) continue;
        const refs = [typeNode, ...typeNode.getDescendantsOfKind(SyntaxKind.TypeReference)];
        for (const ref of refs) {
          const target = Node.isTypeReference(ref) ? this.declId(ref.getTypeName()) : undefined;
          if (!target || target === id) continue;
          const e = this.b.edge(id, target, "references");
          addToList(e, "fields", fieldName);
          if (/\[\]$|^(Array|Set|Map|ReadonlyArray)</.test(typeNode.getText())) setAttr(e, "many", true);
        }
      }
    }
  }

  private relateType(id: string, expr: Node, kind: string, label: string) {
    const target = this.declId(expr);
    if (target) this.b.edge(id, target, kind);
    else addToList(this.b.get(id)!, kind, label);
  }

  /** IR id of the declaration an identifier/expression refers to (following imports). */
  private declId(expr: Node): string | undefined {
    let sym = expr.getSymbol();
    if (!sym) return undefined;
    if (sym.isAlias()) sym = sym.getAliasedSymbol() ?? sym;
    for (const d of sym.getDeclarations()) {
      const id = this.ids.get(d.compilerNode);
      if (id) return id;
    }
    return undefined;
  }

  // ---------------------------------------------------------------- calls

  /** Closest enclosing declared function/method of n. */
  private enclosing(n: Node): string | undefined {
    for (let p = n.getParent(); p; p = p.getParent()) {
      const id = this.ids.get(p.compilerNode);
      if (id && !id.startsWith("class:")) return id;
    }
    return undefined;
  }

  private calls(sf: SourceFile, ctx: Ctx) {
    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const caller = this.enclosing(call);
      if (!caller) continue;
      const at = this.line(call);
      const guards = this.guards(call);
      const target = this.declId(call.getExpression());
      const callee = call.getExpression();
      const name = Node.isPropertyAccessExpression(callee) ? callee.getName() : callee.getText().slice(0, 40);
      if (target && !target.startsWith("class:")) {
        this.b.edge(caller, target, "calls", at, guards);
        this.callInfo.set(call.compilerNode, { kind: "calls", target, name });
      }
      const io = this.frameworkCall(call, caller, at, guards, ctx);
      if (io) this.callInfo.set(call.compilerNode, target && !target.startsWith("class:") ? { ...io, method: target } : io);
    }
    // postgres.js / slonik / @vercel/postgres: sql`SELECT ...`
    for (const tt of sf.getDescendantsOfKind(SyntaxKind.TaggedTemplateExpression)) {
      const caller = this.enclosing(tt);
      if (!caller || !/(^|\.)sql$/i.test(tt.getTag().getText())) continue;
      const st = readSql(constString(tt.getTemplate())?.replace(/\{x\}/g, UNKNOWN));
      if (!st) continue;
      const ref = this.sql(st, caller, this.line(tt), this.guards(tt), ctx);
      if (ref) this.callInfo.set(tt.compilerNode, ref);
    }
    for (const nw of sf.getDescendantsOfKind(SyntaxKind.NewExpression)) {
      const caller = this.enclosing(nw);
      const target = this.declId(nw.getExpression());
      if (!caller || !target?.startsWith("class:")) continue;
      const ctor = target.replace(/^class:/, "method:") + ".constructor";
      if (this.b.has(ctor)) {
        this.b.edge(caller, ctor, "calls", this.line(nw), this.guards(nw));
        this.callInfo.set(nw.compilerNode, { kind: "calls", target: ctor, name: `new ${nw.getExpression().getText()}` });
      }
    }
  }

  /** Conditions under which n runs inside its enclosing declared function, outermost first. */
  private guards(n: Node): string[] {
    const out: string[] = [];
    let child: Node = n;
    for (let p = n.getParent(); p; child = p, p = p.getParent()) {
      const id = this.ids.get(p.compilerNode);
      if (id && !id.startsWith("class:")) break;
      const g = guard(p, child);
      if (g) out.push(g);
    }
    return out.reverse();
  }

  /** Records store / messaging / HTTP effects of a call; returns what it touched. */
  private frameworkCall(call: CallExpression, caller: string, at: Location, guards: string[], ctx: Ctx): CallRef | undefined {
    const callee = call.getExpression();
    const args = call.getArguments() as Expression[];
    const method = Node.isPropertyAccessExpression(callee) ? callee.getName() : Node.isIdentifier(callee) ? callee.getText() : "";
    const receiver = Node.isPropertyAccessExpression(callee) ? callee.getExpression() : undefined;
    const receiverText = receiver?.getText() ?? "";

    // fetch(url) / axios.get(url) / axios(url) / got(url)
    if (method === "fetch" && !receiver && args[0]) {
      const verb = optionString(args[1], "method")?.toUpperCase() ?? "GET";
      const e = this.httpCall(caller, constString(args[0]), verb, "fetch", at, guards);
      if (e) this.httpTypes(e, call, unwrapStringify(property(args[1], "body")));
      return e && httpRef(e);
    }
    if ((receiverText === "axios" || receiverText === "got") && HTTP_VERBS.has(method) && args[0]) {
      const e = this.httpCall(caller, constString(args[0]), method.toUpperCase(), receiverText, at, guards);
      if (e) this.httpTypes(e, call, ["post", "put", "patch"].includes(method) ? args[1] : undefined);
      return e && httpRef(e);
    }
    if ((method === "axios" || method === "got") && !receiver && args[0]) {
      const url = Node.isObjectLiteralExpression(args[0]) ? optionString(args[0], "url") : constString(args[0]);
      const e = this.httpCall(caller, url, optionString(args[0], "method")?.toUpperCase(), method, at, guards);
      if (e) this.httpTypes(e, call, property(args[0], "data"));
      return e && httpRef(e);
    }

    // kafkajs: producer.send({ topic }), consumer.subscribe({ topic | topics })
    if ((method === "send" || method === "subscribe") && args[0] && Node.isObjectLiteralExpression(args[0])) {
      const topics = [optionString(args[0], "topic"), ...optionStrings(args[0], "topics")].filter((t): t is string => !!t);
      let ref: CallRef | undefined;
      for (const t of topics) {
        const topic = this.b.node(`topic:${t}`, "topic", t);
        setOtel(topic, "messaging.destination.name", t);
        setOtel(topic, "messaging.system", "kafka");
        const e = this.b.edge(caller, topic.id, method === "send" ? "publishes" : "consumes", at, guards);
        const payload = method === "send" ? this.sentMessageType(args[0]) : this.parsedMessageType(call);
        if (payload) addToList(e, "payloads", payload);
        ref ??= { kind: e.kind, target: topic.id, name: method };
      }
      return ref;
    }

    // raw SQL through any client: pool.query("SELECT ..."), db.execute(sql), ...
    if (SQL_METHODS.has(method) && args[0]) {
      const st = readSql(constString(args[0])?.replace(/\{x\}/g, UNKNOWN));
      if (st) return this.sql(st, caller, at, guards, ctx);
    }
    // Redis clients (ioredis, node-redis)
    if (receiver && isClient(receiver, REDIS_CLIENT, /redis/i)) {
      const ref = this.redis(method, args, receiver, caller, at, guards, ctx);
      if (ref) return ref;
    }
    // RabbitMQ (amqplib channels)
    if (receiver && ["sendToQueue", "publish", "consume"].includes(method) && isClient(receiver, /create(Confirm)?Channel\(/, /^(channel|ch|chan)$/i)) {
      const ref = this.amqp(method, args, call, caller, at, guards);
      if (ref) return ref;
    }

    // prisma.<model>.<operation>(...)
    if (receiver && Node.isPropertyAccessExpression(receiver)) {
      const op = prismaOperation(method);
      const model = receiver.getName();
      const table = op && this.tables.get(`${ctx.pkg.name}:prisma:${model.toLowerCase()}`);
      if (table) {
        const e = this.b.edge(caller, table, op!, at, guards);
        addToList(e, "operations", method);
        addToList(e, op === "writes" ? "payloads" : "responses", { type: this.b.get(table)?.attrs?.model ?? model });
        return { kind: op!, target: table, name: method };
      }
    }

    // TypeORM: this.repo.find(...) where repo: Repository<Entity>
    if (receiver) {
      const entity = repositoryEntity(receiver);
      const table = entity && this.tables.get(`${ctx.pkg.name}:entity:${entity}`);
      if (table) {
        const op = /^(save|insert|update|upsert|delete|remove|softDelete|softRemove|increment|decrement|clear)/.test(method)
          ? "writes" : "reads";
        const e = this.b.edge(caller, table, op, at, guards);
        addToList(e, "operations", method);
        addToList(e, op === "writes" ? "payloads" : "responses", { type: entity, ...this.typeIdOf(entity, receiver) });
        return { kind: op, target: table, name: method };
      }
    }
    return undefined;
  }

  private httpCall(caller: string, url: string | undefined, verb: string | undefined, client: string, at: Location, guards: string[]) {
    const parsed = parseUrl(url);
    if (!parsed) return undefined;
    const ext = this.b.node(`ext:${parsed.host}`, "external", parsed.host);
    setOtel(ext, "server.address", parsed.host);
    const e = this.b.edge(caller, ext.id, "http_calls", at, guards);
    if (verb) setAttr(e, "method", verb);
    setAttr(e, "path", parsed.path);
    setAttr(e, "client", client);
    return e;
  }

  // ----------------------------------------------------------- data types

  /**
   * Request body type from the call; response type from the enclosing function's declared
   * return type (client wrappers like `fetchOrder(): Promise<OrderView>`).
   */
  private httpTypes(e: IrEdge, call: CallExpression, body: Node | undefined) {
    const payload = this.exprType(body);
    if (payload) addToList(e, "payloads", payload);
    const fn = call.getFirstAncestor((a) => Node.isFunctionLikeDeclaration(a) || Node.isArrowFunction(a));
    const ret = fn && (Node.isFunctionLikeDeclaration(fn) || Node.isArrowFunction(fn)) ? fn.getReturnTypeNode() : undefined;
    const response = this.typeNodeInfo(ret);
    if (response) addToList(e, "responses", response);
  }

  /** kafkajs `send({ topic, messages: [{ value: JSON.stringify(x) }] })` -> type of x. */
  private sentMessageType(opts: Node): TypeInfo | undefined {
    const messages = property(opts, "messages");
    const first = messages && Node.isArrayLiteralExpression(messages) ? messages.getElements()[0] : undefined;
    return this.exprType(unwrapStringify(property(first, "value")));
  }

  /** Consumers: the annotated type of a `JSON.parse(...)` in the same function. */
  private parsedMessageType(call: Node): TypeInfo | undefined {
    const fn = call.getFirstAncestor((a) => this.ids.has(a.compilerNode));
    for (const v of fn?.getDescendantsOfKind(SyntaxKind.VariableDeclaration) ?? []) {
      if (/JSON\.parse\(/.test(v.getInitializer()?.getText() ?? "")) {
        const t = this.typeNodeInfo(v.getTypeNode());
        if (t) return t;
      }
    }
    return undefined;
  }

  /** {type, typeId?} for a type annotation, unwrapping Promise<T> / Observable<T>. */
  private typeNodeInfo(t: Node | undefined): TypeInfo | undefined {
    while (t && Node.isTypeReference(t) && /^(Promise|Observable|Awaited)$/.test(t.getTypeName().getText()) && t.getTypeArguments()[0]) {
      t = t.getTypeArguments()[0];
    }
    if (!t || /^(void|undefined|never|any|unknown)$/.test(t.getText())) return undefined;
    const ref = Node.isTypeReference(t) ? t : t.getFirstDescendantByKind(SyntaxKind.TypeReference);
    const typeId = ref ? this.declId(ref.getTypeName()) : undefined;
    return { type: t.getText().replace(/\s+/g, " ").slice(0, 80), ...(typeId ? { typeId } : {}) };
  }

  /** Type of a value expression: its declaration's annotation, spread source, or literal field names. */
  private exprType(e: Node | undefined): TypeInfo | undefined {
    if (!e) return undefined;
    if (Node.isIdentifier(e) || Node.isPropertyAccessExpression(e)) {
      for (const d of declarations(e)) {
        if (Node.isVariableDeclaration(d) || Node.isParameterDeclaration(d) || Node.isPropertyDeclaration(d)) {
          const t = this.typeNodeInfo(d.getTypeNode());
          if (t) return t;
        }
      }
      const text = e.getType().getText(e);
      return /^(any|unknown)$/.test(text) || text.length > 80 ? undefined : { type: text };
    }
    if (Node.isObjectLiteralExpression(e)) {
      const spread = e.getProperties().find((p) => Node.isSpreadAssignment(p));
      const base = spread && Node.isSpreadAssignment(spread) ? this.exprType(spread.getExpression()) : undefined;
      const fields = e.getProperties().flatMap((p) => (Node.isPropertyAssignment(p) || Node.isShorthandPropertyAssignment(p) ? [p.getName()] : []));
      if (base) return fields.length ? { ...base, type: `${base.type} + {${fields.join(", ")}}`, fields } : base;
      return { type: `{${fields.join(", ")}}`, fields };
    }
    if (Node.isStringLiteral(e) || Node.isTemplateExpression(e) || Node.isNoSubstitutionTemplateLiteral(e)) return { type: "string" };
    return undefined;
  }

  private typeIdOf(name: string, at: Node): { typeId?: string } {
    const sf = at.getSourceFile();
    const decl = sf.getImportDeclarations().flatMap((i) => i.getNamedImports()).find((n) => n.getName() === name);
    const id = decl ? this.declId(decl.getNameNode()) : undefined;
    return id ? { typeId: id } : {};
  }

  // --------------------------------------------------------------- routes

  /** Records `x.use("/prefix", router)` so routes registered on `router` get the prefix. */
  private collectMounts(sf: SourceFile) {
    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression();
      const args = call.getArguments();
      if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== "use" || args.length < 2) continue;
      const prefix = constString(args[0] as Expression);
      if (prefix === undefined) continue;
      for (const a of args.slice(1)) {
        for (const d of declarations(a)) {
          this.mounts.set(d.compilerNode, [...(this.mounts.get(d.compilerNode) ?? []), prefix]);
        }
      }
    }
  }

  private routes(sf: SourceFile, ctx: Ctx) {
    this.servers(sf, ctx);
    // Express-style: app.get("/path", ...handlers)
    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression();
      const args = call.getArguments() as Expression[];
      if (!Node.isPropertyAccessExpression(callee) || !HTTP_VERBS.has(callee.getName()) || args.length < 2) continue;
      const path = constString(args[0]);
      if (path === undefined || !path.startsWith("/") || !isRouter(callee.getExpression())) continue;
      const prefixes = declarations(callee.getExpression()).flatMap((d) => this.mounts.get(d.compilerNode) ?? []);
      const verb = callee.getName() === "all" ? "ANY" : callee.getName().toUpperCase();
      const handler = this.handlerId(args[args.length - 1], verb, path, ctx);
      for (const prefix of prefixes.length ? prefixes : [""]) {
        this.endpoint(ctx, verb, joinRoute(prefix, path), handler, this.loc(call), "express");
      }
    }
    // NestJS: @Controller("prefix") class with @Get(":id") methods
    for (const cls of sf.getClasses()) {
      const ctl = cls.getDecorator("Controller");
      if (!ctl) continue;
      const prefix = decoratorPath(ctl);
      for (const m of cls.getMethods()) {
        for (const d of m.getDecorators()) {
          const verb = NEST_VERBS[d.getName()];
          if (!verb) continue;
          const ep = this.endpoint(ctx, verb, joinRoute(prefix, decoratorPath(d)), this.ids.get(m.compilerNode), this.loc(m), "nestjs");
          this.describeNestHandler(ep, m);
        }
      }
    }
  }

  private handlerId(arg: Expression, verb: string, path: string, ctx: Ctx): string | undefined {
    if (Node.isArrowFunction(arg) || Node.isFunctionExpression(arg)) {
      const sf = arg.getSourceFile();
      const base = `${ctx.pkg.name}/${this.pkgRel(sf, ctx)}`;
      const name = `${verb} ${path} handler`;
      const id = `fn:${base}#${name}@${arg.getStartLineNumber()}`;
      this.declareFunction(arg, id, name, this.dirNode(sf, ctx), "typescript", base);
      return id;
    }
    return this.declId(arg);
  }

  private endpoint(ctx: Ctx, verb: string, route: string, handler: string | undefined, at: Location, framework: string) {
    const name = `${verb} ${route}`;
    const e = this.b.node(`endpoint:${ctx.pkg.name}:${name}`, "endpoint", name);
    e.parent = ctx.serviceId;
    e.location = at;
    setAttr(e, "method", verb);
    setAttr(e, "route", route);
    setAttr(e, "framework", framework);
    if (verb !== "ANY") setOtel(e, "http.request.method", verb);
    setOtel(e, "http.route", route);
    if (handler) this.b.edge(e.id, handler, "handles");
    return e;
  }

  /** @Body() request type, @Param/@Query/@Headers inputs and declared response type of a NestJS handler. */
  private describeNestHandler(e: IrNode, m: MethodDeclaration) {
    const inputs: Record<string, string>[] = [];
    for (const p of m.getParameters()) {
      if (p.getDecorator("Body")) {
        const t = this.typeNodeInfo(p.getTypeNode());
        if (t) setAttr(e, "request", t);
      }
      for (const [dec, where] of [["Param", "path"], ["Query", "query"], ["Headers", "header"]] as const) {
        if (p.getDecorator(dec)) inputs.push({ name: p.getName(), type: p.getTypeNode()?.getText() ?? "any", in: where });
      }
    }
    if (inputs.length) setAttr(e, "inputs", inputs);
    const response = this.typeNodeInfo(m.getReturnTypeNode());
    if (response) setAttr(e, "response", response);
  }

  // ------------------------------------------------------------ databases

  // ------------------------------------------------- entry points (non-HTTP)

  /** Module-level code of a file as a function node, so its top-level calls have a caller. */
  private moduleNode(sf: SourceFile, ctx: Ctx, kind: "main" | "thread"): IrNode {
    const name = `${sf.getBaseName()} (${kind === "main" ? "entry" : "worker thread"})`;
    const existing = this.ids.get(sf.compilerNode);
    if (existing) {
      const n = this.b.get(existing)!;
      if (kind === "thread") {
        // an un-imported file found as an entry first turns out to be a worker's script
        setAttr(n, "entryPoint", "thread");
        n.name = name;
      }
      return n;
    }
    const base = `${ctx.pkg.name}/${this.pkgRel(sf, ctx)}`;
    const id = `fn:${base}#(module)`;
    const n = this.b.node(id, "function", name);
    Object.assign(n, { parent: this.dirNode(sf, ctx), language: "typescript", qualifiedName: `${base}#(module)` });
    n.location = { file: this.rel(sf.getFilePath()), startLine: 1, endLine: sf.getEndLineNumber() };
    setAttr(n, "entryPoint", kind);
    setAttr(n, "module", true);
    this.ids.set(sf.compilerNode, id);
    this.callables.push({ node: sf, id });
    return n;
  }

  /**
   * Program entry files: not imported by any other file of the package (or named by
   * package.json main/bin) and running code at the top level (`startServers()`, `app.listen()`).
   */
  private entryModules(sf: SourceFile, ctx: Ctx, files: SourceFile[]) {
    const runsCode = sf.getStatements().some((st) => Node.isExpressionStatement(st)
      && (st.getFirstDescendantByKind(SyntaxKind.CallExpression) || st.getFirstDescendantByKind(SyntaxKind.NewExpression)));
    if (!runsCode) return;
    const importedHere = files.some((other) => other !== sf
      && other.getImportDeclarations().some((i) => i.getModuleSpecifierSourceFile() === sf));
    if (!importedHere || ctx.pkg.entryFiles.some((f) => sameModule(f, sf.getFilePath()))) this.moduleNode(sf, ctx, "main");
  }

  /** setInterval / cron / node-schedule / CronJob callbacks, Nest @Cron, and worker_threads files. */
  private scheduledAndThreads(sf: SourceFile, ctx: Ctx) {
    const mark = (target: Node | undefined, schedule: string) => {
      if (!target) return;
      let id: string | undefined;
      if (Node.isArrowFunction(target) || Node.isFunctionExpression(target)) {
        const base = `${ctx.pkg.name}/${this.pkgRel(sf, ctx)}`;
        const name = `scheduled ${schedule}`;
        id = `fn:${base}#${name}@${target.getStartLineNumber()}`;
        this.declareFunction(target, id, name, this.dirNode(sf, ctx), "typescript", base);
      } else {
        id = this.declId(target);
      }
      const n = id ? this.b.get(id) : undefined;
      if (!n || !["function", "method"].includes(n.kind)) return;
      setAttr(n, "entryPoint", "scheduled");
      setAttr(n, "schedule", schedule);
    };
    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression();
      const args = call.getArguments();
      const text = callee.getText();
      if (text === "setInterval" && args[0]) {
        mark(args[0], `every ${constNumber(args[1]) ?? args[1]?.getText() ?? "?"} ms`);
      } else if (/(^|\.)(schedule|scheduleJob)$/.test(text) && args.length >= 2 && /cron|schedule/i.test(text)) {
        mark(args[args.length - 1], constString(args[0] as Expression) ?? args[0].getText());
      }
    }
    for (const nw of sf.getDescendantsOfKind(SyntaxKind.NewExpression)) {
      const text = nw.getExpression().getText();
      const args = nw.getArguments();
      if (/(^|\.)CronJob$/.test(text) && args.length >= 2) {
        mark(args[1], constString(args[0] as Expression) ?? args[0].getText());
      } else if (/(^|\.)Worker$/.test(text) && args[0]) {
        const worker = this.workerFile(sf, args[0]);
        if (worker) this.moduleNode(worker, ctx, "thread");
      }
    }
    for (const cls of sf.getClasses()) {
      for (const m of cls.getMethods()) {
        const d = m.getDecorator("Cron") ?? m.getDecorator("Interval") ?? m.getDecorator("Timeout");
        if (d) mark(m, `${d.getName()}(${d.getArguments().map((a) => a.getText()).join(", ")})`);
      }
    }
  }

  /** Source file a `new Worker("./w.js")` / `new Worker(new URL("./w.js", import.meta.url))` runs. */
  private workerFile(sf: SourceFile, arg: Node): SourceFile | undefined {
    const pathArg = Node.isNewExpression(arg) && /URL$/.test(arg.getExpression().getText()) ? arg.getArguments()[0] : arg;
    const rel = constString(pathArg as Expression);
    if (!rel || !rel.startsWith(".")) return undefined;
    const target = join(dirname(sf.getFilePath()), rel).replace(/\.(js|mjs|cjs)$/, "");
    for (const ext of [".ts", ".tsx", ".js", ".mjs", ".cjs", ""]) {
      const found = sf.getProject().getSourceFile(target + ext);
      if (found) return found;
    }
    return undefined;
  }

  // ------------------------------------------------ inbound sockets / raw HTTP

  /** net/tls/http.createServer(handler).listen(port) and ws WebSocketServer({ port }) + on("connection"). */
  private servers(sf: SourceFile, ctx: Ctx) {
    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression();
      if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== "createServer") continue;
      const mod = callee.getExpression().getText();
      const protocol = /^(net|tls)$/.test(mod) ? "TCP" : /^(http|https|http2)$/.test(mod) ? "HTTP" : undefined;
      if (!protocol) continue;
      const handlerArg = call.getArguments().find((a) => Node.isIdentifier(a) || Node.isArrowFunction(a) || Node.isFunctionExpression(a));
      const port = this.listenPort(call);
      const handler = handlerArg ? this.handlerId(handlerArg as Expression, protocol, `:${port ?? ""}`, ctx) : undefined;
      this.socketEndpoint(ctx, protocol, port, handler, this.loc(call), protocol === "TCP" ? `node-${mod}` : "node-http");
    }
    for (const nw of sf.getDescendantsOfKind(SyntaxKind.NewExpression)) {
      if (!/(^|\.)(WebSocketServer|Server)$/.test(nw.getExpression().getText())) continue;
      if (!/WebSocket/.test(nw.getExpression().getText()) && !this.importedFrom(sf, "ws", nw.getExpression().getText())) continue;
      const port = constNumber(property(nw.getArguments()[0], "port"));
      const decl = nw.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
      let handler: string | undefined;
      for (const c of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const e = c.getExpression();
        if (Node.isPropertyAccessExpression(e) && e.getName() === "on" && decl && e.getExpression().getText() === decl.getName()
          && constString(c.getArguments()[0] as Expression) === "connection" && c.getArguments()[1]) {
          handler = this.handlerId(c.getArguments()[1] as Expression, "WS", `:${port ?? ""}`, ctx);
        }
      }
      this.socketEndpoint(ctx, "WS", port, handler, this.loc(nw), "ws");
    }
  }

  /** Port passed to `.listen(port)` on the server a createServer call returns. */
  private listenPort(create: CallExpression): string | undefined {
    const parent = create.getParent();
    if (parent && Node.isPropertyAccessExpression(parent) && parent.getName() === "listen") {
      const listen = parent.getParent();
      if (listen && Node.isCallExpression(listen)) return constNumber(listen.getArguments()[0]);
    }
    const decl = create.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
    if (!decl) return undefined;
    for (const c of create.getSourceFile().getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const e = c.getExpression();
      if (Node.isPropertyAccessExpression(e) && e.getName() === "listen" && e.getExpression().getText() === decl.getName()) {
        return constNumber(c.getArguments()[0]);
      }
    }
    return undefined;
  }

  private socketEndpoint(ctx: Ctx, protocol: string, port: string | undefined, handler: string | undefined, at: Location, framework: string) {
    const name = port ? `${protocol} :${port}` : `${protocol} server`;
    const e = this.b.node(`endpoint:${ctx.pkg.name}:${name}`, "endpoint", name);
    e.parent = ctx.serviceId;
    e.location = at;
    setAttr(e, "protocol", protocol.toLowerCase());
    setAttr(e, "framework", framework);
    if (protocol !== "HTTP") setOtel(e, "network.transport", "tcp");
    if (port) {
      setAttr(e, "port", port);
      setOtel(e, "server.port", port);
    }
    if (handler) this.b.edge(e.id, handler, "handles");
  }

  private importedFrom(sf: SourceFile, module: string, name: string): boolean {
    return sf.getImportDeclarations().some((i) => i.getModuleSpecifierValue() === module
      && (i.getNamedImports().some((n) => (n.getAliasNode()?.getText() ?? n.getName()) === name) || i.getDefaultImport()?.getText() === name.split(".")[0]));
  }

  // ---------------------------------------------------- raw SQL / Redis / AMQP

  private sqlSystem(ctx: Ctx): string {
    const d = ctx.pkg.dependencies;
    if (d.has("pg") || d.has("postgres") || d.has("pg-promise") || d.has("@vercel/postgres")) return "postgresql";
    if (d.has("mysql") || d.has("mysql2")) return "mysql";
    if (d.has("better-sqlite3") || d.has("sqlite3") || d.has("sqlite")) return "sqlite";
    if (d.has("mssql") || d.has("tedious")) return "mssql";
    return "unknown";
  }

  /** Effects of a SQL statement on tables (unknown names fall back to the database). */
  private sql(st: Statement, caller: string, at: Location, guards: string[], ctx: Ctx): CallRef | undefined {
    const db = this.databaseNode(ctx, this.sqlSystem(ctx));
    let ref: CallRef | undefined;
    for (const [op, tables] of [["writes", st.writes], ["reads", st.reads]] as const) {
      for (const t of tables) {
        const known = t !== UNKNOWN;
        const target = known ? this.sqlTable(db, t) : db;
        const cols = st.columns.get(t) ?? [];
        if (known && cols.length) mergeColumns(this.b.get(target)!, cols);
        const e = this.b.edge(caller, target, op, at, guards);
        addToList(e, "operations", st.verb);
        addToList(e, op === "writes" ? "payloads" : "responses", {
          type: `${known ? t : "row"} ${op === "writes" ? "row" : "rows"}`, ...(cols.length ? { fields: cols } : {}),
        });
        ref ??= { kind: op, target, name: `${st.verb}${known ? " " + t : ""}` };
      }
    }
    return ref;
  }

  private sqlTable(db: string, name: string): string {
    const id = `table:${db.slice(3)}.${name}`;
    if (!this.b.has(id)) {
      const t = this.b.node(id, "table", name);
      t.parent = db;
      setOtel(t, "db.collection.name", name);
      setOtel(t, "db.sql.table", name);
    }
    return id;
  }

  private redisNode(ctx: Ctx, receiver: Node): string {
    let host = `${ctx.pkg.name}-redis`;
    for (const d of declarations(receiver)) {
      if (!Node.isVariableDeclaration(d) && !Node.isPropertyDeclaration(d)) continue;
      const init = d.getInitializer();
      const arg = init && (Node.isNewExpression(init) || Node.isCallExpression(init)) ? init.getArguments()[0] : undefined;
      const url = constString(arg as Expression | undefined) ?? optionString(arg, "url");
      const h = url?.match(/^rediss?:\/\/(?:[^@/]*@)?([^:/]+)/)?.[1] ?? optionString(arg, "host");
      if (h) host = h;
    }
    const id = `db:redis/${host}`;
    if (!this.b.has(id)) {
      const db = this.b.node(id, "database", host);
      setOtel(db, "db.system", "redis");
      setOtel(db, "server.address", host);
      setAttr(db, "usedBy", ctx.serviceId);
    }
    return id;
  }

  private redis(method: string, args: Expression[], receiver: Node, caller: string, at: Location, guards: string[], ctx: Ctx): CallRef | undefined {
    const m = method.toLowerCase();
    const kind = m === "publish" ? "publishes" : m === "subscribe" || m === "psubscribe" ? "consumes"
      : REDIS_WRITES.has(m) ? "writes" : REDIS_READS.has(m) ? "reads" : undefined;
    if (!kind || !args[0]) return undefined;
    const key = (constString(args[0]) ?? UNKNOWN).replace(/\{x\}/g, "*").replace(/\*+/g, "*");
    const db = this.redisNode(ctx, receiver);
    let target: string;
    if (kind === "publishes" || kind === "consumes") {
      const ch = this.b.node(`topic:redis:${key}`, "topic", key);
      setOtel(ch, "messaging.destination.name", key);
      setOtel(ch, "messaging.system", "redis");
      setAttr(ch, "channel", true);
      target = ch.id;
    } else if (key === UNKNOWN) {
      target = db;
    } else {
      target = this.sqlTable(db, key);
      const t = this.b.get(target)!;
      setAttr(t, "keyPattern", true);
      if (!t.attrs?.redisType) setAttr(t, "redisType", redisType(m));
    }
    const e = this.b.edge(caller, target, kind, at, guards);
    addToList(e, "operations", method);
    if ((kind === "writes" || kind === "publishes") && args.length >= 2) {
      const payload = this.exprType(unwrapStringify(args[args.length - 1]));
      if (payload) addToList(e, "payloads", payload);
    }
    return { kind, target, name: `${method} ${key}` };
  }

  /** amqplib: sendToQueue(q, buf), publish(exchange, key, buf), consume(q, handler). */
  private amqp(method: string, args: Expression[], call: CallExpression, caller: string, at: Location, guards: string[]): CallRef | undefined {
    const name = method === "publish" ? constString(args[1]) || constString(args[0]) : constString(args[0]);
    if (!name) return undefined;
    const q = this.b.node(`queue:${name}`, "queue", name);
    setOtel(q, "messaging.destination.name", name);
    setOtel(q, "messaging.system", "rabbitmq");
    const kind = method === "consume" ? "consumes" : "publishes";
    const e = this.b.edge(caller, q.id, kind, at, guards);
    const payload = kind === "publishes"
      ? this.exprType(unwrapStringify(unwrapBuffer(args[method === "publish" ? 2 : 1])))
      : this.parsedMessageType(args[1] ?? call);
    if (payload) addToList(e, "payloads", payload);
    return { kind, target: q.id, name: `${method} ${name}` };
  }

  private databaseNode(ctx: Ctx, system: string): string {
    const id = `db:${ctx.pkg.name}-db`;
    const db = this.b.node(id, "database", `${ctx.pkg.name}-db`);
    setOtel(db, "db.system", system);
    setAttr(db, "usedBy", ctx.serviceId);
    return id;
  }

  private prismaTables(ctx: Ctx) {
    for (const file of findFiles(ctx.pkg.dir, "schema.prisma")) {
      const schema = parsePrisma(readFileSync(file, "utf8"));
      if (!schema.models.length) continue;
      const dbId = this.databaseNode(ctx, schema.provider === "postgres" ? "postgresql" : schema.provider ?? "unknown");
      const models = new Map(schema.models.map((m) => [m.name, m]));
      const tableId = (m: { table: string }) => `table:${dbId.slice(3)}.${m.table}`;
      for (const m of schema.models) {
        const t = this.b.node(tableId(m), "table", m.table);
        t.parent = dbId;
        t.location = { file: this.rel(file), startLine: m.line, endLine: m.endLine };
        setOtel(t, "db.collection.name", m.table);
        setOtel(t, "db.sql.table", m.table);
        setAttr(t, "model", m.name);
        const fkColumns = new Set(m.fields.flatMap((f) => f.relation?.fields ?? []));
        setAttr(t, "columns", m.fields.filter((f) => !models.has(f.type)).map((f) => ({
          name: f.column,
          type: f.type,
          ...(f.id ? { primaryKey: true } : {}),
          ...(fkColumns.has(f.name) ? { foreignKey: true } : {}),
          ...(f.optional ? {} : { nullable: false }),
          ...(f.unique ? { unique: true } : {}),
        })));
        this.tables.set(`${ctx.pkg.name}:prisma:${m.name.toLowerCase()}`, t.id);
      }
      for (const m of schema.models) {
        for (const f of m.fields) {
          const target = models.get(f.type);
          if (!target || !f.relation) continue;
          const unique = f.relation.fields.every((c) => m.fields.find((x) => x.name === c)?.unique);
          const e = this.b.edge(tableId(m), tableId(target), "references", { file: this.rel(file), startLine: f.line });
          setAttr(e, "cardinality", unique ? "one-to-one" : "many-to-one");
          setAttr(e, "column", f.relation.fields.map((c) => m.fields.find((x) => x.name === c)?.column ?? c).join(","));
        }
      }
    }
  }

  private typeormTable(sf: SourceFile, ctx: Ctx) {
    for (const cls of sf.getClasses()) {
      const ent = cls.getDecorator("Entity");
      if (!ent) continue;
      const name = cls.getName() ?? "entity";
      const table = decoratorPath(ent) || optionString(ent.getArguments()[0] as Expression, "name") || snakeCase(name);
      const dbId = this.databaseNode(ctx, "unknown");
      const t = this.b.node(`table:${dbId.slice(3)}.${table}`, "table", table);
      t.parent = dbId;
      t.location = this.loc(cls);
      setOtel(t, "db.collection.name", table);
      setOtel(t, "db.sql.table", table);
      const columns: Record<string, unknown>[] = [];
      for (const p of cls.getProperties()) {
        const decs = p.getDecorators().map((d) => d.getName());
        const col = decs.find((d) => TYPEORM_COLUMNS.has(d));
        const rel = p.getDecorator("ManyToOne") ?? p.getDecorator("OneToOne");
        if (col) {
          columns.push({
            name: p.getName(),
            type: p.getTypeNode()?.getText() ?? "any",
            ...(col.startsWith("Primary") ? { primaryKey: true } : {}),
            ...(p.hasQuestionToken() ? {} : { nullable: false }),
          });
        } else if (rel && (rel.getName() === "ManyToOne" || p.getDecorator("JoinColumn"))) {
          const joinCol = optionString(p.getDecorator("JoinColumn")?.getArguments()[0] as Expression, "name") ?? `${p.getName()}Id`;
          columns.push({ name: joinCol, type: "fk", foreignKey: true });
          const targetCls = relationTarget(rel);
          if (targetCls) {
            const e = this.b.edge(t.id, `__pending:${ctx.pkg.name}:${targetCls}`, "references", this.line(p));
            setAttr(e, "cardinality", rel.getName() === "ManyToOne" ? "many-to-one" : "one-to-one");
            setAttr(e, "column", joinCol);
          }
        }
      }
      setAttr(t, "columns", columns);
      setAttr(t, "entity", name);
      this.tables.set(`${ctx.pkg.name}:entity:${name}`, t.id);
      const classId = this.ids.get(cls.compilerNode);
      if (classId) setAttr(this.b.edge(classId, t.id, "references"), "via", "typeorm");
    }
    this.resolvePendingRelations(ctx);
  }

  /** Relations recorded before their target entity was seen are re-pointed once it exists. */
  private resolvePendingRelations(ctx: Ctx) {
    for (const [key, tableId] of this.tables) {
      const [pkg, kind, name] = key.split(":");
      if (pkg !== ctx.pkg.name || kind !== "entity") continue;
      this.b.retarget(`__pending:${pkg}:${name}`, tableId);
    }
  }
}

// ---------------------------------------------------------------- helpers

function sourceFiles(dir: string, excludeDirs: string[]): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    if (excludeDirs.includes(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) walk(p);
      } else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(e.name) && !e.name.endsWith(".d.ts") && !isConfigFile(e.name)
        && !isTestFile(relative(dir, p).replaceAll("\\", "/"))) {
        out.push(p);
      }
    }
  };
  walk(dir);
  return out.sort();
}

function findFiles(dir: string, name: string): string[] {
  const out: string[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > 4) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) walk(join(d, e.name), depth + 1);
      else if (e.isFile() && e.name === name) out.push(join(d, e.name));
    }
  };
  if (existsSync(dir)) walk(dir, 0);
  return out;
}

function declarations(n: Node): Node[] {
  let sym = n.getSymbol();
  if (!sym) return [];
  if (sym.isAlias()) sym = sym.getAliasedSymbol() ?? sym;
  return sym.getDeclarations();
}

/** Is `expr` an Express app/router? Uses the declared initializer, then naming conventions. */
function isRouter(expr: Node): boolean {
  for (const d of declarations(expr)) {
    if (Node.isVariableDeclaration(d)) {
      const init = d.getInitializer()?.getText() ?? "";
      if (/^(express\s*\(|(express\.)?Router\s*\(|new\s+(Router|Hono|Koa)\b|fastify\s*\()/.test(init)) return true;
    }
  }
  return /^(app|router|server|api)$|Router$/i.test(expr.getText());
}

/** Evaluates literals, template strings and references to string constants. Unknown parts become {x}. */
export function constString(e: Node | undefined, depth = 0): string | undefined {
  if (!e || depth > 6) return undefined;
  if (Node.isStringLiteral(e) || Node.isNoSubstitutionTemplateLiteral(e)) return e.getLiteralValue();
  if (Node.isTemplateExpression(e)) {
    let s = e.getHead().getLiteralText();
    for (const span of e.getTemplateSpans()) {
      s += (constString(span.getExpression(), depth + 1) ?? "{x}") + span.getLiteral().getLiteralText();
    }
    return s;
  }
  if (Node.isBinaryExpression(e) && [SyntaxKind.QuestionQuestionToken, SyntaxKind.BarBarToken].includes(e.getOperatorToken().getKind())) {
    // process.env.X ?? "default": the constant is what we can know statically
    return constString(e.getLeft(), depth + 1) ?? constString(e.getRight(), depth + 1);
  }
  if (Node.isBinaryExpression(e) && e.getOperatorToken().getKind() === SyntaxKind.PlusToken) {
    const l = constString(e.getLeft(), depth + 1);
    if (l === undefined) return undefined;
    return l + (constString(e.getRight(), depth + 1) ?? "{x}");
  }
  if (Node.isParenthesizedExpression(e) || Node.isAsExpression(e)) return constString(e.getExpression(), depth + 1);
  if (Node.isIdentifier(e) || Node.isPropertyAccessExpression(e)) {
    for (const d of declarations(e)) {
      if (Node.isVariableDeclaration(d) || Node.isPropertyAssignment(d) || Node.isEnumMember(d)) {
        const v = constString(d.getInitializer(), depth + 1);
        if (v !== undefined) return v;
      }
    }
  }
  return undefined;
}

function property(obj: Node | undefined, key: string): Node | undefined {
  if (!obj || !Node.isObjectLiteralExpression(obj)) return undefined;
  const p = (obj as ObjectLiteralExpression).getProperty(key);
  if (p && Node.isPropertyAssignment(p)) return p.getInitializer();
  if (p && Node.isShorthandPropertyAssignment(p)) return p.getNameNode();
  return undefined;
}

function optionString(obj: Node | undefined, key: string): string | undefined {
  return constString(property(obj, key));
}

function optionStrings(obj: Node | undefined, key: string): string[] {
  const v = property(obj, key);
  if (v && Node.isArrayLiteralExpression(v)) {
    return v.getElements().map((x) => constString(x)).filter((s): s is string => s !== undefined);
  }
  return [];
}

function decoratorPath(d: Decorator): string {
  const arg = d.getArguments()[0];
  if (!arg) return "";
  if (Node.isObjectLiteralExpression(arg)) return optionString(arg, "path") ?? "";
  return constString(arg) ?? "";
}

export function joinRoute(prefix: string, path: string): string {
  const r = `/${prefix}/${path}`.replace(/\/+/g, "/");
  return r.length > 1 && r.endsWith("/") ? r.slice(0, -1) : r;
}

export function parseUrl(url: string | undefined): { host: string; path: string } | undefined {
  if (!url || !/^https?:\/\//.test(url)) return undefined;
  try {
    const u = new URL(url.replace(/\{x\}/g, "x"));
    return { host: u.hostname, path: decodeURI(u.pathname).replace(/\/x(?=\/|$)/g, "/{x}") || "/" };
  } catch {
    return undefined;
  }
}

/** `Repository<User>` from the receiver's declared type, or @InjectRepository(User). */
function repositoryEntity(receiver: Node): string | undefined {
  const target = Node.isPropertyAccessExpression(receiver) ? receiver : receiver;
  for (const d of declarations(target)) {
    if (Node.isPropertyDeclaration(d) || Node.isParameterDeclaration(d) || Node.isVariableDeclaration(d)) {
      const m = d.getTypeNode()?.getText().match(/^Repository<\s*(\w+)\s*>$/);
      if (m) return m[1];
      if (!Node.isVariableDeclaration(d)) {
        const inject = d.getDecorator("InjectRepository")?.getArguments()[0];
        if (inject) return inject.getText();
      }
    }
  }
  return undefined;
}

/** @ManyToOne(() => User, ...) -> "User" */
function relationTarget(rel: Decorator): string | undefined {
  const arg = rel.getArguments()[0];
  if (arg && Node.isArrowFunction(arg)) return arg.getBody().getText();
  if (arg && Node.isStringLiteral(arg)) return arg.getLiteralValue();
  return undefined;
}

export function snakeCase(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

interface TypeInfo {
  type: string;
  typeId?: string;
  fields?: string[];
}

/** JSON.stringify(x) -> x */
function unwrapStringify(e: Node | undefined): Node | undefined {
  if (e && Node.isCallExpression(e) && e.getExpression().getText() === "JSON.stringify") return e.getArguments()[0];
  return e;
}

const LAMBDA_GUARDS: Record<string, string> = {
  forEach: "for each", map: "for each", flatMap: "for each", catch: "on error", finally: "always (finally)",
};

/** The condition parent `p` imposes on its direct child `child`, if any. */
function guard(p: Node, child: Node): string | undefined {
  const text = (n: Node) => {
    const t = n.getText().replace(/\s+/g, " ").trim();
    return t.length > 90 ? t.slice(0, 87) + "..." : t;
  };
  if (Node.isIfStatement(p)) {
    if (p.getThenStatement() === child) return `if ${text(p.getExpression())}`;
    if (p.getElseStatement() === child) return `if not (${text(p.getExpression())})`;
  } else if (Node.isConditionalExpression(p)) {
    if (p.getWhenTrue() === child) return `if ${text(p.getCondition())}`;
    if (p.getWhenFalse() === child) return `if not (${text(p.getCondition())})`;
  } else if (Node.isCaseClause(p)) {
    const sw = p.getFirstAncestorByKind(SyntaxKind.SwitchStatement);
    return `if ${sw ? text(sw.getExpression()) : "value"} is ${text(p.getExpression())}`;
  } else if (Node.isDefaultClause(p)) {
    const sw = p.getFirstAncestorByKind(SyntaxKind.SwitchStatement);
    return `default case of ${sw ? text(sw.getExpression()) : "switch"}`;
  } else if (Node.isForOfStatement(p) && p.getStatement() === child) {
    return `for each ${text(p.getInitializer()).replace(/^(const|let|var) /, "")} of ${text(p.getExpression())}`;
  } else if (Node.isForInStatement(p) && p.getStatement() === child) {
    return `for each key ${text(p.getInitializer()).replace(/^(const|let|var) /, "")} in ${text(p.getExpression())}`;
  } else if (Node.isForStatement(p) && p.getStatement() === child) {
    const c = p.getCondition();
    return c ? `loop while ${text(c)}` : "loop";
  } else if (Node.isWhileStatement(p) && p.getStatement() === child) {
    return `while ${text(p.getExpression())}`;
  } else if (Node.isDoStatement(p) && p.getStatement() === child) {
    return `repeat while ${text(p.getExpression())}`;
  } else if (Node.isCatchClause(p)) {
    return "on error";
  } else if (Node.isBinaryExpression(p) && p.getRight() === child) {
    const op = p.getOperatorToken().getKind();
    if (op === SyntaxKind.AmpersandAmpersandToken) return `if ${text(p.getLeft())}`;
    if (op === SyntaxKind.BarBarToken || op === SyntaxKind.QuestionQuestionToken) return `if not (${text(p.getLeft())})`;
  } else if (Node.isArrowFunction(p) || Node.isFunctionExpression(p)) {
    const parent = p.getParent();
    if (parent && Node.isCallExpression(parent)) {
      const callee = parent.getExpression();
      const name = Node.isPropertyAccessExpression(callee) ? callee.getName() : "";
      return LAMBDA_GUARDS[name];
    }
    if (parent && Node.isPropertyAssignment(parent) && /^each(Message|Batch)$/.test(parent.getName())) {
      return "on each message";
    }
  }
  return undefined;
}

function httpRef(e: IrEdge): CallRef {
  const verb = e.attrs?.method as string | undefined;
  const path = e.attrs?.path as string | undefined;
  return {
    kind: "http_calls", target: e.target, name: [verb, path].filter(Boolean).join(" "),
    ...(verb ? { httpMethod: verb } : {}), ...(path ? { path } : {}),
  };
}

const SQL_METHODS = new Set(["query", "execute", "exec", "run", "all", "get", "prepare", "many", "one", "none", "any",
  "oneOrNone", "manyOrNone", "raw", "unsafe", "queryRaw", "executeRaw"]);
const REDIS_CLIENT = /new\s+(Redis|IORedis|Cluster)\b|create(Client|Cluster)\(/;
const REDIS_WRITES = new Set(["set", "setex", "psetex", "setnx", "mset", "hset", "hmset", "hsetnx", "hdel", "hincrby", "sadd", "srem",
  "zadd", "zrem", "zincrby", "lpush", "rpush", "lpop", "rpop", "lset", "ltrim", "del", "unlink", "expire", "pexpire", "incr",
  "incrby", "decr", "decrby", "append", "getset", "xadd", "pfadd", "geoadd"]);
const REDIS_READS = new Set(["get", "mget", "getrange", "strlen", "hget", "hgetall", "hmget", "hkeys", "hvals", "hexists", "hlen",
  "smembers", "sismember", "scard", "zrange", "zrangebyscore", "zrevrange", "zscore", "zcard", "zrank", "lrange", "lindex",
  "llen", "exists", "ttl", "pttl", "keys", "scan", "xrange", "xread", "pfcount", "geopos"]);

function redisType(command: string): string {
  if (command.startsWith("h")) return "hash";
  if (command.startsWith("z")) return "sorted set";
  if (command.startsWith("s") && !command.startsWith("set") && command !== "scan" && command !== "strlen") return "set";
  if (/^[lr](push|pop|range|index|len|set|trim)/.test(command)) return "list";
  if (command.startsWith("x")) return "stream";
  return "string";
}

/** Is `receiver` a client created like `pattern` (or, when untraceable, named like `name`)? */
function isClient(receiver: Node, pattern: RegExp, name: RegExp): boolean {
  for (const d of declarations(receiver)) {
    const init = Node.isVariableDeclaration(d) || Node.isPropertyDeclaration(d) ? d.getInitializer()?.getText() ?? "" : "";
    if (pattern.test(init)) return true;
    if (init) return false; // initialised from something else
  }
  const last = receiver.getText().split(".").pop() ?? "";
  return name.test(last);
}

/** Buffer.from(x) -> x */
function unwrapBuffer(e: Node | undefined): Node | undefined {
  if (e && Node.isCallExpression(e) && /^Buffer\.from$/.test(e.getExpression().getText())) return e.getArguments()[0];
  return e;
}

/** Numeric or string constant as text: 9000, PORT (const PORT = 9000), "9000". */
function constNumber(e: Node | undefined): string | undefined {
  if (!e) return undefined;
  if (Node.isNumericLiteral(e)) return String(e.getLiteralValue());
  if (Node.isIdentifier(e)) {
    for (const d of declarations(e)) {
      if (Node.isVariableDeclaration(d)) {
        const v = constNumber(d.getInitializer());
        if (v) return v;
      }
    }
  }
  return constString(e as Expression);
}

function mergeColumns(table: IrNode, names: string[]) {
  if (table.attrs?.entity || table.attrs?.model) return; // declared by an ORM: keep its columns
  const cols = (table.attrs?.columns as { name: string }[] | undefined) ?? [];
  for (const n of names) if (n !== "*" && !cols.some((c) => c.name === n)) cols.push({ name: n });
  setAttr(table, "columns", cols);
}

function sameModule(a: string, b: string): boolean {
  const strip = (p: string) => p.replace(/\.(ts|tsx|js|mjs|cjs|jsx)$/, "").replace(/(^|\/)dist\//, "$1src/");
  return strip(a) === strip(b) || strip(b).endsWith("/" + strip(a).replace(/^\.\//, ""));
}

/** First paragraph of a JSDoc comment (on the declaration, or the `const f = () => ...` holding it). */
function docOf(n: Node): string | undefined {
  const holder = Node.isArrowFunction(n) || Node.isFunctionExpression(n) ? n.getFirstAncestorByKind(SyntaxKind.VariableStatement) : n;
  if (!holder || !Node.isJSDocable(holder)) return undefined;
  const jsdoc = holder.getJsDocs().at(-1);
  const text = jsdoc?.getDescription().trim().split(/\n\s*\n/)[0].replace(/\{@\w+\s+([^}]*)\}/g, "$1").replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > 400 ? text.slice(0, 397) + "..." : text;
}
