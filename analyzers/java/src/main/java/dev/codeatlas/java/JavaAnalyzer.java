package dev.codeatlas.java;

import com.github.javaparser.JavaParser;
import com.github.javaparser.ParseResult;
import com.github.javaparser.ParserConfiguration;
import com.github.javaparser.ast.CompilationUnit;
import com.github.javaparser.ast.ImportDeclaration;
import com.github.javaparser.ast.Node;
import com.github.javaparser.ast.NodeList;
import com.github.javaparser.ast.body.CallableDeclaration;
import com.github.javaparser.ast.body.ClassOrInterfaceDeclaration;
import com.github.javaparser.ast.body.ConstructorDeclaration;
import com.github.javaparser.ast.body.EnumDeclaration;
import com.github.javaparser.ast.body.FieldDeclaration;
import com.github.javaparser.ast.body.MethodDeclaration;
import com.github.javaparser.ast.body.Parameter;
import com.github.javaparser.ast.body.RecordDeclaration;
import com.github.javaparser.ast.body.TypeDeclaration;
import com.github.javaparser.ast.body.VariableDeclarator;
import com.github.javaparser.ast.expr.AnnotationExpr;
import com.github.javaparser.ast.expr.BinaryExpr;
import com.github.javaparser.ast.expr.ClassExpr;
import com.github.javaparser.ast.expr.Expression;
import com.github.javaparser.ast.expr.FieldAccessExpr;
import com.github.javaparser.ast.expr.LambdaExpr;
import com.github.javaparser.ast.expr.MethodCallExpr;
import com.github.javaparser.ast.expr.MethodReferenceExpr;
import com.github.javaparser.ast.expr.NameExpr;
import com.github.javaparser.ast.expr.ObjectCreationExpr;
import com.github.javaparser.ast.expr.StringLiteralExpr;
import com.github.javaparser.ast.expr.ThisExpr;
import com.github.javaparser.ast.expr.TypeExpr;
import com.github.javaparser.ast.type.ClassOrInterfaceType;
import com.github.javaparser.ast.type.Type;
import com.github.javaparser.resolution.types.ResolvedType;
import com.github.javaparser.symbolsolver.JavaSymbolSolver;
import com.github.javaparser.symbolsolver.resolution.typesolvers.CombinedTypeSolver;
import com.github.javaparser.symbolsolver.resolution.typesolvers.JavaParserTypeSolver;
import com.github.javaparser.symbolsolver.resolution.typesolvers.ReflectionTypeSolver;
import java.io.IOException;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.regex.Pattern;
import java.util.stream.Stream;

/**
 * Turns a Java repository into CodeAtlas IR: modules/services, packages, types, members,
 * the call graph, and framework facts (Spring MVC endpoints, Spring Data / JPA tables,
 * Kafka/RabbitMQ messaging, RestTemplate/WebClient/Feign HTTP calls). Plain Java code is
 * covered too: kafka-clients producers/consumers, JDBC (SQL text), Redis clients, Netty and
 * JDK HttpServer entry points, with names resolved through constants, config files and
 * constructor arguments (see {@link Values}), plus main / thread / scheduled entry points.
 */
final class JavaAnalyzer {

    static final String VERSION = "0.1.0";

    private static final Set<String> STEREOTYPES = Set.of("SpringBootApplication", "RestController", "Controller",
        "Service", "Component", "Repository", "Configuration", "Entity", "MappedSuperclass", "Embeddable", "FeignClient");
    private static final Set<String> SPRING_DATA_REPOS = Set.of("Repository", "CrudRepository", "ListCrudRepository",
        "PagingAndSortingRepository", "ListPagingAndSortingRepository", "JpaRepository", "MongoRepository",
        "ReactiveCrudRepository", "R2dbcRepository", "ElasticsearchRepository");
    private static final Map<String, String> MAPPINGS = Map.of("GetMapping", "GET", "PostMapping", "POST",
        "PutMapping", "PUT", "DeleteMapping", "DELETE", "PatchMapping", "PATCH");
    private static final Set<String> COLLECTIONS = Set.of("List", "Set", "Collection", "Iterable", "Map", "SortedSet",
        "ArrayList", "HashSet", "LinkedHashSet", "Optional");
    private static final Set<String> REST_TEMPLATE_METHODS = Set.of("getForObject", "getForEntity", "postForObject",
        "postForEntity", "postForLocation", "put", "patchForObject", "delete", "exchange", "headForHeaders");

    /** A parsed file and the module it belongs to. */
    private record Unit(CompilationUnit cu, ProjectLayout.Module module, String moduleId, String file, String pkg) {}

    private final Path root;
    private final Ir.Builder b = new Ir.Builder();
    private final List<Unit> units = new ArrayList<>();

    // registries filled during declaration
    private final Map<String, TypeDeclaration<?>> types = new LinkedHashMap<>(); // FQN -> decl
    private final Map<TypeDeclaration<?>, Unit> unitOf = new HashMap<>();
    private final Map<String, List<String>> fqnsBySimpleName = new HashMap<>();
    private final Map<String, String> moduleIds = new HashMap<>(); // module path -> node id
    private final Map<String, String> repoEntity = new HashMap<>(); // repository FQN -> entity FQN
    private final Map<String, String> entityTable = new HashMap<>(); // entity FQN -> table node id
    /** Lambdas that run as their own unit of work (HTTP handlers, thread/executor/scheduler tasks) -> node id. */
    private final Map<LambdaExpr, String> taskLambdas = new IdentityHashMap<>();
    /** What each call / constructor expression resolved to, for control-flow steps. */
    private final Map<Node, Map<String, Object>> callInfo = new IdentityHashMap<>();
    /** In-repo method/constructor id each call expression resolved to. */
    private final Map<Node, String> callTarget = new IdentityHashMap<>();
    /** Calls and constructor invocations per in-repo callee id, for following arguments. */
    private final Map<String, List<Node>> callSites = new HashMap<>();
    private final Map<String, CallableDeclaration<?>> callables = new HashMap<>(); // method id -> decl
    private final Map<CompilationUnit, Unit> unitByCu = new IdentityHashMap<>();

    private final Values.Context valueContext = new Values.Context() {
        @Override
        public List<Node> callSitesOf(CallableDeclaration<?> c) {
            String id = methodId(c);
            return id == null ? List.of() : callSites.getOrDefault(id, List.of());
        }

        @Override
        public Map<String, String> config(Node n) {
            Unit u = unitFor(n);
            return u == null ? Map.of() : u.module().config();
        }

        @Override
        public CallableDeclaration<?> target(Node call) {
            String id = callTarget.get(call);
            return id == null ? null : callables.get(id);
        }

        @Override
        public List<Expression> recordComponent(MethodCallExpr call) {
            if (call.getArguments().isNonEmpty() || call.getScope().isEmpty()) {
                return List.of();
            }
            Unit u = unitFor(call);
            String fqn = u == null ? null : receiverType(call, u);
            if (fqn == null || !(types.get(fqn) instanceof RecordDeclaration r)) {
                return List.of();
            }
            int index = -1;
            for (int i = 0; i < r.getParameters().size(); i++) {
                if (r.getParameter(i).getNameAsString().equals(call.getNameAsString())) {
                    index = i;
                }
            }
            if (index < 0) {
                return List.of();
            }
            List<Expression> out = new ArrayList<>();
            for (ObjectCreationExpr create : recordCreations.computeIfAbsent(fqn, k -> creationsOf(k))) {
                if (create.getArguments().size() == r.getParameters().size()) {
                    out.add(create.getArgument(index));
                }
            }
            return out;
        }
    };

    /** Every `new R(...)` per in-repo record type, for following a record's accessors. */
    private final Map<String, List<ObjectCreationExpr>> recordCreations = new HashMap<>();

    private List<ObjectCreationExpr> creationsOf(String fqn) {
        String simple = Ast.simpleName(fqn);
        List<ObjectCreationExpr> out = new ArrayList<>();
        for (Unit u : units) {
            for (ObjectCreationExpr c : u.cu().findAll(ObjectCreationExpr.class)) {
                if (c.getType().getNameAsString().equals(simple) && fqn.equals(resolveType(c.getType(), u))) {
                    out.add(c);
                }
            }
        }
        return out;
    }

    private int parseFailures;

    JavaAnalyzer(Path root) {
        this.root = root;
    }

    Ir.Document run(Ir.Source source) throws IOException {
        List<ProjectLayout.Module> modules = ProjectLayout.discover(root);
        JavaParser parser = parser(modules);
        for (ProjectLayout.Module m : modules) {
            parseModule(parser, m);
        }
        declareModules(modules);
        for (Unit u : units) {
            for (TypeDeclaration<?> td : u.cu().getTypes()) {
                declareType(td, u, packageNode(u));
            }
        }
        // framework facts that later passes depend on
        types.forEach((fqn, td) -> detectRepository(fqn, td));
        types.forEach((fqn, td) -> declareEntityTable(fqn, td));

        for (Unit u : units) {
            relatePackages(u);
        }
        types.forEach((fqn, td) -> {
            relateTypes(fqn, td);
            entityRelations(fqn, td);
            endpoints(fqn, td);
            feignClient(fqn, td);
            listeners(fqn, td);
        });
        for (Unit u : units) {
            taskLambdas(u);
        }
        for (Unit u : units) {
            calls(u);
        }
        // I/O after the whole call graph is known: values are traced back through callers
        for (Unit u : units) {
            io(u);
        }
        tcpClients(); // after io: every TCP server in the repo is known
        entryPoints();
        asyncStarts();
        configReads();
        types.forEach((fqn, td) -> {
            List<CallableDeclaration<?>> callables = new ArrayList<>(td.getConstructors());
            callables.addAll(td.getMethods());
            for (CallableDeclaration<?> c : callables) {
                List<Map<String, Object>> cf = ControlFlow.of(c, callInfo, taskLambdas.keySet());
                Ir.Node n = b.get(methodId(fqn, c));
                if (cf != null && !cf.isEmpty() && n != null) {
                    n.attrs.put("controlFlow", cf);
                }
                if (n != null && !n.attrs.containsKey("abstract")) {
                    List<Map<String, Object>> vars = Variables.of(c, taskLambdas.keySet());
                    if (!vars.isEmpty()) {
                        n.attrs.put("variables", vars);
                    }
                }
            }
        });
        taskLambdas.forEach((l, id) -> {
            List<Map<String, Object>> cf = ControlFlow.ofLambda(l, callInfo, taskLambdas.keySet());
            if (!cf.isEmpty()) {
                b.get(id).attrs.put("controlFlow", cf);
            }
            List<Map<String, Object>> vars = Variables.ofLambda(l, taskLambdas.keySet());
            if (!vars.isEmpty()) {
                b.get(id).attrs.put("variables", vars);
            }
        });
        System.err.printf("codeatlas-java: %d modules, %d files (%d unparseable), %d types%n",
            modules.size(), units.size(), parseFailures, types.size());
        return b.build(source);
    }

    // ---------------------------------------------------------------- parsing

    private JavaParser parser(List<ProjectLayout.Module> modules) {
        CombinedTypeSolver solver = new CombinedTypeSolver(new ReflectionTypeSolver(true));
        for (ProjectLayout.Module m : modules) {
            m.sourceRoots().forEach(r -> solver.add(new JavaParserTypeSolver(r)));
        }
        ParserConfiguration cfg = new ParserConfiguration()
            .setLanguageLevel(ParserConfiguration.LanguageLevel.JAVA_21)
            .setSymbolResolver(new JavaSymbolSolver(solver));
        return new JavaParser(cfg);
    }

    private void parseModule(JavaParser parser, ProjectLayout.Module m) throws IOException {
        for (Path sourceRoot : m.sourceRoots()) {
            List<Path> files;
            try (Stream<Path> s = Files.walk(sourceRoot)) {
                files = s.filter(p -> p.toString().endsWith(".java"))
                    .filter(p -> !skipped(p))
                    .sorted().toList();
            }
            for (Path f : files) {
                ParseResult<CompilationUnit> r = parser.parse(f);
                if (!r.isSuccessful() || r.getResult().isEmpty()) {
                    parseFailures++;
                    System.err.println("codeatlas-java: cannot parse " + root.relativize(f) + ": " + r.getProblems());
                    continue;
                }
                CompilationUnit cu = r.getResult().get();
                String pkg = cu.getPackageDeclaration().map(p -> p.getNameAsString()).orElse("");
                units.add(new Unit(cu, m, null, root.relativize(f).toString().replace('\\', '/'), pkg));
            }
        }
    }

    private boolean skipped(Path p) {
        for (Path part : root.relativize(p)) {
            if (ProjectLayout.SKIP_DIRS.contains(part.toString())) {
                return true;
            }
        }
        return false;
    }

    // ----------------------------------------------------------- declarations

    /**
     * A program the repo builds: the class `java` starts, the build module that declares it
     * (launch = that declaration; null when found from the code alone) and the module whose
     * sources hold the class.
     */
    private record App(String mainClass, TypeDeclaration<?> type, ProjectLayout.Module declaredBy,
                       ProjectLayout.Module code, Launches.Launch launch, String via) {}

    /** Methods a service node `runs` (its main), marked as main entry points. */
    private final Set<String> launched = new LinkedHashSet<>();

