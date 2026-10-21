package dev.codeatlas.java;

import com.github.javaparser.ast.Node;
import com.github.javaparser.ast.body.CallableDeclaration;
import com.github.javaparser.ast.body.FieldDeclaration;
import com.github.javaparser.ast.body.Parameter;
import com.github.javaparser.ast.body.RecordDeclaration;
import com.github.javaparser.ast.body.TypeDeclaration;
import com.github.javaparser.ast.body.VariableDeclarator;
import com.github.javaparser.ast.expr.AssignExpr;
import com.github.javaparser.ast.expr.FieldAccessExpr;
import com.github.javaparser.ast.expr.LambdaExpr;
import com.github.javaparser.ast.expr.MethodCallExpr;
import com.github.javaparser.ast.expr.NameExpr;
import com.github.javaparser.ast.expr.PatternExpr;
import com.github.javaparser.ast.expr.ThisExpr;
import com.github.javaparser.ast.expr.UnaryExpr;
import com.github.javaparser.ast.nodeTypes.NodeWithType;
import com.github.javaparser.resolution.declarations.ResolvedFieldDeclaration;
import com.github.javaparser.resolution.declarations.ResolvedValueDeclaration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/**
 * The variables a function uses, each with the scope it is declared in, stored as
 * attrs.variables: [{name, scope, type?, declaredIn?, line, reads, writes, final?}].
 *
 * <p>Scopes: {@code param} and {@code local} are the function's own; {@code captured} comes
 * from an enclosing function (lambdas); {@code field} is instance state of a class;
 * {@code static} is class-level state shared by every caller. Writes count assignments,
 * ++/-- and calls of mutating methods (add, put, remove...) on the variable.
 */
final class Variables {

    /** Calls that change the object they are called on. */
    private static final Set<String> MUTATORS = Set.of(
        "add", "addAll", "put", "putAll", "putIfAbsent", "remove", "removeIf", "clear", "set", "offer", "poll",
        "push", "pop", "compute", "computeIfAbsent", "computeIfPresent", "merge", "replace", "replaceAll",
        "incrementAndGet", "getAndIncrement", "decrementAndGet", "getAndDecrement", "addAndGet", "getAndAdd",
        "getAndSet", "compareAndSet", "lazySet", "accumulateAndGet", "updateAndGet", "increment", "decrement",
        "append", "insert", "setLength", "sort");
    private static final int MAX_VARIABLES = 60;
    private static final int MAX_LINES = 40;

    private final Node owner;
    private final Set<LambdaExpr> separate;
    private final Map<String, Map<String, Object>> found = new LinkedHashMap<>();

    private Variables(Node owner, Set<LambdaExpr> separate) {
        this.owner = owner;
        this.separate = separate;
    }

    static List<Map<String, Object>> of(CallableDeclaration<?> c, Set<LambdaExpr> separate) {
        Variables v = new Variables(c, separate);
        for (Parameter p : c.getParameters()) {
            v.declare(p.getNameAsString(), "param", p.getTypeAsString(), p, false);
        }
        v.scan();
        return v.result();
    }

    static List<Map<String, Object>> ofLambda(LambdaExpr l, Set<LambdaExpr> separate) {
        Variables v = new Variables(l, separate);
        for (Parameter p : l.getParameters()) {
            v.declare(p.getNameAsString(), "param", p.getType().isUnknownType() ? null : p.getTypeAsString(), p, false);
        }
        v.scan();
        return v.result();
    }

    private void scan() {
        // the function's own locals first, so uses can be told apart from fields of the same name
        for (VariableDeclarator d : owner.findAll(VariableDeclarator.class, this::mine)) {
            if (!(d.getParentNode().orElse(null) instanceof FieldDeclaration)) {
                declare(d.getNameAsString(), "local", d.getTypeAsString(), d, false);
            }
        }
        for (Parameter p : owner.findAll(Parameter.class, p -> mine(p) && p.getParentNode().orElse(null) != owner)) {
            declare(p.getNameAsString(), "local", p.getType().isUnknownType() ? null : p.getTypeAsString(), p, false);
        }
        for (PatternExpr p : owner.findAll(PatternExpr.class, this::mine)) {
            p.toTypePatternExpr().ifPresent(t -> declare(t.getNameAsString(), "local", t.getTypeAsString(), t, false));
        }
        for (NameExpr n : owner.findAll(NameExpr.class, this::mine)) {
            use(n.getNameAsString(), n);
        }
        for (FieldAccessExpr f : owner.findAll(FieldAccessExpr.class, this::mine)) {
            if (f.getScope() instanceof ThisExpr) {
                field(f.getNameAsString(), f, ownType().orElse(null));
            } else if (f.getScope() instanceof NameExpr s && Character.isUpperCase(s.getNameAsString().charAt(0))) {
                staticOf(f); // Other.CONSTANT / Other.counter
            }
        }
    }

    /** Inside this function, and not inside a lambda that is charted as a function of its own. */
    private boolean mine(Node n) {
        for (Node p = n; p != null; p = p.getParentNode().orElse(null)) {
            if (p == owner) {
                return true;
            }
            if (p instanceof LambdaExpr l && separate.contains(l)) {
                return false;
            }
        }
        return false;
    }

    private void use(String name, NameExpr n) {
        Map<String, Object> v = found.get(name);
        if (v != null && ("local".equals(v.get("scope")) || "param".equals(v.get("scope")))) {
            count(v, n);
            return;
        }
        // declared in an enclosing function (lambda bodies)
        Optional<Node> outer = enclosingDeclaration(name, n);
        if (outer.isPresent()) {
            Node d = outer.get();
            Map<String, Object> c = declare(name, "captured", typeOf(d), d, false);
            enclosingFunction(d).ifPresent(f -> c.put("declaredIn", f));
            count(c, n);
            return;
        }
        if (field(name, n, null)) {
            return;
        }
        if (Character.isUpperCase(name.charAt(0)) && !name.equals(name.toUpperCase())) {
            return; // a type name (Math.max, List.of)
        }
        // inherited fields and static imports: ask the symbol solver
        try {
            ResolvedValueDeclaration d = n.resolve();
            if (d.isField()) {
                resolvedField(name, d.asField(), n);
            }
        } catch (RuntimeException | StackOverflowError e) {
            // unresolvable: leave it out rather than guess
        }
    }

    /** A field of the function's own class or an enclosing class, by name. */
    private boolean field(String name, Node use, TypeDeclaration<?> only) {
        for (Node p = owner; p != null; p = p.getParentNode().orElse(null)) {
            if (!(p instanceof TypeDeclaration<?> td) || only != null && td != only) {
                continue;
            }
            for (FieldDeclaration f : td.getFields()) {
                for (VariableDeclarator v : f.getVariables()) {
                    if (v.getNameAsString().equals(name)) {
                        String fqn = td.getFullyQualifiedName().orElse(td.getNameAsString());
                        Map<String, Object> e = declare(name, f.isStatic() ? "static" : "field", v.getTypeAsString(), v, f.isFinal());
                        e.put("declaredIn", "field:" + fqn + "#" + name);
                        count(e, use);
                        return true;
                    }
                }
            }
            if (td instanceof RecordDeclaration r) {
                for (Parameter rp : r.getParameters()) {
                    if (rp.getNameAsString().equals(name)) {
                        String fqn = td.getFullyQualifiedName().orElse(td.getNameAsString());
                        Map<String, Object> e = declare(name, "field", rp.getTypeAsString(), rp, true);
                        e.put("declaredIn", "field:" + fqn + "#" + name);
                        count(e, use);
                        return true;
                    }
                }
            }
        }
        return false;
    }

    private void staticOf(FieldAccessExpr f) {
        try {
            ResolvedValueDeclaration d = f.resolve();
            if (d.isField() && d.asField().isStatic()) {
                resolvedField(f.toString(), d.asField(), f);
            }
        } catch (RuntimeException | StackOverflowError e) {
            // a package or nested type name, or unresolvable
        }
    }

    private void resolvedField(String name, ResolvedFieldDeclaration f, Node use) {
        String type = null;
        try {
            type = f.getType().describe().replaceAll("[\\w$]+\\.(?=[\\w$]+)", "");
        } catch (RuntimeException e) {
            // type outside the solver's reach
        }
        boolean fin = f.toAst().filter(FieldDeclaration.class::isInstance).map(x -> ((FieldDeclaration) x).isFinal()).orElse(false);
        Map<String, Object> e = declare(name, f.isStatic() ? "static" : "field", type, null, fin);
        e.put("declaredIn", "field:" + f.declaringType().getQualifiedName() + "#" + f.getName());
        count(e, use);
    }

    private Optional<TypeDeclaration<?>> ownType() {
        return owner.findAncestor(TypeDeclaration.class).map(t -> (TypeDeclaration<?>) t);
    }

    /** A parameter or local of a function enclosing this one (only lambdas have those). */
    private Optional<Node> enclosingDeclaration(String name, Node use) {
        if (!(owner instanceof LambdaExpr)) {
            return Optional.empty();
        }
        for (Node p = owner.getParentNode().orElse(null); p != null; p = p.getParentNode().orElse(null)) {
            if (p instanceof TypeDeclaration<?>) {
                break;
            }
            if (p instanceof CallableDeclaration<?> c) {
                for (Parameter x : c.getParameters()) {
                    if (x.getNameAsString().equals(name)) {
                        return Optional.of(x);
                    }
                }
            }
            if (p instanceof LambdaExpr l) {
                for (Parameter x : l.getParameters()) {
                    if (x.getNameAsString().equals(name)) {
                        return Optional.of(x);
                    }
                }
            }
            for (VariableDeclarator d : p.findAll(VariableDeclarator.class)) {
                if (d.getNameAsString().equals(name) && !(d.getParentNode().orElse(null) instanceof FieldDeclaration)
                    && !isInside(d, owner) && d.getBegin().isPresent() && use.getBegin().isPresent()
                    && d.getBegin().get().isBefore(use.getBegin().get())) {
                    return Optional.of(d);
                }
            }
        }
        return Optional.empty();
    }