    /**
     * One node per module with sources, and one service per program the repo builds. Programs
     * are what a jar's Main-Class would start: the main classes the builds declare (see
     * {@link Launches}); for a module no build declares one for, its Spring Boot application,
     * else each class with a main the launcher accepts ({@link Mains}). A module running exactly
     * one program of its own is that service (svc:, holding the code). Otherwise the module
     * is a mod: node holding the code, and each program is its own svc: node with a `runs`
     * edge to its main; views credit the module's code to the programs whose main reaches it.
     */
    private void declareModules(List<ProjectLayout.Module> modules) {
        Map<String, TypeDeclaration<?>> declared = new HashMap<>();
        Map<TypeDeclaration<?>, ProjectLayout.Module> home = new IdentityHashMap<>();
        for (Unit u : units) {
            for (TypeDeclaration<?> td : u.cu().findAll(TypeDeclaration.class)) {
                td.getFullyQualifiedName().ifPresent(f -> {
                    declared.putIfAbsent(f, td);
                    home.put(td, u.module());
                });
            }
        }
        java.util.function.Function<ClassOrInterfaceType, TypeDeclaration<?>> supertype = t -> declaredType(t, declared);

        List<App> apps = new ArrayList<>();
        for (ProjectLayout.Module m : modules) {
            for (Launches.Launch l : m.launches()) {
                TypeDeclaration<?> td = declared.get(l.mainClass());
                ProjectLayout.Module code = td == null ? null : home.get(td);
                if (td == null || code == null) {
                    System.err.println("codeatlas-java: " + l.declaredIn() + " starts " + l.mainClass() + ", which is not in the sources");
                    continue;
                }
                apps.add(new App(l.mainClass(), td, m, code, l, l.via()));
            }
        }
        Set<ProjectLayout.Module> covered = new java.util.HashSet<>();
        apps.forEach(a -> covered.addAll(List.of(a.declaredBy(), a.code())));
        for (ProjectLayout.Module m : modules) {
            if (covered.contains(m) || m.sourceRoots().isEmpty()) {
                continue;
            }
            List<TypeDeclaration<?>> own = new ArrayList<>();
            for (Unit u : units) {
                if (u.module() != m) {
                    continue;
                }
                for (TypeDeclaration<?> td : u.cu().findAll(TypeDeclaration.class)) {
                    own.add(td);
                }
            }
            List<TypeDeclaration<?>> boot = own.stream().filter(td -> Ast.has(td, "SpringBootApplication")).toList();
            List<TypeDeclaration<?>> mains = !boot.isEmpty() ? boot
                : own.stream().filter(td -> td.getMethodsByName("main").stream().anyMatch(Mains::isMain)).toList();
            for (TypeDeclaration<?> td : mains) {
                apps.add(new App(td.getFullyQualifiedName().orElse(td.getNameAsString()), td, m, m, null,
                    boot.isEmpty() ? "main" : "spring-boot"));
            }
        }
        apps.sort(java.util.Comparator.comparing((App a) -> a.code().path()).thenComparing(App::mainClass));

        Set<String> ids = new java.util.HashSet<>();
        for (ProjectLayout.Module m : modules) {
            if (m.sourceRoots().isEmpty()) {
                continue; // packages other modules' code: only its programs get nodes
            }
            List<App> runs = apps.stream().filter(a -> a.code() == m).toList();
            boolean service = runs.size() == 1 && runs.get(0).declaredBy() == m;
            String id = service ? "svc:" + m.appName() : "mod:" + m.name();
            Ir.Node n = b.node(id, service ? "service" : "module", service ? m.appName() : m.name());
            n.language = "java";
            n.attrs.put("path", m.path());
            if (service) {
                n.otel.put("service.name", m.appName());
                describeApp(n, runs.get(0), supertype);
            }
            ids.add(id);
            moduleIds.put(m.path(), id);
        }
        for (ProjectLayout.Module m : modules) {
            List<App> runs = apps.stream().filter(a -> a.code() == m).toList();
            if (m.sourceRoots().isEmpty() || runs.size() == 1 && runs.get(0).declaredBy() == m) {
                continue;
            }
            for (App a : runs) {
                String name = appName(a, apps);
                String id = "svc:" + name;
                for (int i = 2; ids.contains(id); i++) {
                    id = "svc:" + name + "-" + Ast.snakeCase(Ast.simpleName(a.mainClass())).replace('_', '-') + (i > 2 ? "-" + i : "");
                }
                ids.add(id);
                name = id.substring("svc:".length());
                Ir.Node n = b.node(id, "service", name);
                n.language = "java";
                n.attrs.put("path", a.declaredBy().path());
                n.attrs.put("module", moduleIds.get(m.path()));
                n.otel.put("service.name", name);
                fileOf(a.type()).ifPresent(file -> n.location = Ast.loc(a.type(), file));
                describeApp(n, a, supertype);
            }
        }
        // re-bind units to their module node ids
        List<Unit> bound = units.stream()
            .map(u -> new Unit(u.cu(), u.module(), moduleIds.get(u.module().path()), u.file(), u.pkg())).toList();
        units.clear();
        units.addAll(bound);
        for (Unit u : units) {
            unitByCu.put(u.cu(), u);
        }
    }

    private Unit unitFor(Node n) {
        return n.findCompilationUnit().map(unitByCu::get).orElse(null);
    }

    private Optional<String> fileOf(TypeDeclaration<?> td) {
        return td.findCompilationUnit().flatMap(cu -> units.stream().filter(u -> u.cu() == cu).findFirst()).map(Unit::file);
    }

    /** attrs.mainClass / launch / declaredIn / jar on a program's service node, and its `runs` edge. */
    private void describeApp(Ir.Node n, App a, java.util.function.Function<ClassOrInterfaceType, TypeDeclaration<?>> supertype) {
        n.attrs.put("mainClass", a.mainClass());
        n.attrs.put("launch", a.via());
        if (a.launch() != null) {
            n.attrs.put("declaredIn", a.launch().declaredIn());
            if (a.launch().jar() != null) {
                n.attrs.put("jar", a.launch().jar());
            }
        }
        // the main `java` runs (maybe inherited); a Spring Boot class without one: the class
        MethodDeclaration main = Mains.find(a.type(), supertype);
        String target = main == null ? null : main.findAncestor(TypeDeclaration.class)
            .flatMap(td -> ((TypeDeclaration<?>) td).getFullyQualifiedName()).map(f -> methodId(f, main)).orElse(null);
        if (target != null) {
            launched.add(target);
        }
        b.edge(n.id, target != null ? target : typeId(a.mainClass()), "runs");
    }

    /**
     * A program's service name when its module runs several: the artifact name the build gives
     * it (shade's finalName, an appassembler program id), the module plus the attached jar's
     * classifier (livepnl-producer), a launcher module's own name, or the module plus the main
     * class without its Main / Application suffix (ledger-gateway for GatewayMain).
     */
    private static String appName(App a, List<App> apps) {
        Launches.Launch l = a.launch();
        if (l != null && l.name() != null) {
            return l.name();
        }
        if (l != null && l.classifier() != null) {
            return a.declaredBy().name() + "-" + l.classifier();
        }
        long declaredHere = apps.stream().filter(o -> o.declaredBy() == a.declaredBy()).count();
        if (a.declaredBy() != a.code() && declaredHere == 1) {
            return a.declaredBy().appName();
        }
        return a.declaredBy().name() + "-" + programName(a.mainClass());
    }

    /** "gateway" for com.acme.GatewayMain, "consumer" for consumer.Main, "order-sync" for OrderSyncApplication. */
    static String programName(String fqn) {
        String simple = Ast.simpleName(fqn);
        String stem = simple.replaceFirst("(Main|Application|App|Launcher)$", "");
        if (stem.isEmpty()) {
            int dot = fqn.lastIndexOf('.');
            String pkg = dot > 0 ? fqn.substring(0, dot) : "";
            stem = pkg.isEmpty() ? simple : pkg.substring(pkg.lastIndexOf('.') + 1);
        }
        return Ast.snakeCase(stem).replace('_', '-');
    }

    /** The in-repo declaration an extends / implements type names, from the written name, imports and package. */
    private static TypeDeclaration<?> declaredType(ClassOrInterfaceType t, Map<String, TypeDeclaration<?>> declared) {
        String written = t.getNameWithScope();
        if (declared.containsKey(written)) {
            return declared.get(written);
        }
        String simple = t.getNameAsString();
        CompilationUnit cu = t.findCompilationUnit().orElse(null);
        if (cu != null && !written.contains(".")) {
            for (ImportDeclaration imp : cu.getImports()) {
                if (imp.isStatic()) {
                    continue;
                }
                String fqn = imp.isAsterisk() ? imp.getNameAsString() + "." + simple : imp.getNameAsString();
                if ((imp.isAsterisk() || imp.getName().getIdentifier().equals(simple)) && declared.containsKey(fqn)) {
                    return declared.get(fqn);
                }
            }
            String pkg = cu.getPackageDeclaration().map(p -> p.getNameAsString() + ".").orElse("");
            if (declared.containsKey(pkg + simple)) {
                return declared.get(pkg + simple);
            }
        }
        List<TypeDeclaration<?>> bySimple = declared.values().stream().filter(td -> td.getNameAsString().equals(simple)).toList();
        return bySimple.size() == 1 ? bySimple.get(0) : null;
    }

    private String packageNode(Unit u) {
        if (u.pkg().isEmpty()) {
            return u.moduleId();
        }
        String id = "pkg:" + u.pkg();
        Ir.Node n = b.node(id, "package", u.pkg());
        n.language = "java";
        if (n.parent == null) {
            n.parent = u.moduleId();
        }
        return id;
    }

    private static String typeId(String fqn) {
        return "class:" + fqn;
    }

    private void declareType(TypeDeclaration<?> td, Unit u, String parentId) {
        String fqn = td.getFullyQualifiedName().orElse(td.getNameAsString());
        String kind = "class";
        if (td instanceof ClassOrInterfaceDeclaration c && c.isInterface() || td.isAnnotationDeclaration()) {
            kind = "interface";
        } else if (td instanceof EnumDeclaration) {
            kind = "enum";
        }
        Ir.Node n = b.node(typeId(fqn), kind, td.getNameAsString());
        n.qualifiedName = fqn;
        n.parent = parentId;
        n.language = "java";
        n.location = Ast.loc(td, u.file());
        n.attrs.put("visibility", Ast.visibility(td));
        List<String> annotations = Ast.annotationNames(td);
        if (!annotations.isEmpty()) {
            n.attrs.put("annotations", annotations);
        }
        annotations.stream().filter(STEREOTYPES::contains).findFirst().ifPresent(s -> n.attrs.put("stereotype", s));
        if (td instanceof ClassOrInterfaceDeclaration c && c.isAbstract()) {
            n.attrs.put("abstract", true);
        }
        if (td instanceof RecordDeclaration) {
            n.attrs.put("record", true);
        }
        Ast.doc(td).ifPresent(d -> n.attrs.put("doc", d));
        if (td instanceof EnumDeclaration e) {
            n.attrs.put("values", e.getEntries().stream().map(x -> x.getNameAsString()).toList());
        }

        types.put(fqn, td);
        unitOf.put(td, u);
        fqnsBySimpleName.computeIfAbsent(td.getNameAsString(), k -> new ArrayList<>()).add(fqn);

        for (FieldDeclaration f : td.getFields()) {
            for (VariableDeclarator v : f.getVariables()) {
                Ir.Node fn = b.node("field:" + fqn + "#" + v.getNameAsString(), "field", v.getNameAsString());
                fn.parent = n.id;
                fn.language = "java";
                fn.location = Ast.loc(f, u.file());
                fn.attrs.put("type", v.getTypeAsString());
                fn.attrs.put("visibility", Ast.visibility(f));
                if (f.isStatic()) {
                    fn.attrs.put("static", true);
                }
                if (f.isFinal()) {
                    fn.attrs.put("final", true);
                }
            }
        }
        if (td instanceof RecordDeclaration r) {
            for (Parameter p : r.getParameters()) {
                Ir.Node fn = b.node("field:" + fqn + "#" + p.getNameAsString(), "field", p.getNameAsString());
                fn.parent = n.id;
                fn.language = "java";
                fn.location = Ast.loc(p, u.file());
                fn.attrs.put("type", p.getTypeAsString());
                fn.attrs.put("visibility", "private");
            }
        }
        List<CallableDeclaration<?>> callables = new ArrayList<>(td.getConstructors());
        callables.addAll(td.getMethods());
        for (CallableDeclaration<?> c : callables) {
            declareCallable(c, fqn, n.id, u);
        }
        for (var member : td.getMembers()) {
            if (member instanceof TypeDeclaration<?> nested) {
                declareType(nested, u, n.id);
            }
        }
    }

    private void declareCallable(CallableDeclaration<?> c, String ownerFqn, String ownerId, Unit u) {
        String name = Ast.callableName(c);
        Ir.Node m = b.node(methodId(ownerFqn, c), "method", name);
        callables.put(m.id, c);
        m.parent = ownerId;
        m.language = "java";
        m.location = Ast.loc(c, u.file());
        m.attrs.put("visibility", Ast.visibility(c));
        if (c.isStatic()) {
            m.attrs.put("static", true);
        }
        if (c.isAbstract() || c instanceof MethodDeclaration md && md.getBody().isEmpty()) {
            m.attrs.put("abstract", true);
        }
        if (c instanceof ConstructorDeclaration) {
            m.attrs.put("constructor", true);
        } else if (c instanceof MethodDeclaration md) {
            m.attrs.put("returnType", md.getTypeAsString());
        }
        List<Map<String, String>> params = new ArrayList<>();
        for (Parameter p : c.getParameters()) {
            params.add(Map.of("name", p.getNameAsString(), "type", p.getTypeAsString() + (p.isVarArgs() ? "..." : "")));
        }
        if (!params.isEmpty()) {
            m.attrs.put("params", params);
        }
        List<String> annotations = Ast.annotationNames(c);
        if (!annotations.isEmpty()) {
            m.attrs.put("annotations", annotations);
        }
        Ast.doc(c).ifPresent(d -> m.attrs.put("doc", d));
        // What the OpenTelemetry Java agent reports for this code (correlation in P3).
        m.otel.put("code.namespace", ownerFqn);
        m.otel.put("code.function", name);
    }

    static String methodId(String ownerFqn, CallableDeclaration<?> c) {
        StringBuilder sb = new StringBuilder("method:").append(ownerFqn).append('#').append(Ast.callableName(c)).append('(');
        for (int i = 0; i < c.getParameters().size(); i++) {
            Parameter p = c.getParameters().get(i);
            if (i > 0) {
                sb.append(',');
            }
            sb.append(Ast.erase(p.getType())).append(p.isVarArgs() ? "..." : "");
        }
        return sb.append(')').toString();
    }

    private String methodId(CallableDeclaration<?> c) {
        return c.findAncestor(TypeDeclaration.class)
            .flatMap(td -> ((TypeDeclaration<?>) td).getFullyQualifiedName())
            .map(fqn -> methodId(fqn, c))
            .orElse(null);
    }

    // ------------------------------------------------------- type resolution

    /**
     * FQN of a type reference. Tries imports, the current package and unique simple names
     * first (fast, works without the dependency classpath), then the symbol solver.
     * Returns null when the type is not declared in this repo and cannot be resolved.
     */
    private String resolveType(ClassOrInterfaceType t, Unit u) {
        String written = t.getNameWithScope();
        if (types.containsKey(written)) {
            return written;
        }
        String simple = t.getNameAsString();
        if (!written.contains(".")) {
            for (ImportDeclaration imp : u.cu().getImports()) {
                if (!imp.isStatic() && !imp.isAsterisk() && imp.getName().getIdentifier().equals(simple)) {
                    return imp.getNameAsString();
                }
            }
            String samePkg = u.pkg().isEmpty() ? simple : u.pkg() + "." + simple;
            if (types.containsKey(samePkg)) {
                return samePkg;
            }
            // nested type of an enclosing class
            for (Node p = t.getParentNode().orElse(null); p != null; p = p.getParentNode().orElse(null)) {
                if (p instanceof TypeDeclaration<?> td) {
                    String nested = td.getFullyQualifiedName().orElse("") + "." + simple;
                    if (types.containsKey(nested)) {
                        return nested;
                    }
                }
            }
            for (ImportDeclaration imp : u.cu().getImports()) {
                if (imp.isAsterisk() && !imp.isStatic() && types.containsKey(imp.getNameAsString() + "." + simple)) {
                    return imp.getNameAsString() + "." + simple;
                }
            }
            List<String> candidates = fqnsBySimpleName.getOrDefault(simple, List.of());
            if (candidates.size() == 1) {
                return candidates.get(0);
            }
        }
        try {
            return t.resolve().asReferenceType().getQualifiedName();
        } catch (RuntimeException | StackOverflowError e) {
            return null;
        }
    }

    private String resolveType(Type t, Unit u) {
        return t instanceof ClassOrInterfaceType c ? resolveType(c, u) : null;
    }

    /** In-repo types mentioned anywhere in t, including generic arguments and array elements. */
    private Set<String> referencedTypes(Type t, Unit u) {
        Set<String> out = new LinkedHashSet<>();
        if (t instanceof ClassOrInterfaceType c && types.containsKey(resolveType(c, u))) {
            out.add(resolveType(c, u));
        }
        for (ClassOrInterfaceType c : t.findAll(ClassOrInterfaceType.class)) {
            String fqn = resolveType(c, u);
            if (fqn != null && types.containsKey(fqn)) {
                out.add(fqn);
            }
        }
        return out;
    }

    /**
     * Declared type of a call's receiver (`orders.save(x)` -> OrderRepository): the symbol
     * solver if it can, otherwise the declaration of the local/parameter/field by name.
     * Returns the FQN when known, else the type as written (erased).
     */
    private String receiverType(MethodCallExpr call, Unit u) {
        Optional<Expression> scope = call.getScope();
        if (scope.isEmpty()) {
            return null;
        }
        String name = null;
        if (scope.get() instanceof NameExpr n) {
            name = n.getNameAsString();
        } else if (scope.get() instanceof FieldAccessExpr f && f.getScope() instanceof ThisExpr) {
            name = f.getNameAsString();
        }
        if (name != null) {
            Type declared = declaredType(call, name);
            if (declared != null) {
                String fqn = resolveType(declared, u);
                return fqn != null ? fqn : Ast.erase(declared);
            }
        }
        try {
            var t = scope.get().calculateResolvedType();
            return t.isReferenceType() ? t.asReferenceType().getQualifiedName() : null;
        } catch (RuntimeException | StackOverflowError e) {
            return Ast.erase(scope.get().toString());
        }
    }

    private static Type declaredType(Node at, String name) {
        CallableDeclaration<?> c = Ast.enclosingCallable(at);
        if (c != null) {
            for (Parameter p : c.getParameters()) {
                if (p.getNameAsString().equals(name)) {
                    return p.getType();
                }
            }
            for (VariableDeclarator v : c.findAll(VariableDeclarator.class)) {
                if (v.getNameAsString().equals(name) && !v.getType().isVarType()) {
                    return v.getType();
                }
            }
        }
        VariableDeclarator f = Ast.fieldInScope(at, name);
        return f == null ? null : f.getType();
    }

    // ------------------------------------------------------------- relations

    private void relatePackages(Unit u) {
        if (u.pkg().isEmpty()) {
            return;
        }
        Map<String, Integer> counts = new LinkedHashMap<>();
        for (ImportDeclaration imp : u.cu().getImports()) {
            if (imp.isStatic() || imp.isAsterisk()) {
                continue;
            }
            TypeDeclaration<?> target = types.get(imp.getNameAsString());
            if (target == null) {
                continue;
            }
            String targetPkg = unitOf.get(target).pkg();
            if (!targetPkg.equals(u.pkg()) && !targetPkg.isEmpty()) {
                counts.merge(targetPkg, 1, Integer::sum);
            }
        }
        counts.forEach((pkg, n) -> {
            Ir.Edge e = b.edge("pkg:" + u.pkg(), "pkg:" + pkg, "depends_on");
            e.attrs.merge("imports", n, (a, c) -> (Integer) a + (Integer) c);
        });
    }

    private void relateTypes(String fqn, TypeDeclaration<?> td) {
        Unit u = unitOf.get(td);
        String id = typeId(fqn);
        List<ClassOrInterfaceType> supers = new ArrayList<>();
        List<ClassOrInterfaceType> impls = new ArrayList<>();
        if (td instanceof ClassOrInterfaceDeclaration c) {
            (c.isInterface() ? impls : supers).addAll(c.getExtendedTypes());
            impls.addAll(c.getImplementedTypes());
            if (c.isInterface()) { // interface extends interface is "extends" in UML
                supers.addAll(impls);
                impls.clear();
            }
        } else if (td instanceof EnumDeclaration e) {
            impls.addAll(e.getImplementedTypes());
        } else if (td instanceof RecordDeclaration r) {
            impls.addAll(r.getImplementedTypes());
        }
        relateSupers(id, supers, "extends", u);
        relateSupers(id, impls, "implements", u);

        for (FieldDeclaration f : td.getFields()) {
            for (VariableDeclarator v : f.getVariables()) {
                boolean many = v.getType().isArrayType()
                    || COLLECTIONS.contains(Ast.simpleName(Ast.erase(v.getType())));
                for (String target : referencedTypes(v.getType(), u)) {
                    if (target.equals(fqn)) {
                        continue;
                    }
                    Ir.Edge e = b.edge(id, typeId(target), "references");
                    addToList(e.attrs, "fields", v.getNameAsString());
                    if (many) {
                        e.attrs.put("many", true);
                    }
                }
            }
        }
    }

    private void relateSupers(String id, List<ClassOrInterfaceType> supers, String kind, Unit u) {
        for (ClassOrInterfaceType s : supers) {
            String fqn = resolveType(s, u);
            if (fqn != null && types.containsKey(fqn)) {
                b.edge(id, typeId(fqn), kind);
            } else {
                // library supertypes are kept as labels for the class diagram
                addToList(b.get(id).attrs, kind, s.asString());
            }
        }
    }

    @SuppressWarnings("unchecked")
    private static void addToList(Map<String, Object> attrs, String key, Object value) {
        List<Object> list = (List<Object>) attrs.computeIfAbsent(key, k -> new ArrayList<>());
        if (!list.contains(value)) {
            list.add(value);
        }
    }

    // ---------------------------------------------------------- persistence

    private void detectRepository(String fqn, TypeDeclaration<?> td) {
        if (!(td instanceof ClassOrInterfaceDeclaration c) || !c.isInterface()) {
            return;
        }
        Unit u = unitOf.get(td);
        for (ClassOrInterfaceType ext : c.getExtendedTypes()) {
            if (SPRING_DATA_REPOS.contains(ext.getNameAsString()) && ext.getTypeArguments().isPresent()
                && !ext.getTypeArguments().get().isEmpty()) {
                String entity = resolveType(ext.getTypeArguments().get().get(0), u);
                if (entity != null) {
                    repoEntity.put(fqn, entity);
                    b.get(typeId(fqn)).attrs.put("stereotype", "Repository");
                    b.get(typeId(fqn)).attrs.put("entity", entity);
                }
            }
        }
    }

    private String databaseNode(Unit u) {
        ProjectLayout.Module m = u.module();
        String name = m.dbName() != null ? m.dbName() : m.appName() + "-db";
        String id = "db:" + (m.dbHost() != null ? m.dbHost() + "/" : m.appName() + "/") + name;
        if (!b.has(id)) {
            Ir.Node db = b.node(id, "database", name);
            db.otel.put("db.system", m.dbSystem() != null ? m.dbSystem() : "unknown");
            db.otel.put("db.namespace", name);
            if (m.dbHost() != null) {
                db.attrs.put("host", m.dbHost());
                db.otel.put("server.address", m.dbHost());
            }
            db.attrs.put("usedBy", u.moduleId());
        }
        return id;
    }

    /** Table `name` in database dbId (created on first use). */
    private String tableNode(String dbId, String name) {
        String id = "table:" + dbId.substring(3) + "." + name;
        if (!b.has(id)) {
            Ir.Node t = b.node(id, "table", name);
            t.parent = dbId;
            t.otel.put("db.collection.name", name);
            t.otel.put("db.sql.table", name);
        }
        return id;
    }

    private void declareEntityTable(String fqn, TypeDeclaration<?> td) {
        if (!Ast.has(td, "Entity")) {
            return;
        }
        Unit u = unitOf.get(td);
        String table = Ast.annotation(td, "Table").flatMap(a -> Ast.attrString(a, "name"))
            .orElse(Ast.snakeCase(td.getNameAsString()));
        String id = tableNode(databaseNode(u), table);
        Ir.Node t = b.get(id);
        t.location = Ast.loc(td, u.file());
        t.attrs.put("entity", fqn);
        t.attrs.put("columns", columns(td, u));
        entityTable.put(fqn, id);
        b.edge(typeId(fqn), id, "references").attrs.put("via", "jpa");
    }

    /** Columns of an entity, including those inherited from @MappedSuperclass ancestors. */
    private List<Map<String, Object>> columns(TypeDeclaration<?> td, Unit u) {
        List<Map<String, Object>> cols = new ArrayList<>();
        if (td instanceof ClassOrInterfaceDeclaration c) {
            for (ClassOrInterfaceType s : c.getExtendedTypes()) {
                TypeDeclaration<?> sup = types.get(resolveType(s, u));
                if (sup != null && Ast.has(sup, "MappedSuperclass")) {
                    cols.addAll(columns(sup, unitOf.get(sup)));
                }
            }
        }
        for (FieldDeclaration f : td.getFields()) {
            if (f.isStatic() || f.isTransient() || Ast.has(f, "Transient") || Ast.has(f, "OneToMany")
                || (Ast.has(f, "ManyToMany") || Ast.has(f, "OneToOne")) && mappedBy(f)) {
                continue;
            }
            for (VariableDeclarator v : f.getVariables()) {
                Map<String, Object> col = new LinkedHashMap<>();
                boolean fk = Ast.has(f, "ManyToOne") || Ast.has(f, "OneToOne");
                if (Ast.has(f, "ManyToMany") || Ast.has(f, "ElementCollection") || Ast.has(f, "Embedded")) {
                    continue; // stored in another table / inlined; shown as relations instead
                }
                String name = fk
                    ? Ast.annotation(f, "JoinColumn").flatMap(a -> Ast.attrString(a, "name"))
                        .orElse(Ast.snakeCase(v.getNameAsString()) + "_id")
                    : Ast.annotation(f, "Column").flatMap(a -> Ast.attrString(a, "name"))
                        .orElse(Ast.snakeCase(v.getNameAsString()));
                col.put("name", name);
                col.put("type", fk ? "fk" : v.getTypeAsString());
                if (Ast.has(f, "Id") || Ast.has(f, "EmbeddedId")) {
                    col.put("primaryKey", true);
                }
                if (fk) {
                    col.put("foreignKey", true);
                }
                Optional<AnnotationExpr> column = Ast.annotation(f, "Column").or(() -> Ast.annotation(f, "JoinColumn"));
                column.ifPresent(a -> {
                    if (Ast.attr(a, "nullable").stream().anyMatch(e -> e.toString().equals("false"))) {
                        col.put("nullable", false);
                    }
                    if (Ast.attr(a, "unique").stream().anyMatch(e -> e.toString().equals("true"))) {
                        col.put("unique", true);
                    }
                });
                Ast.annotation(f, "ManyToOne").or(() -> Ast.annotation(f, "OneToOne")).ifPresent(a -> {
                    if (Ast.attr(a, "optional").stream().anyMatch(e -> e.toString().equals("false"))) {
                        col.put("nullable", false);
                    }
                });
                cols.add(col);
            }
        }
        return cols;
    }