    private static Optional<String> enclosingFunction(Node d) {
        Optional<CallableDeclaration<?>> c = d.findAncestor(CallableDeclaration.class).map(x -> (CallableDeclaration<?>) x);
        return c.map(fn -> {
            String owner = fn.findAncestor(TypeDeclaration.class).map(t -> (TypeDeclaration<?>) t)
                .map(t -> t.getFullyQualifiedName().orElse(t.getNameAsString())).orElse("");
            return JavaAnalyzer.methodId(owner, fn);
        });
    }

    private static boolean isInside(Node n, Node ancestor) {
        for (Node p = n; p != null; p = p.getParentNode().orElse(null)) {
            if (p == ancestor) {
                return true;
            }
        }
        return false;
    }

    private static String typeOf(Node d) {
        if (d instanceof NodeWithType<?, ?> t && !t.getType().isUnknownType() && !t.getType().isVarType()) {
            return t.getTypeAsString();
        }
        return null;
    }

    private Map<String, Object> declare(String name, String scope, String type, Node decl, boolean fin) {
        // a local may shadow a field of the same name (x vs this.x): keep them apart
        String key = switch (scope) {
            case "field", "static" -> "F:" + name;
            case "captured" -> "C:" + name;
            default -> name;
        };
        return found.computeIfAbsent(key, k -> {
            Map<String, Object> v = new LinkedHashMap<>();
            v.put("name", name);
            v.put("scope", scope);
            if (type != null && !type.equals("var")) {
                v.put("type", type);
            }
            if (decl != null && decl.getBegin().isPresent() && ("param".equals(scope) || "local".equals(scope))) {
                v.put("line", decl.getBegin().get().line);
            }
            if (fin) {
                v.put("final", true);
            }
            v.put("reads", 0);
            v.put("writes", 0);
            return v;
        });
    }

    private void count(Map<String, Object> v, Node use) {
        if (!v.containsKey("line") && use.getBegin().isPresent()) {
            v.put("line", use.getBegin().get().line);
        }
        boolean write = isWrite(use);
        String key = write ? "writes" : "reads";
        v.put(key, (int) v.get(key) + 1);
        // where each use is, so diagrams can attach the variable to the step that uses it
        if (use.getBegin().isPresent()) {
            addLine(v, "lines", use.getBegin().get().line);
            if (write) {
                addLine(v, "writeLines", use.getBegin().get().line);
            }
        }
    }

    @SuppressWarnings("unchecked")
    private static void addLine(Map<String, Object> v, String key, int line) {
        List<Integer> lines = (List<Integer>) v.computeIfAbsent(key, k -> new ArrayList<Integer>());
        if (!lines.contains(line) && lines.size() < MAX_LINES) {
            lines.add(line);
        }
    }

    /** Assigned, incremented, or the target of a mutating call (list.add(x), counter.incrementAndGet()). */
    private static boolean isWrite(Node use) {
        Node parent = use.getParentNode().orElse(null);
        if (parent instanceof AssignExpr a && a.getTarget() == use) {
            return true;
        }
        if (parent instanceof UnaryExpr u && (u.getOperator() == UnaryExpr.Operator.PREFIX_INCREMENT
            || u.getOperator() == UnaryExpr.Operator.PREFIX_DECREMENT || u.getOperator() == UnaryExpr.Operator.POSTFIX_INCREMENT
            || u.getOperator() == UnaryExpr.Operator.POSTFIX_DECREMENT)) {
            return true;
        }
        if (parent instanceof FieldAccessExpr f && f.getScope() instanceof ThisExpr) {
            return isWrite(f);
        }
        return parent instanceof MethodCallExpr m && m.getScope().map(s -> s == use).orElse(false)
            && MUTATORS.contains(m.getNameAsString());
    }

    private List<Map<String, Object>> result() {
        List<Map<String, Object>> out = new ArrayList<>();
        for (Map<String, Object> v : found.values()) {
            if ((int) v.get("reads") + (int) v.get("writes") == 0 && !"param".equals(v.get("scope"))) {
                continue; // declared, never used
            }
            out.add(v);
            if (out.size() >= MAX_VARIABLES) {
                break;
            }
        }
        return out;
    }
}