    private static boolean mappedBy(FieldDeclaration f) {
        return Ast.annotation(f, "ManyToMany").or(() -> Ast.annotation(f, "OneToOne"))
            .map(a -> !Ast.attr(a, "mappedBy").isEmpty()).orElse(false);
    }

    private void entityRelations(String fqn, TypeDeclaration<?> td) {
        String from = entityTable.get(fqn);
        if (from == null) {
            return;
        }
        Unit u = unitOf.get(td);
        for (FieldDeclaration f : td.getFields()) {
            String cardinality = Ast.has(f, "ManyToOne") ? "many-to-one"
                : Ast.has(f, "OneToOne") && !mappedBy(f) ? "one-to-one"
                : Ast.has(f, "ManyToMany") && !mappedBy(f) ? "many-to-many" : null;
            if (cardinality == null) {
                continue;
            }
            for (VariableDeclarator v : f.getVariables()) {
                for (String target : referencedTypes(v.getType(), u)) {
                    String to = entityTable.get(target);
                    if (to == null) {
                        continue;
                    }
                    Ir.Edge e = b.edge(from, to, "references", Ast.line(f, u.file()));
                    e.attrs.put("cardinality", cardinality);
                    if (cardinality.equals("many-to-many")) {
                        e.attrs.put("joinTable", Ast.annotation(f, "JoinTable").flatMap(a -> Ast.attrString(a, "name"))
                            .orElse(b.get(from).name + "_" + b.get(to).name));
                    } else {
                        e.attrs.put("column", Ast.annotation(f, "JoinColumn").flatMap(a -> Ast.attrString(a, "name"))
                            .orElse(Ast.snakeCase(v.getNameAsString()) + "_id"));
                    }
                }
            }
        }
    }

    private static String dataOperation(String method) {
        String m = method.toLowerCase(Locale.ROOT);
        for (String w : List.of("save", "delete", "remove", "insert", "update", "persist", "merge", "flush")) {
            if (m.startsWith(w)) {
                return "writes";
            }
        }
        return "reads";
    }

    // ------------------------------------------------------------- endpoints

    private void endpoints(String fqn, TypeDeclaration<?> td) {
        if (!(Ast.has(td, "RestController") || Ast.has(td, "Controller"))) {
            return;
        }
        Unit u = unitOf.get(td);
        List<String> prefixes = Ast.annotation(td, "RequestMapping")
            .map(a -> Ast.attrStrings(a, "value", "path")).filter(l -> !l.isEmpty()).orElse(List.of(""));
        String service = b.get(u.moduleId()).name;
        for (MethodDeclaration m : td.getMethods()) {
            for (AnnotationExpr a : m.getAnnotations()) {
                String ann = a.getName().getIdentifier();
                List<String> verbs;
                if (MAPPINGS.containsKey(ann)) {
                    verbs = List.of(MAPPINGS.get(ann));
                } else if (ann.equals("RequestMapping")) {
                    verbs = Ast.attrNames(a, "method");
                    if (verbs.isEmpty()) {
                        verbs = List.of("ANY");
                    }
                } else {
                    continue;
                }
                List<String> paths = Ast.attrStrings(a, "value", "path");
                if (paths.isEmpty()) {
                    paths = List.of("");
                }
                for (String prefix : prefixes) {
                    for (String path : paths) {
                        for (String verb : verbs) {
                            Ir.Node ep = declareEndpoint(service, u, verb, route(prefix, path), methodId(fqn, m), Ast.loc(m, u.file()));
                            describeHandler(ep, m, u);
                        }
                    }
                }
            }
        }
    }

    private Ir.Node declareEndpoint(String service, Unit u, String verb, String route, String handler, Ir.Location at) {
        return declareEndpoint(service, u, verb, route, handler, at, "spring-mvc");
    }

    private Ir.Node declareEndpoint(String service, Unit u, String verb, String route, String handler, Ir.Location at,
                                    String framework) {
        String name = verb + " " + route;
        Ir.Node e = b.node("endpoint:" + service + ":" + name, "endpoint", name);
        e.parent = u.moduleId();
        e.location = at;
        e.attrs.put("method", verb);
        e.attrs.put("route", route);
        e.attrs.put("framework", framework);
        if (!verb.equals("ANY")) {
            e.otel.put("http.request.method", verb);
        }
        e.otel.put("http.route", route);
        if (handler != null) {
            b.edge(e.id, handler, "handles");
        }
        return e;
    }

    private static final Map<String, String> PARAM_SOURCES = Map.of(
        "PathVariable", "path", "RequestParam", "query", "RequestHeader", "header", "CookieValue", "cookie");

    /** Request body type, path/query/header inputs and response type of a handler method. */
    private void describeHandler(Ir.Node e, MethodDeclaration m, Unit u) {
        List<Map<String, Object>> inputs = new ArrayList<>();
        for (Parameter p : m.getParameters()) {
            if (Ast.has(p, "RequestBody")) {
                Map<String, Object> body = typeInfo(p.getType(), u);
                if (body != null) {
                    e.attrs.put("request", body);
                }
                continue;
            }
            PARAM_SOURCES.forEach((ann, in) -> {
                if (Ast.has(p, ann)) {
                    inputs.add(Map.of("name", p.getNameAsString(), "type", p.getTypeAsString(), "in", in));
                }
            });
        }
        if (!inputs.isEmpty()) {
            e.attrs.put("inputs", inputs);
        }
        Map<String, Object> response = typeInfo(m.getType(), u);
        if (response != null) {
            e.attrs.put("response", response);
        }
    }

    /** Joins Spring path segments; strips regex constraints: /{id:\d+} -> /{id}. */
    static String route(String prefix, String path) {
        String r = ("/" + prefix + "/" + path).replaceAll("/+", "/").replaceAll("\\{([^}:]+):[^}]*}", "{$1}");
        if (r.length() > 1 && r.endsWith("/")) {
            r = r.substring(0, r.length() - 1);
        }
        return r;
    }

    // ------------------------------------------------------------ messaging

    private void listeners(String fqn, TypeDeclaration<?> td) {
        Unit u = unitOf.get(td);
        for (MethodDeclaration m : td.getMethods()) {
            String id = methodId(fqn, m);
            Map<String, Object> payload = listenerPayload(m, u);
            Ast.annotation(m, "KafkaListener").ifPresent(a ->
                Ast.attrStrings(a, "topics", "value").forEach(t ->
                    addType(b.edge(id, topicNode(t, "kafka"), "consumes").attrs, "payloads", payload)));
            Ast.annotation(m, "RabbitListener").ifPresent(a ->
                Ast.attrStrings(a, "queues", "value").forEach(q ->
                    addType(b.edge(id, queueNode(q, "rabbitmq"), "consumes").attrs, "payloads", payload)));
            Ast.annotation(m, "JmsListener").ifPresent(a ->
                Ast.attrStrings(a, "destination").forEach(q ->
                    addType(b.edge(id, queueNode(q, "jms"), "consumes").attrs, "payloads", payload)));
        }
    }

    private static final Set<String> LISTENER_METADATA = Set.of("Acknowledgment", "Channel", "MessageHeaders", "Consumer");

    /** The message parameter of a listener: @Payload, else the first non-header, non-metadata parameter. */
    private Map<String, Object> listenerPayload(MethodDeclaration m, Unit u) {
        Parameter chosen = m.getParameters().stream().filter(p -> Ast.has(p, "Payload")).findFirst()
            .orElse(m.getParameters().stream()
                .filter(p -> !Ast.has(p, "Header") && !Ast.has(p, "Headers"))
                .filter(p -> !LISTENER_METADATA.contains(Ast.simpleName(p.getTypeAsString())))
                .findFirst().orElse(null));
        return chosen == null ? null : typeInfo(chosen.getType(), u);
    }

    private String topicNode(String name, String system) {
        Ir.Node t = b.node("topic:" + name, "topic", name);
        t.otel.put("messaging.destination.name", name);
        t.otel.put("messaging.system", system);
        return t.id;
    }

    private String queueNode(String name, String system) {
        Ir.Node q = b.node("queue:" + name, "queue", name);
        q.otel.put("messaging.destination.name", name);
        q.otel.put("messaging.system", system);
        return q.id;
    }

    // ------------------------------------------------------------------ http

    private String externalNode(String url) {
        String host = host(url);
        if (host == null) {
            return null;
        }
        Ir.Node ext = b.node("ext:" + host, "external", host);
        ext.otel.put("server.address", host);
        return ext.id;
    }

    static String host(String url) {
        if (url == null) {
            return null;
        }
        if (!url.contains("://")) {
            return url.matches("[A-Za-z0-9][A-Za-z0-9.-]*") ? url : null; // bare service name (Feign)
        }
        try {
            String h = URI.create(url.replaceAll("\\$\\{[^}]*}", "x").replaceAll("\\{[^}]*}", "x")).getHost();
            return h == null || h.isEmpty() ? null : h;
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    static String path(String url) {
        try {
            String p = URI.create(url.replaceAll("\\{[^}]*}", "x")).getPath();
            return p == null || p.isEmpty() ? "/" : p;
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    private void feignClient(String fqn, TypeDeclaration<?> td) {
        Optional<AnnotationExpr> feign = Ast.annotation(td, "FeignClient");
        if (feign.isEmpty()) {
            return;
        }
        String target = Ast.attrString(feign.get(), "url")
            .or(() -> Ast.attrString(feign.get(), "name", "value")).orElse(null);
        String ext = externalNode(target);
        if (ext == null) {
            return;
        }
        List<String> prefixes = Ast.annotation(td, "RequestMapping")
            .map(a -> Ast.attrStrings(a, "value", "path")).filter(l -> !l.isEmpty()).orElse(List.of(""));
        for (MethodDeclaration m : td.getMethods()) {
            for (AnnotationExpr a : m.getAnnotations()) {
                String verb = MAPPINGS.get(a.getName().getIdentifier());
                if (verb == null) {
                    continue;
                }
                String p = Ast.attrString(a, "value", "path").orElse("");
                Unit u = unitOf.get(td);
                Ir.Edge e = b.edge(methodId(fqn, m), ext, "http_calls", Ast.line(m, u.file()), List.of());
                e.attrs.put("method", verb);
                e.attrs.put("path", route(prefixes.get(0), p));
                e.attrs.put("client", "feign");
                Parameter body = m.getParameters().stream().filter(x -> Ast.has(x, "RequestBody")).findFirst().orElse(null);
                if (body != null) {
                    addType(e.attrs, "payloads", typeInfo(body.getType(), u));
                } else if (m.getParameters().isNonEmpty()) {
                    addType(e.attrs, "payloads", paramsInfo(m.getParameters()));
                }
                addType(e.attrs, "responses", typeInfo(m.getType(), u));
            }
        }
    }

    // ----------------------------------------------------------------- calls

    private void calls(Unit u) {
        for (MethodCallExpr call : u.cu().findAll(MethodCallExpr.class)) {
            String callerId = callerOf(call);
            if (callerId == null || !b.has(callerId)) {
                continue;
            }
            Ir.Location at = Ast.line(call, u.file());
            List<String> guards = guardsOf(call);
            String target = resolveCallTarget(call);
            if (target == null) {
                target = matchCallTarget(call, u);
            }
            if (target != null && b.has(target)) {
                b.edge(callerId, target, "calls", at, guards);
                callInfo.put(call, callRef("calls", target, call.getNameAsString()));
                callTarget.put(call, target);
                callSites.computeIfAbsent(target, k -> new ArrayList<>()).add(call);
            }
        }
        for (ObjectCreationExpr create : u.cu().findAll(ObjectCreationExpr.class)) {
            String callerId = callerOf(create);
            if (callerId == null || !b.has(callerId)) {
                continue;
            }
            String target = null;
            try {
                target = create.resolve().toAst()
                    .filter(n -> n instanceof CallableDeclaration<?>)
                    .map(n -> methodId((CallableDeclaration<?>) n)).orElse(null);
            } catch (RuntimeException | StackOverflowError ignored) {
                // constructor of a library type, or arguments the solver can't type
            }
            if (target == null) {
                target = matchConstructor(create, u);
            }
            if (target != null && b.has(target)) {
                b.edge(callerId, target, "calls", Ast.line(create, u.file()), guardsOf(create));
                callInfo.put(create, callRef("calls", target, "new " + create.getType().getNameAsString()));
                callTarget.put(create, target);
                callSites.computeIfAbsent(target, k -> new ArrayList<>()).add(create);
            }
        }
    }

    /**
     * Gives lambdas that run as their own unit of work a function node, so their calls and I/O
     * are attributed to them (not to the method that registered them) and they get control
     * flow: `server.createContext("/x", ex -> ...)`, `new Thread(() -> ...)`,
     * `executor.submit(() -> ...)`, `scheduler.schedule(() -> ..., ...)`.
     */
    private void taskLambdas(Unit u) {
        for (MethodCallExpr call : u.cu().findAll(MethodCallExpr.class)) {
            String name = call.getNameAsString();
            int at = name.equals("createContext") ? 1
                : SCHEDULERS.contains(name) || EXECUTORS.contains(name) ? 0 : -1;
            if (at >= 0 && call.getArguments().size() > at && call.getArgument(at) instanceof LambdaExpr l) {
                String role = name.equals("createContext") ? "handler " + Values.known(call.getArgument(0), valueContext)
                    .stream().map(Values.Value::text).findFirst().orElse("") : name;
                declareLambda(l, role.trim(), u);
            }
        }
        for (ObjectCreationExpr create : u.cu().findAll(ObjectCreationExpr.class)) {
            if (create.getType().getNameAsString().equals("Thread") && create.getArguments().isNonEmpty()
                && create.getArgument(0) instanceof LambdaExpr l) {
                declareLambda(l, "thread", u);
            }
        }
    }

    private void declareLambda(LambdaExpr l, String role, Unit u) {
        String owner = l.findAncestor(TypeDeclaration.class)
            .flatMap(td -> ((TypeDeclaration<?>) td).getFullyQualifiedName()).orElse(null);
        String parent = callerOf(l);
        if (owner == null || parent == null || !b.has(parent)) {
            return;
        }
        int line = l.getRange().map(r -> r.begin.line).orElse(0);
        String id = "method:" + owner + "#lambda@" + line + "()";
        Ir.Node n = b.node(id, "method", "λ " + role + " (line " + line + ")");
        n.parent = b.get(parent).parent; // sits in the same class as the method that creates it
        n.language = "java";
        n.location = Ast.loc(l, u.file());
        n.attrs.put("lambda", true);
        n.attrs.put("definedIn", parent);
        n.otel.put("code.namespace", owner);
        taskLambdas.put(l, id);
    }

    /** Function a node runs in: the innermost task lambda with its own node, else the enclosing method. */
    private String callerOf(Node n) {
        for (Node p = n.getParentNode().orElse(null); p != null; p = p.getParentNode().orElse(null)) {
            if (p instanceof LambdaExpr l && taskLambdas.containsKey(l)) {
                return taskLambdas.get(l);
            }
            if (p instanceof CallableDeclaration<?> c && Ast.isNamedMember(c)) {
                return methodId(c);
            }
        }
        return null;
    }

    /** Guards of a node within the function {@link #callerOf} attributes it to. */
    private List<String> guardsOf(Node n) {
        for (Node p = n.getParentNode().orElse(null); p != null; p = p.getParentNode().orElse(null)) {
            if (p instanceof LambdaExpr l && taskLambdas.containsKey(l)) {
                return Ast.guards(n, l);
            }
            if (p instanceof CallableDeclaration<?> c && Ast.isNamedMember(c)) {
                break;
            }
        }
        return Ast.guards(n);
    }

    /** Fallback for `new X(...)` of an in-repo type: its only constructor with that many parameters. */
    private String matchConstructor(ObjectCreationExpr create, Unit u) {
        TypeDeclaration<?> td = types.get(resolveType(create.getType(), u));
        if (td == null || create.getAnonymousClassBody().isPresent()) {
            return null;
        }
        List<ConstructorDeclaration> matches = td.getConstructors().stream()
            .filter(c -> c.getParameters().size() == create.getArguments().size()).toList();
        return matches.size() == 1 ? methodId(td.getFullyQualifiedName().orElse(""), matches.get(0)) : null;
    }

    /** Framework and plain-Java data-store / messaging / HTTP effects of every call in u. */
    private void io(Unit u) {
        for (MethodCallExpr call : u.cu().findAll(MethodCallExpr.class)) {
            String callerId = callerOf(call);
            if (callerId == null || !b.has(callerId)) {
                continue;
            }
            Map<String, Object> io = frameworkCall(call, callerId, Ast.line(call, u.file()), guardsOf(call), u);
            if (io != null) {
                if (callTarget.containsKey(call)) {
                    io.put("method", callTarget.get(call));
                }
                callInfo.put(call, io);
            }
        }
        plainIo(u);
    }

    private String resolveCallTarget(MethodCallExpr call) {
        try {
            return call.resolve().toAst()
                .filter(n -> n instanceof CallableDeclaration<?>)
                .map(n -> methodId((CallableDeclaration<?>) n)).orElse(null);
        } catch (RuntimeException | StackOverflowError e) {
            return null;
        }
    }

    /**
     * Fallback when the symbol solver can't resolve a call (often because an argument's type
     * is unresolvable): the in-repo receiver type's method with that name and arity, if unique
     * (searching supertypes declared in the repo too).
     */
    private String matchCallTarget(MethodCallExpr call, Unit u) {
        String owner;
        if (call.getScope().isEmpty()) {
            owner = call.findAncestor(TypeDeclaration.class)
                .flatMap(td -> ((TypeDeclaration<?>) td).getFullyQualifiedName()).orElse(null);
        } else {
            owner = receiverType(call, u);
        }
        List<String> seen = new ArrayList<>();
        while (owner != null && types.containsKey(owner) && !seen.contains(owner)) {
            seen.add(owner);
            TypeDeclaration<?> td = types.get(owner);
            List<MethodDeclaration> matches = td.getMethodsByName(call.getNameAsString()).stream()
                .filter(m -> m.getParameters().size() == call.getArguments().size()
                    || m.getParameters().size() > 0 && m.getParameter(m.getParameters().size() - 1).isVarArgs())
                .toList();
            if (matches.size() == 1) {
                return methodId(owner, matches.get(0));
            }
            if (matches.size() > 1) {
                return null; // overloaded: ambiguous without types
            }
            owner = td instanceof ClassOrInterfaceDeclaration c && !c.getExtendedTypes().isEmpty()
                ? resolveType(c.getExtendedTypes().get(0), unitOf.get(td)) : null;
        }
        return null;
    }

    private static Map<String, Object> callRef(String kind, String target, String name) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("kind", kind);
        m.put("target", target);
        m.put("name", name);
        return m;
    }

    /** Records data-store / messaging / HTTP effects of a call; returns what it touched, or null. */
    private Map<String, Object> frameworkCall(MethodCallExpr call, String callerId, Ir.Location at, List<String> guards, Unit u) {
        String receiver = receiverType(call, u);
        String name = call.getNameAsString();
        if (receiver != null) {
            String simple = Ast.simpleName(receiver);

            String entity = repoEntity.get(receiver);
            if (entity == null) {
                List<String> candidates = fqnsBySimpleName.getOrDefault(simple, List.of());
                entity = candidates.size() == 1 ? repoEntity.get(candidates.get(0)) : null;
            }
            String table = entity == null ? null : entityTable.get(entity);
            if (table != null) {
                String op = dataOperation(name);
                Ir.Edge e = b.edge(callerId, table, op, at, guards);
                addToList(e.attrs, "operations", name);
                Map<String, Object> entityType = new LinkedHashMap<>(Map.of("type", Ast.simpleName(entity), "typeId", typeId(entity)));
                addType(e.attrs, op.equals("writes") ? "payloads" : "responses", entityType);
                return callRef(op, table, name);
            }

            if (simple.equals("KafkaTemplate") && (name.equals("send") || name.equals("executeInTransaction"))
                && call.getArguments().isNonEmpty()) {
                String topic = Ast.constString(call.getArgument(0));
                if (topic == null) {
                    topic = Values.known(call.getArgument(0), valueContext).stream().map(Values.Value::text).findFirst().orElse(null);
                }
                if (topic != null) {
                    Ir.Edge e = b.edge(callerId, topicNode(topic, "kafka"), "publishes", at, guards);
                    Map<String, Object> payload = call.getArguments().size() >= 2 ? exprInfo(call.getArgument(call.getArguments().size() - 1), u) : null;
                    addType(e.attrs, "payloads", payload != null ? payload : genericArg(call, 1, u));
                    return callRef("publishes", e.target, name);
                }
                return null;
            }
            if ((simple.equals("RabbitTemplate") || simple.equals("AmqpTemplate"))
                && name.startsWith("convertAndSend") && call.getArguments().size() >= 2) {
                String routingKey = Ast.constString(call.getArgument(call.getArguments().size() >= 3 ? 1 : 0));
                if (routingKey != null) {
                    Ir.Edge e = b.edge(callerId, queueNode(routingKey, "rabbitmq"), "publishes", at, guards);
                    addType(e.attrs, "payloads", exprInfo(call.getArgument(call.getArguments().size() - 1), u));
                    return callRef("publishes", e.target, name);
                }
                return null;
            }
            if (simple.equals("RestTemplate") && REST_TEMPLATE_METHODS.contains(name) && call.getArguments().isNonEmpty()) {
                Ir.Edge e = httpCall(callerId, Ast.constPrefix(call.getArgument(0)), restVerb(call), "resttemplate", at, guards);
                if (e != null) {
                    restTypes(call, e, u);
                    return httpRef(e);
                }
                return null;
            }
        }
        // WebClient: WebClient.create("http://x"), builder.baseUrl("http://x"), .uri("http://x/...")
        if ((name.equals("create") || name.equals("baseUrl") || name.equals("uri")) && call.getArguments().isNonEmpty()
            && (name.equals("uri") || call.toString().contains("WebClient") || receiver != null && receiver.contains("WebClient"))) {
            String url = Ast.constPrefix(call.getArgument(0));
            if (url != null && url.contains("://")) {
                Ir.Edge e = httpCall(callerId, url, null, "webclient", at, guards);
                return e == null ? null : httpRef(e);
            }
        }
        return null;
    }

    private static Map<String, Object> httpRef(Ir.Edge e) {
        Object verb = e.attrs.get("method");
        Object path = e.attrs.get("path");
        Map<String, Object> m = callRef("http_calls", e.target, ((verb != null ? verb + " " : "") + (path != null ? path : "")).trim());
        if (verb != null) {
            m.put("httpMethod", verb);
        }
        if (path != null) {
            m.put("path", path);
        }
        return m;
    }

    private Ir.Edge httpCall(String callerId, String url, String verb, String client, Ir.Location at, List<String> guards) {
        String ext = externalNode(url);
        if (ext == null) {
            return null;
        }
        Ir.Edge e = b.edge(callerId, ext, "http_calls", at, guards);
        if (verb != null) {
            e.attrs.put("method", verb);
        }
        String p = path(url);
        if (p != null) {
            e.attrs.put("path", p);
        }
        e.attrs.put("client", client);
        return e;
    }

    /** Request/response types of a RestTemplate call, from its body argument and response class. */
    private void restTypes(MethodCallExpr call, Ir.Edge e, Unit u) {
        NodeList<Expression> args = call.getArguments();
        String n = call.getNameAsString();
        int body = -1;
        int response = -1;
        if (n.startsWith("getFor")) {
            response = 1;
        } else if (n.startsWith("postFor") || n.equals("patchForObject")) {
            body = 1;
            response = n.equals("postForLocation") ? -1 : 2;
        } else if (n.equals("put")) {
            body = 1;
        } else if (n.equals("exchange")) {
            body = 2;
            response = 3;
        }
        if (body >= 0 && body < args.size()) {
            addType(e.attrs, "payloads", exprInfo(args.get(body), u));
        }
        if (response >= 0 && response < args.size()) {
            addType(e.attrs, "responses", exprInfo(args.get(response), u));
        }
    }

    // ----------------------------------------------- plain-Java I/O (no framework)

    private static final Set<String> JDBC_METHODS = Set.of("prepareStatement", "prepareCall", "executeQuery",
        "executeUpdate", "executeLargeUpdate", "execute", "addBatch", "query", "queryForObject", "queryForList",
        "queryForMap", "queryForRowSet", "queryForStream", "update", "batchUpdate", "createNativeQuery", "sql");
    private static final Set<String> REDIS_CLIENTS = Set.of("Jedis", "JedisCluster", "JedisPooled", "UnifiedJedis",
        "Pipeline", "Transaction", "ShardedJedis", "RedisCommands", "RedisAsyncCommands", "RedisReactiveCommands",
        "RedisClusterCommands", "RedisAdvancedClusterCommands", "StringRedisTemplate", "RedisTemplate",
        "ReactiveRedisTemplate", "ValueOperations", "HashOperations", "SetOperations", "ListOperations",
        "ZSetOperations", "StreamOperations");
    private static final Set<String> REDIS_WRITES = Set.of("set", "setex", "psetex", "setnx", "getSet", "getDel",
        "mset", "msetnx", "append", "incr", "incrBy", "incrByFloat", "decr", "decrBy", "increment", "decrement",
        "hset", "hmset", "hsetnx", "hincrBy", "hincrByFloat", "hdel", "put", "putAll", "putIfAbsent", "del", "unlink",
        "delete", "expire", "pexpire", "expireAt", "persist", "rename", "lpush", "rpush", "leftPush", "rightPush",
        "lpop", "rpop", "leftPop", "rightPop", "lset", "ltrim", "lrem", "sadd", "srem", "spop", "smove", "add",
        "remove", "zadd", "zrem", "zincrby", "zremrangeByScore", "pfadd", "setbit", "geoadd", "xtrim");
    private static final Set<String> REDIS_READS = Set.of("get", "mget", "multiGet", "getrange", "strlen", "exists",
        "hasKey", "type", "ttl", "pttl", "keys", "scan", "hget", "hmget", "hgetAll", "entries", "hkeys", "hvals",
        "hlen", "hexists", "hscan", "lrange", "range", "lindex", "llen", "smembers", "members", "sismember",
        "isMember", "scard", "srandmember", "sscan", "zrange", "zrangeByScore", "zrevrange", "zscore", "score",
        "zrank", "zcard", "zscan", "getbit", "pfcount", "geopos");
    private static final Pattern TOPIC_KEY = Pattern.compile("(?i)(^|[._-])(topic|topics|destination|channel)([._-]|$)");
    private static final Pattern TOPIC_NAME = Pattern.compile("[A-Za-z0-9][A-Za-z0-9._-]*");

    /** Where an effect is recorded: the caller that supplied the value, else the method doing the I/O. */
    private record Origin(String method, Ir.Location at, List<String> guards, String via) {}

    private Origin origin(Node io, Values.Value v) {
        if (v != null && v.site() != null) {
            Origin o = originAt(v.site(), io);
            if (o != null) {
                return o;
            }
        }
        return originAt(io, null);
    }

    private Origin originAt(Node at, Node io) {
        String id = callerOf(at);
        Unit u = unitFor(at);
        if (id == null || !b.has(id) || u == null) {
            return null;
        }
        String via = io == null ? null : callerOf(io);
        return new Origin(id, Ast.line(at, u.file()), guardsOf(at), via);
    }

    private Ir.Edge effect(Origin o, String target, String kind) {
        Ir.Edge e = b.edge(o.method(), target, kind, o.at(), o.guards());
        if (o.via() != null && !o.via().equals(o.method())) {
            addToList(e.attrs, "via", o.via());
        }
        return e;
    }

    /** Marks the call expression(s) behind an effect so control-flow steps show it as I/O. */
    private void noteIo(Node n, String kind, String target, String name) {
        Map<String, Object> prev = callInfo.get(n);
        if (prev != null && !"calls".equals(prev.get("kind"))) {
            return;
        }
        Map<String, Object> ref = callRef(kind, target, name);
        if (callTarget.containsKey(n)) {
            ref.put("method", callTarget.get(n));
        }
        callInfo.put(n, ref);
    }

    private void plainIo(Unit u) {
        for (ObjectCreationExpr create : u.cu().findAll(ObjectCreationExpr.class)) {
            if (create.getType().getNameAsString().equals("ProducerRecord") && create.getArguments().isNonEmpty()
                && !types.containsKey(resolveType(create.getType(), u))) {
                kafkaRecord(create, u);
            }
            String created = create.getType().getNameAsString();
            if ((created.equals("Socket") || created.equals("SSLSocket")) && create.getArguments().size() >= 2
                && !types.containsKey(resolveType(create.getType(), u))) {
                tcpClient(create, create.getArgument(0), create.getArgument(1), created.startsWith("SSL"), u); // new Socket(host, port)
            }
        }
        for (MethodCallExpr call : u.cu().findAll(MethodCallExpr.class)) {
            Map<String, Object> known = callInfo.get(call);
            if (known != null && !"calls".equals(known.get("kind"))) {
                continue; // already a framework fact
            }
            String receiver = receiverType(call, u);
            if (receiver != null && types.containsKey(receiver)) {
                continue; // our own class, not a client library
            }
            String simple = receiver == null ? "" : Ast.simpleName(receiver);
            String name = call.getNameAsString();
            if ((name.equals("subscribe") || name.equals("assign")) && simple.endsWith("Consumer") && call.getArguments().isNonEmpty()) {
                kafkaSubscribe(call, u);
            } else if (isRedis(call, simple)) {
                redis(call, u);
            } else if (JDBC_METHODS.contains(name) && call.getArguments().isNonEmpty()) {
                jdbc(call, u);
            } else if (name.equals("bind") && (simple.equals("ServerBootstrap") || scopeText(call).contains("ServerBootstrap"))) {
                netty(call, u);
            } else if (name.equals("createContext") && call.getArguments().isNonEmpty()
                && (simple.endsWith("HttpServer") || simple.endsWith("HttpsServer"))) {
                jdkHttp(call, u);
            } else if (name.equals("createSocket") && call.getArguments().size() >= 2
                && (simple.endsWith("SocketFactory") || scopeText(call).contains("SocketFactory"))) {
                // createSocket(host, port) or, layering TLS on a connected socket, createSocket(socket, host, port, autoClose)
                NodeList<Expression> a = call.getArguments();
                boolean layered = a.size() == 4;
                boolean tls = simple.startsWith("SSL") || scopeText(call).contains("SSL");
                tcpClient(call, a.get(layered ? 1 : 0), a.get(layered ? 2 : 1), tls, u);
            } else if (name.equals("connect") && call.getArguments().isNonEmpty()
                && (simple.endsWith("Socket") || simple.endsWith("SocketChannel"))
                && call.getArgument(0) instanceof ObjectCreationExpr addr
                && addr.getType().getNameAsString().equals("InetSocketAddress") && addr.getArguments().size() == 2) {
                tcpClient(call, addr.getArgument(0), addr.getArgument(1), simple.startsWith("SSL"), u); // socket.connect(new InetSocketAddress(host, port))
            }
        }
    }

    // ---- outgoing TCP / TLS connections (java.net.Socket, SocketFactory)

    /**
     * A connection this code opens to another system over plain TCP or TLS: an external system
     * named after its host (and port), linked from the function that connects. When the host
     * is only known at run time it is named after what supplies it (cfg.getTtHost() -> ttHost).
     */
    private record TcpClient(Node site, List<Values.Value> hosts, String port, boolean tls) {}

    private final List<TcpClient> tcpClients = new ArrayList<>();

    private void tcpClient(Node site, Expression hostExpr, Expression portExpr, boolean tls, Unit u) {
        List<Values.Value> hosts = Values.known(hostExpr, valueContext);
        if (hosts.isEmpty()) {
            hosts = List.of(new Values.Value(supplierName(hostExpr), null));
        }
        String port = Values.known(portExpr, valueContext).stream().map(Values.Value::text).findFirst()
            .orElse(supplierName(portExpr));
        tcpClients.add(new TcpClient(site, hosts.subList(0, Math.min(hosts.size(), 4)), port, tls));
    }

    /**
     * Links each outgoing connection: to the TCP server of an application in this repo listening
     * on that port (fill-producer's "TCP :6001", say), else to an external system for the host.
     */
    private void tcpClients() {
        Map<String, String> servers = new HashMap<>(); // port -> endpoint id
        for (Ir.Node n : b.nodes()) {
            if (n.kind.equals("endpoint") && "tcp".equals(n.attrs.get("protocol")) && n.attrs.get("port") instanceof String p) {
                servers.putIfAbsent(p, n.id);
            }
        }
        for (TcpClient c : tcpClients) {
            boolean numeric = c.port().matches("\\d+");
            for (Values.Value h : c.hosts()) {
                String target = numeric ? servers.get(c.port()) : null;
                String label;
                if (target == null) {
                    // example config placeholders read as names: <stellar-fix-host> -> stellar-fix-host
                    String host = h.text().isBlank() ? "tcp peer" : h.text().replaceAll("[<>{}]", "");
                    label = numeric ? host + ":" + c.port() : host;
                    Ir.Node ext = b.node("ext:tcp:" + label, "external", label);
                    ext.attrs.put("protocol", c.tls() ? "tls" : "tcp");
                    ext.otel.put("server.address", host);
                    if (numeric) {
                        ext.attrs.put("port", c.port());
                        ext.otel.put("server.port", c.port());
                    }
                    target = ext.id;
                } else {
                    label = b.get(target).name;
                }
                Origin o = origin(c.site(), h);
                if (o == null) {
                    continue;
                }
                Ir.Edge e = effect(o, target, "connects_to");
                e.attrs.put("protocol", c.tls() ? "tls" : "tcp");
                noteIo(c.site(), "connects_to", target, (c.tls() ? "TLS " : "TCP ") + label);
            }
        }
    }

    /** A readable name for a value only known at run time: the variable, field or getter holding it. */
    private static String supplierName(Expression e) {
        String n;
        if (e instanceof MethodCallExpr m) {
            n = m.getNameAsString().replaceFirst("^(get|read|load)(?=[A-Z])", "");
        } else if (e instanceof FieldAccessExpr f) {
            n = f.getNameAsString();
        } else if (e instanceof NameExpr ne) {
            n = ne.getNameAsString();
        } else {
            return "";
        }
        return n.isEmpty() ? "" : Character.toLowerCase(n.charAt(0)) + n.substring(1);
    }

    private static String scopeText(MethodCallExpr call) {
        return call.getScope().map(Node::toString).orElse("");
    }

    // ---- Kafka (kafka-clients)

    private void kafkaRecord(ObjectCreationExpr create, Unit u) {
        NodeList<Expression> args = create.getArguments();
        int value = switch (args.size()) {
            case 2 -> 1;
            case 3 -> 2;
            case 4 -> 3;
            default -> Math.min(4, args.size() - 1);
        };
        Map<String, Object> payload = args.size() >= 2 ? exprInfo(args.get(value), u) : null;
        List<Topic> all = topics(args.get(0), create, u);
        String sendName = "send " + String.join(", ", all.stream().map(Topic::name).toList());
        for (Topic t : all) {
            Origin o = origin(create, t.value());
            if (o == null) {
                continue;
            }
            String id = topicNode(t.name(), "kafka");
            Ir.Edge e = effect(o, id, "publishes");
            addType(e.attrs, "payloads", payload);
            t.mark(e);
            noteIo(create, "publishes", id, t.value() == null ? sendName : "send " + t.name());
            if (t.value() != null && t.value().site() != null) {
                noteIo(t.value().site(), "publishes", id, "send " + t.name());
            }
        }
    }

    private void kafkaSubscribe(MethodCallExpr call, Unit u) {
        Expression arg = call.getArgument(0);
        if (arg instanceof MethodCallExpr p && p.getNameAsString().equals("compile") && p.getArguments().isNonEmpty()) {
            arg = p.getArgument(0); // subscribe(Pattern.compile("orders-.*"))
        }
        Map<String, Object> generic = genericArg(call, 1, u);
        for (Topic t : topics(arg, call, u)) {
            Origin o = origin(call, t.value());
            if (o == null) {
                continue;
            }
            String id = topicNode(t.name(), "kafka");
            Ir.Edge e = effect(o, id, "consumes");
            Map<String, Object> decoded = decodedType(callables.get(o.method()), call);
            addType(e.attrs, "payloads", decoded != null ? decoded : generic);
            t.mark(e);
            noteIo(call, "consumes", id, "subscribe " + t.name());
            if (t.value() != null && t.value().site() != null) {
                noteIo(t.value().site(), "consumes", id, "subscribe " + t.name());
            }
        }
    }

    /** A topic name and how it was found: a traced value, or (value == null) the module config. */
    private record Topic(String name, Values.Value value, List<String> configKeys) {
        void mark(Ir.Edge e) {
            if (configKeys != null) {
                e.attrs.put("inferred", "config");
                configKeys.forEach(k -> addToList(e.attrs, "configKeys", k));
            }
        }
    }

    /**
     * Topic names an expression can take. When code picks the topic at runtime (from a map
     * filled from config, say), falls back to the topic names listed in the module's config.
     */
    private List<Topic> topics(Expression e, Node at, Unit u) {
        List<Topic> out = new ArrayList<>();
        for (Values.Value v : Values.known(e, valueContext)) {
            if (TOPIC_NAME.matcher(v.text()).matches()) {
                out.add(new Topic(v.text(), v, null));
            }
        }
        if (!out.isEmpty()) {
            return out;
        }
        Map<String, List<String>> byName = new LinkedHashMap<>();
        u.module().config().forEach((k, v) -> {
            if (TOPIC_KEY.matcher(k).find() && !v.contains("${")) {
                for (String name : v.split(",")) {
                    if (TOPIC_NAME.matcher(name.trim()).matches()) {
                        byName.computeIfAbsent(name.trim(), x -> new ArrayList<>()).add(k);
                    }
                }
            }
        });
        byName.forEach((name, keys) -> out.add(new Topic(name, null, keys)));
        return out;
    }

    /**
     * The in-repo type a consumer turns record values into: `Trade.parse(record.value())`,
     * `mapper.readValue(record.value(), Trade.class)`. Null if there is none.
     */
    private Map<String, Object> decodedType(CallableDeclaration<?> c, Node io) {
        Map<String, Object> t = c == null ? null : decodedIn(c);
        if (t == null) {
            // a consumer wrapper that decodes in its own poll loop
            TypeDeclaration<?> wrapper = io.findAncestor(TypeDeclaration.class).orElse(null);
            t = wrapper == null ? null : decodedIn(wrapper);
        }
        return t;
    }

    private static final Set<String> DECODERS = Set.of("parseFrom", "parse", "decode", "fromBytes", "deserialize",
        "readFrom", "parseDelimitedFrom");

    private Map<String, Object> decodedIn(Node scope) {
        Unit u = unitFor(scope);
        for (MethodCallExpr call : scope.findAll(MethodCallExpr.class)) {
            boolean takesValue = call.getArguments().stream().anyMatch(a ->
                a instanceof MethodCallExpr v && v.getNameAsString().equals("value") && v.getArguments().isEmpty());
            if (!takesValue) {
                continue;
            }
            for (Expression a : call.getArguments()) {
                if (a instanceof ClassExpr ce) {
                    return typeInfo(ce.getType(), u);
                }
            }
            String target = callTarget.get(call);
            if (target != null && callables.get(target) instanceof MethodDeclaration md) {
                Map<String, Object> t = typeInfo(md.getType(), unitFor(md));
                if (t != null && t.containsKey("typeId")) {
                    return t;
                }
            }
            // a library decoder on a type: PacketBody.parseFrom(record.value()) (protobuf)
            if (DECODERS.contains(call.getNameAsString()) && call.getScope().isPresent()) {
                String scopeText = call.getScope().get().toString();
                String simple = scopeText.substring(scopeText.lastIndexOf('.') + 1);
                if (!simple.isEmpty() && Character.isUpperCase(simple.charAt(0))) {
                    return new LinkedHashMap<>(Map.of("type", simple));
                }
            }
        }
        return null;
    }

    // ---- JDBC / SQL text

    private void jdbc(MethodCallExpr call, Unit u) {
        String db = null;
        List<Values.Value> values = Values.of(call.getArgument(0), valueContext);
        // when some variants name their tables, the "*" ones are the same statement less resolved
        boolean anyKnown = values.stream().map(v -> Sql.read(v.text())).anyMatch(st -> st != null
            && Stream.concat(st.writes().stream(), st.reads().stream()).anyMatch(t -> !t.equals(Values.UNKNOWN)));
        for (Values.Value v : values) {
            Sql.Statement st = Sql.read(v.text());
            if (st == null || anyKnown && Stream.concat(st.writes().stream(), st.reads().stream()).allMatch(t -> t.equals(Values.UNKNOWN))) {
                continue;
            }
            Origin o = origin(call, v);
            if (o == null) {
                continue;
            }
            if (db == null) {
                db = databaseNode(u);
            }
            for (String t : st.writes()) {
                sqlEffect(o, db, t, "writes", st, call);
            }
            for (String t : st.reads()) {
                sqlEffect(o, db, t, "reads", st, call);
            }
        }
    }

    private void sqlEffect(Origin o, String db, String table, String op, Sql.Statement st, MethodCallExpr call) {
        boolean known = !table.equals(Values.UNKNOWN);
        String target = known ? tableNode(db, table) : db;
        List<String> cols = st.columns().getOrDefault(table, List.of());
        if (known && !cols.isEmpty()) {
            mergeColumns(b.get(target), cols);
        }
        Ir.Edge e = effect(o, target, op);
        addToList(e.attrs, "operations", st.verb());
        Map<String, Object> type = new LinkedHashMap<>();
        type.put("type", (known ? table : "row") + (op.equals("writes") ? " row" : " rows"));
        if (!cols.isEmpty()) {
            type.put("fields", cols);
        }
        addType(e.attrs, op.equals("writes") ? "payloads" : "responses", type);
        noteIo(call, op, target, st.verb() + (known ? " " + table : ""));
    }

    /** Adds columns named in SQL to a table that has no (entity-declared) column list yet. */
    @SuppressWarnings("unchecked")
    private static void mergeColumns(Ir.Node table, List<String> names) {
        if (table.attrs.containsKey("entity")) {
            return;
        }
        List<Map<String, Object>> cols = (List<Map<String, Object>>) table.attrs.computeIfAbsent("columns", k -> new ArrayList<>());
        for (String n : names) {
            if (cols.stream().noneMatch(c -> n.equals(c.get("name")))) {
                cols.add(new LinkedHashMap<>(Map.of("name", n)));
            }
        }
    }

    // ---- Redis

    private boolean isRedis(MethodCallExpr call, String simple) {
        if (REDIS_CLIENTS.contains(simple)) {
            return true;
        }
        // var-typed or unresolved clients named like one (jedis.set), and template.opsForValue().set
        Optional<Expression> scope = call.getScope();
        return scope.filter(s -> s instanceof NameExpr && s.toString().toLowerCase(Locale.ROOT).matches(".*(jedis|redis).*")).isPresent()
            || scope.filter(s -> s instanceof MethodCallExpr m && m.getNameAsString().startsWith("opsFor")).isPresent();
    }

    private void redis(MethodCallExpr call, Unit u) {
        String name = call.getNameAsString();
        NodeList<Expression> args = call.getArguments();
        if (args.isEmpty()) {
            return;
        }
        String kind;
        List<Expression> keys;
        if (name.equals("publish") || name.equals("convertAndSend")) {
            kind = "publishes";
            keys = List.of(args.get(0));
        } else if (name.equals("subscribe") || name.equals("psubscribe")) {
            kind = "consumes";
            keys = args.size() > 1 && !(args.get(0) instanceof StringLiteralExpr) ? args.subList(1, args.size()) : List.of(args.get(0));
        } else if (name.equals("xadd")) {
            kind = "publishes";
            keys = List.of(args.get(0));
        } else if (name.equals("xread") || name.equals("xreadGroup")) {
            return; // stream offsets are passed as maps; too indirect to name
        } else if (REDIS_WRITES.contains(name)) {
            kind = "writes";
            keys = List.of(args.get(0));
        } else if (REDIS_READS.contains(name)) {
            kind = "reads";
            keys = List.of(args.get(0));
        } else {
            return;
        }
        String db = redisNode(u);
        for (Expression keyExpr : keys) {
            List<Values.Value> vs = Values.representative(Values.of(keyExpr, valueContext));
            if (vs.isEmpty()) {
                vs = List.of(new Values.Value(Values.UNKNOWN, null));
            }
            for (Values.Value v : vs) {
                Origin o = origin(call, v);
                if (o == null) {
                    continue;
                }
                String key = v.text().replaceAll("\\*+", "*");
                String target;
                if (kind.equals("publishes") || kind.equals("consumes")) {
                    // a channel only known at run time says so, instead of a bare "*"
                    Ir.Node ch = b.node("topic:redis:" + key, "topic", key.equals(Values.UNKNOWN) ? "unresolved channel" : key);
                    ch.otel.put("messaging.destination.name", key);
                    ch.otel.put("messaging.system", "redis");
                    ch.attrs.put("channel", true);
                    target = ch.id;
                } else {
                    target = key.equals(Values.UNKNOWN) ? db : tableNode(db, key);
                    if (!target.equals(db)) {
                        b.get(target).attrs.put("keyPattern", true);
                        b.get(target).attrs.putIfAbsent("redisType", redisType(name));
                    }
                }
                Ir.Edge e = effect(o, target, kind);
                addToList(e.attrs, "operations", name);
                if (!kind.equals("reads") && !kind.equals("consumes") && args.size() >= 2) {
                    addType(e.attrs, "payloads", exprInfo(args.get(args.size() - 1), u));
                }
                noteIo(call, kind, target, name + " " + key);
            }
        }
    }

    private static String redisType(String command) {
        char c = command.charAt(0);
        if (command.startsWith("h") || command.equals("put") || command.equals("putAll") || command.equals("entries")) {
            return "hash";
        }
        if (command.startsWith("z")) {
            return "sorted set";
        }
        if (c == 's' && !command.startsWith("set") || command.equals("members") || command.equals("isMember")) {
            return "set";
        }
        if (c == 'l' || command.startsWith("rpush") || command.startsWith("rpop") || command.startsWith("left") || command.startsWith("right")) {
            return "list";
        }
        if (command.startsWith("x")) {
            return "stream";
        }
        return "string";
    }

    private String redisNode(Unit u) {
        ProjectLayout.Module m = u.module();
        String host = m.redisHost() != null ? m.redisHost() : m.appName() + "-redis";
        String id = "db:redis/" + host;
        if (!b.has(id)) {
            Ir.Node db = b.node(id, "database", host);
            db.otel.put("db.system", "redis");
            db.otel.put("server.address", host);
            db.attrs.put("usedBy", u.moduleId());
        }
        return id;
    }

    // ---- inbound: Netty servers and the JDK HttpServer

    private void netty(MethodCallExpr call, Unit u) {
        Expression portExpr = call.getArguments().isEmpty() ? null : call.getArgument(call.getArguments().size() - 1);
        if (portExpr instanceof ObjectCreationExpr addr && addr.getArguments().isNonEmpty()) {
            portExpr = addr.getArgument(addr.getArguments().size() - 1); // bind(new InetSocketAddress(port))
        }
        List<Values.Value> ports = portExpr == null ? List.of() : Values.known(portExpr, valueContext);
        if (ports.isEmpty()) {
            ports = List.of(new Values.Value("", null));
        }
        List<String> handlers = nettyHandlers(call, u);
        String service = b.get(u.moduleId()).name;
        for (Values.Value port : ports) {
            Node at = port.site() != null ? port.site() : call;
            Unit au = unitFor(at);
            String name = port.text().isEmpty() ? "TCP server" : "TCP :" + port.text();
            Ir.Node ep = b.node("endpoint:" + service + ":" + name, "endpoint", name);
            ep.parent = u.moduleId();
            ep.location = Ast.loc(at, au.file());
            ep.attrs.put("protocol", "tcp");
            ep.attrs.put("framework", "netty");
            openedBy(ep, call, port.site());
            ep.otel.put("network.transport", "tcp");
            if (!port.text().isEmpty()) {
                ep.attrs.put("port", port.text());
                ep.otel.put("server.port", port.text());
            }
            for (String h : handlers) {
                b.edge(ep.id, h, "handles");
                if (callables.get(h) instanceof MethodDeclaration md && md.getParameters().size() >= 2) {
                    Map<String, Object> msg = typeInfo(md.getParameter(1).getType(), unitFor(md));
                    if (msg != null) {
                        ep.attrs.putIfAbsent("request", msg);
                    }
                }
            }
        }
    }

    /** channelRead methods of the in-repo handlers added to the pipeline that `bind` serves. */
    private List<String> nettyHandlers(MethodCallExpr bind, Unit u) {
        List<String> out = new ArrayList<>();
        List<TypeDeclaration<?>> queue = new ArrayList<>();
        bind.findAncestor(TypeDeclaration.class).ifPresent(td -> queue.add((TypeDeclaration<?>) td));
        for (int i = 0; i < queue.size() && i < 10; i++) {
            TypeDeclaration<?> td = queue.get(i);
            Unit tu = unitOf.get(td);
            for (MethodCallExpr c : td.findAll(MethodCallExpr.class)) {
                if (!Set.of("addLast", "addFirst", "childHandler", "handler").contains(c.getNameAsString())) {
                    continue;
                }
                for (Expression a : c.getArguments()) {
                    if (!(a instanceof ObjectCreationExpr o) || tu == null) {
                        continue;
                    }
                    TypeDeclaration<?> h = types.get(resolveType(o.getType(), tu));
                    if (h == null) {
                        continue;
                    }
                    String fqn = h.getFullyQualifiedName().orElse("");
                    Optional<MethodDeclaration> read = Stream.of("channelRead0", "channelRead", "messageReceived")
                        .flatMap(n -> h.getMethodsByName(n).stream()).findFirst();
                    if (read.isPresent()) {
                        String id = methodId(fqn, read.get());
                        if (!out.contains(id)) {
                            out.add(id);
                        }
                    } else if (!queue.contains(h)) {
                        queue.add(h); // a ChannelInitializer class: look at what it adds
                    }
                }
            }
        }
        return out;
    }

    private void jdkHttp(MethodCallExpr call, Unit u) {
        String handler = null;
        if (call.getArguments().size() >= 2) {
            Expression h = call.getArgument(1);
            if (h instanceof ObjectCreationExpr o) {
                TypeDeclaration<?> td = types.get(resolveType(o.getType(), u));
                if (td != null && !td.getMethodsByName("handle").isEmpty()) {
                    handler = methodId(td.getFullyQualifiedName().orElse(""), td.getMethodsByName("handle").get(0));
                }
            } else if (h instanceof MethodReferenceExpr ref) {
                handler = methodRef(ref, u);
            } else if (h instanceof LambdaExpr l) {
                handler = taskLambdas.get(l);
            }
        }
        String service = b.get(u.moduleId()).name;
        for (Values.Value path : Values.known(call.getArgument(0), valueContext)) {
            Node at = path.site() != null ? path.site() : call;
            Ir.Node ep = declareEndpoint(service, u, "ANY", route(path.text(), ""), handler, Ast.loc(at, unitFor(at).file()), "jdk-httpserver");
            openedBy(ep, call, path.site());
        }
    }

    /** Records which methods open a server endpoint (attrs.openedBy): the one that binds, and the caller that chose it. */
    private void openedBy(Ir.Node ep, Node bind, Node site) {
        for (Node n : site == null ? List.of(bind) : List.of(bind, site)) {
            String id = callerOf(n);
            if (id != null && b.has(id)) {
                addToList(ep.attrs, "openedBy", id);
            }
        }
    }

    /** In-repo method a method reference points at: this::m, field::m, Type::m. */
    private String methodRef(MethodReferenceExpr ref, Unit u) {
        String owner = null;
        Expression scope = ref.getScope();
        if (scope instanceof ThisExpr) {
            owner = ref.findAncestor(TypeDeclaration.class)
                .flatMap(td -> ((TypeDeclaration<?>) td).getFullyQualifiedName()).orElse(null);
        } else if (scope instanceof NameExpr || scope instanceof TypeExpr) {
            // `accounts::reload` parses with a TypeExpr scope too: a variable of that name wins
            String name = scope instanceof NameExpr n ? n.getNameAsString() : ((TypeExpr) scope).getType().asString();
            Type declared = name.contains(".") ? null : declaredType(ref, name);
            owner = declared != null ? resolveType(declared, u) : null;
            if (owner == null && scope instanceof TypeExpr t) {
                owner = resolveType(t.getType(), u);
            }
        }
        TypeDeclaration<?> td = owner == null ? null : types.get(owner);
        if (td == null) {
            return null;
        }
        List<MethodDeclaration> ms = td.getMethodsByName(ref.getIdentifier());
        return ms.size() == 1 ? methodId(owner, ms.get(0)) : null;
    }

    // ---- entry points beyond HTTP

    private static final Set<String> SCHEDULERS = Set.of("schedule", "scheduleAtFixedRate", "scheduleWithFixedDelay",
        "scheduleAtFixedDelay");

    /**
     * Marks methods where work starts without an HTTP request: attrs.entryPoint is "main",
     * "thread" (Thread/Runnable/Callable bodies) or "scheduled" (@Scheduled, or handed to a
     * scheduler). A main the build never packages gets attrs.packaged false. Message consumers
     * and socket/HTTP handlers are found through their edges.
     */
    private void entryPoints() {
        types.forEach((fqn, td) -> {
            for (MethodDeclaration m : td.getMethods()) {
                Ir.Node n = b.get(methodId(fqn, m));
                if (n == null) {
                    continue;
                }
                String name = m.getNameAsString();
                if (Mains.isMain(m) || launched.contains(n.id)) {
                    n.attrs.put("entryPoint", "main");
                    // a main the build never puts in a jar: still where work can start, but not a program
                    if (!launched.contains(n.id)) {
                        n.attrs.put("packaged", false);
                    }
                } else if (Ast.has(m, "Scheduled")) {
                    n.attrs.put("entryPoint", "scheduled");
                    Ast.annotation(m, "Scheduled").ifPresent(a -> n.attrs.put("schedule", a.toString()));
                } else if ((name.equals("run") || name.equals("call")) && m.getParameters().isEmpty() && concurrent(td, 0)) {
                    n.attrs.put("entryPoint", "thread");
                }
            }
        });
        for (Unit u : units) {
            for (MethodCallExpr call : u.cu().findAll(MethodCallExpr.class)) {
                if (!SCHEDULERS.contains(call.getNameAsString()) || call.getArguments().isEmpty()) {
                    continue;
                }
                String target = null;
                Expression task = call.getArgument(0);
                if (task instanceof MethodReferenceExpr ref) {
                    target = methodRef(ref, u);
                } else if (task instanceof LambdaExpr l) {
                    target = taskLambdas.get(l);
                } else if (task instanceof ObjectCreationExpr o) {
                    TypeDeclaration<?> td = types.get(resolveType(o.getType(), u));
                    if (td != null) {
                        target = Stream.of("run", "call").flatMap(n -> td.getMethodsByName(n).stream())
                            .filter(m -> m.getParameters().isEmpty()).findFirst()
                            .map(m -> methodId(td.getFullyQualifiedName().orElse(""), m)).orElse(null);
                    }
                }
                if (target != null && b.has(target)) {
                    b.get(target).attrs.put("entryPoint", "scheduled");
                    b.get(target).attrs.put("schedule", call.getNameAsString()
                        + call.getArguments().stream().skip(1).map(Node::toString).toList().toString().replace('[', '(').replace(']', ')'));
                }
            }
        }
    }

    // ---- configuration and environment read by the program

    private static final Set<String> CONFIG_READERS = Set.of("getProperty", "getString", "getOrDefault", "getInt",
        "getInteger", "getLong", "getBoolean", "getValue", "getRequiredProperty", "get");

    /**
     * attrs.configReads [{key, file}] on methods that look up a key defined in the module's config
     * files, and attrs.envReads [NAME] on methods that read environment variables.
     */
    private void configReads() {
        for (Unit u : units) {
            for (MethodCallExpr call : u.cu().findAll(MethodCallExpr.class)) {
                if (call.getArguments().isEmpty()) {
                    continue;
                }
                String name = call.getNameAsString();
                String key = Ast.constString(call.getArgument(0));
                CallableDeclaration<?> c = Ast.enclosingCallable(call);
                Ir.Node method = c == null ? null : b.get(methodId(c));
                if (key == null || method == null) {
                    continue;
                }
                if (name.equals("getenv")) {
                    addToList(method.attrs, "envReads", key);
                } else if (CONFIG_READERS.contains(name) && u.module().config().containsKey(key)) {
                    Map<String, Object> read = new LinkedHashMap<>();
                    read.put("key", key);
                    read.put("file", configFile(u, call, key));
                    addToList(method.attrs, "configReads", read);
                }
            }
        }
    }

    /**
     * The file a key is read from: the only one defining it; else the one this class names
     * ("processor.properties"); else one named by a class under the same top-level package
     * (producer.Main loads "producer.config" that producer.kafka.KafkaConfig reads); else one
     * whose name is a segment of this class's package.
     */
    /** Source text of every class under one top-level package of a module, for finding the config file it loads. */
    private final Map<String, String> packageText = new HashMap<>();

    private String configFile(Unit u, Node at, String key) {
        List<String> files = u.module().configFiles().getOrDefault(key, List.of());
        if (files.size() > 1) {
            String source = at.findAncestor(TypeDeclaration.class).map(Node::toString).orElse("");
            for (String f : files) {
                if (source.contains("\"" + f + "\"")) {
                    return f;
                }
            }
            String top = u.pkg().contains(".") ? u.pkg().substring(0, u.pkg().indexOf('.')) : u.pkg();
            String text = top.isEmpty() ? "" : packageText.computeIfAbsent(u.module().path() + "|" + top, k -> {
                StringBuilder sb = new StringBuilder();
                for (Unit other : units) {
                    if (other.module() == u.module() && (other.pkg().equals(top) || other.pkg().startsWith(top + "."))) {
                        sb.append(other.cu()).append('\n');
                    }
                }
                return sb.toString();
            });
            List<String> named = files.stream().filter(f -> text.contains("\"" + f + "\"")).toList();
            if (named.size() == 1) {
                return named.get(0);
            }
            List<String> segments = List.of(u.pkg().split("\\."));
            for (String f : files) {
                String base = f.contains(".") ? f.substring(0, f.indexOf('.')) : f;
                if (segments.contains(base)) {
                    return f;
                }
            }
        }
        return files.isEmpty() ? "config" : files.get(0);
    }

    // ---- work started on other threads

    private static final Set<String> EXECUTORS = Set.of("submit", "execute", "runAsync", "supplyAsync", "invokeAll");

    /**
     * Calls edges with attrs.async ("thread", "scheduled", "executor") from where work is started
     * to the method that runs it on another thread: `new Worker().start()`, `new Thread(task)`,
     * `executor.submit(task)`, `scheduler.scheduleAtFixedRate(task, ...)`. Views that follow
     * the synchronous call tree skip them; the program view follows them.
     */
    private void asyncStarts() {
        for (Unit u : units) {
            for (MethodCallExpr call : u.cu().findAll(MethodCallExpr.class)) {
                String name = call.getNameAsString();
                Expression task;
                String how;
                if (name.equals("start") && call.getArguments().isEmpty() && call.getScope().isPresent()) {
                    task = call.getScope().get();
                    how = "thread";
                } else if (SCHEDULERS.contains(name) && call.getArguments().isNonEmpty()) {
                    task = call.getArgument(0);
                    how = "scheduled";
                } else if (EXECUTORS.contains(name) && call.getArguments().isNonEmpty()) {
                    task = call.getArgument(0);
                    how = "executor";
                } else {
                    continue;
                }
                asyncEdge(call, taskTarget(task, call, u), how, u);
            }
            for (ObjectCreationExpr create : u.cu().findAll(ObjectCreationExpr.class)) {
                if (create.getType().getNameAsString().equals("Thread") && create.getArguments().isNonEmpty()) {
                    boolean hook = create.getParentNode().filter(p -> p instanceof MethodCallExpr m
                        && m.getNameAsString().equals("addShutdownHook")).isPresent();
                    asyncEdge(create, taskTarget(create.getArgument(0), create, u), hook ? "shutdown" : "thread", u);
                }
            }
        }
    }

    private void asyncEdge(Node at, String target, String how, Unit u) {
        String caller = callerOf(at);
        if (target == null || caller == null || !b.has(caller) || !b.has(target) || caller.equals(target)) {
            return;
        }
        Ir.Edge e = b.edge(caller, target, "calls", Ast.line(at, u.file()), Ast.guards(at));
        e.attrs.put("async", how);
        if (!callInfo.containsKey(at) || "calls".equals(callInfo.get(at).get("kind"))) {
            Map<String, Object> ref = callRef("calls", target, "start " + b.get(target).name);
            ref.put("async", how);
            callInfo.put(at, ref);
        }
    }

    /** The run()/call() (or referenced method) a task expression stands for, if it is in the repo. */
    private String taskTarget(Expression task, Node at, Unit u) {
        if (task instanceof MethodReferenceExpr ref) {
            return methodRef(ref, u);
        }
        if (task instanceof LambdaExpr l) {
            return taskLambdas.get(l);
        }
        TypeDeclaration<?> td = null;
        if (task instanceof ObjectCreationExpr o && o.getAnonymousClassBody().isEmpty()) {
            td = types.get(resolveType(o.getType(), u));
        } else if (task instanceof NameExpr || task instanceof FieldAccessExpr f && f.getScope() instanceof ThisExpr) {
            String name = task instanceof NameExpr n ? n.getNameAsString() : ((FieldAccessExpr) task).getNameAsString();
            Type declared = declaredType(at, name);
            td = declared == null ? null : types.get(resolveType(declared, u));
        }
        for (int depth = 0; td != null && depth < 5; depth++) {
            if (!concurrent(td, 0)) {
                return null;
            }
            TypeDeclaration<?> cur = td;
            String fqn = cur.getFullyQualifiedName().orElse("");
            Optional<MethodDeclaration> body = Stream.of("run", "call").flatMap(n -> cur.getMethodsByName(n).stream())
                .filter(m -> m.getParameters().isEmpty() && m.getBody().isPresent()).findFirst();
            if (body.isPresent()) {
                return methodId(fqn, body.get());
            }
            // inherited run(): look in the in-repo superclass
            td = td instanceof ClassOrInterfaceDeclaration c && !c.getExtendedTypes().isEmpty()
                ? types.get(resolveType(c.getExtendedTypes().get(0), unitOf.get(td))) : null;
        }
        return null;
    }

    /** Thread, Runnable, Callable or TimerTask, directly or through in-repo supertypes. */
    private boolean concurrent(TypeDeclaration<?> td, int depth) {
        if (!(td instanceof ClassOrInterfaceDeclaration c) || depth > 4) {
            return false;
        }
        List<ClassOrInterfaceType> supers = new ArrayList<>(c.getExtendedTypes());
        supers.addAll(c.getImplementedTypes());
        for (ClassOrInterfaceType s : supers) {
            if (Set.of("Thread", "Runnable", "Callable", "TimerTask").contains(s.getNameAsString())) {
                return true;
            }
            TypeDeclaration<?> sup = types.get(resolveType(s, unitOf.get(td)));
            if (sup != null && concurrent(sup, depth + 1)) {
                return true;
            }
        }
        return false;
    }

    // ------------------------------------------------------------ data types

    /** Container types whose payload is their (last) type argument. */
    private static final Set<String> WRAPPERS = Set.of("ResponseEntity", "Optional", "Mono", "Flux", "CompletableFuture",
        "CompletionStage", "HttpEntity", "RequestEntity", "DeferredResult", "Callable", "ConsumerRecord", "Message");

    /** {type, typeId?} of a declared type, unwrapping ResponseEntity&lt;T&gt;, Optional&lt;T&gt;, ...; null for void. */
    private Map<String, Object> typeInfo(Type t, Unit u) {
        if (t == null) {
            return null;
        }
        Type inner = unwrap(t);
        if (inner.isVoidType() || inner.asString().equals("Void")) {
            return null;
        }
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("type", inner.asString());
        referencedTypes(inner, u).stream().findFirst().ifPresent(fqn -> m.put("typeId", typeId(fqn)));
        return m;
    }

    private static Type unwrap(Type t) {
        while (t instanceof ClassOrInterfaceType c && WRAPPERS.contains(c.getNameAsString())
            && c.getTypeArguments().map(a -> !a.isEmpty()).orElse(false)) {
            NodeList<Type> args = c.getTypeArguments().get();
            t = args.get(args.size() - 1);
        }
        return t;
    }

    /** Type of the value an expression produces: syntax first, then the symbol solver. */
    private Map<String, Object> exprInfo(Expression e, Unit u) {
        if (e == null || e.isNullLiteralExpr()) {
            return null;
        }
        if (e instanceof ObjectCreationExpr o) {
            if (WRAPPERS.contains(o.getType().getNameAsString()) && o.getArguments().isNonEmpty()) {
                return exprInfo(o.getArgument(0), u); // new HttpEntity<>(body)
            }
            return typeInfo(o.getType(), u);
        }
        if (e instanceof ClassExpr c) {
            return typeInfo(c.getType(), u);
        }
        if (e instanceof StringLiteralExpr || e instanceof BinaryExpr bx && bx.getOperator() == BinaryExpr.Operator.PLUS
            && Ast.constPrefix(e) != null) {
            return new LinkedHashMap<>(Map.of("type", "String"));
        }
        if (e instanceof NameExpr n) {
            Type declared = declaredType(e, n.getNameAsString());
            if (declared != null && !declared.isVarType()) {
                return typeInfo(declared, u);
            }
        }
        try {
            ResolvedType rt = e.calculateResolvedType();
            String name = rt.isReferenceType() ? rt.asReferenceType().getQualifiedName() : rt.describe();
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("type", Ast.simpleName(name));
            if (types.containsKey(name)) {
                m.put("typeId", typeId(name));
            }
            return m;
        } catch (RuntimeException | StackOverflowError ex) {
            return null;
        }
    }

    /** Generic argument `index` of the receiver's declared type: KafkaTemplate&lt;K, V&gt; -> V. */
    private Map<String, Object> genericArg(MethodCallExpr call, int index, Unit u) {
        if (call.getScope().isEmpty() || !(call.getScope().get() instanceof NameExpr
            || call.getScope().get() instanceof FieldAccessExpr)) {
            return null;
        }
        String name = call.getScope().get() instanceof NameExpr n ? n.getNameAsString()
            : ((FieldAccessExpr) call.getScope().get()).getNameAsString();
        Type declared = declaredType(call, name);
        if (declared instanceof ClassOrInterfaceType c && c.getTypeArguments().isPresent()
            && c.getTypeArguments().get().size() > index) {
            return typeInfo(c.getTypeArguments().get().get(index), u);
        }
        return null;
    }

    /** "query: sku, quantity" style description of non-body parameters. */
    private static Map<String, Object> paramsInfo(NodeList<Parameter> params) {
        List<String> names = params.stream().map(Parameter::getNameAsString).toList();
        return new LinkedHashMap<>(Map.of("type", "params(" + String.join(", ", names) + ")"));
    }

    private static void addType(Map<String, Object> attrs, String key, Map<String, Object> type) {
        if (type != null) {
            addToList(attrs, key, type);
        }
    }

    private static String restVerb(MethodCallExpr call) {
        String n = call.getNameAsString();
        if (n.startsWith("get")) {
            return "GET";
        }
        if (n.startsWith("post")) {
            return "POST";
        }
        if (n.startsWith("patch")) {
            return "PATCH";
        }
        if (n.equals("put")) {
            return "PUT";
        }
        if (n.equals("delete")) {
            return "DELETE";
        }
        if (n.equals("headForHeaders")) {
            return "HEAD";
        }
        if (n.equals("exchange") && call.getArguments().size() >= 2 && call.getArgument(1) instanceof FieldAccessExpr f) {
            return f.getNameAsString(); // HttpMethod.POST
        }
        return null;
    }
}
