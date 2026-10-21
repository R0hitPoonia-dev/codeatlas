package dev.codeatlas.java;

import com.github.javaparser.ast.Node;
import com.github.javaparser.ast.body.CallableDeclaration;
import com.github.javaparser.ast.body.MethodDeclaration;
import com.github.javaparser.ast.body.Parameter;
import com.github.javaparser.ast.body.TypeDeclaration;
import com.github.javaparser.ast.body.VariableDeclarator;
import com.github.javaparser.ast.expr.AssignExpr;
import com.github.javaparser.ast.expr.BinaryExpr;
import com.github.javaparser.ast.expr.CastExpr;
import com.github.javaparser.ast.expr.ConditionalExpr;
import com.github.javaparser.ast.expr.EnclosedExpr;
import com.github.javaparser.ast.expr.Expression;
import com.github.javaparser.ast.expr.FieldAccessExpr;
import com.github.javaparser.ast.expr.IntegerLiteralExpr;
import com.github.javaparser.ast.expr.LambdaExpr;
import com.github.javaparser.ast.expr.LongLiteralExpr;
import com.github.javaparser.ast.expr.MethodCallExpr;
import com.github.javaparser.ast.expr.NameExpr;
import com.github.javaparser.ast.expr.ThisExpr;
import com.github.javaparser.ast.nodeTypes.NodeWithArguments;
import com.github.javaparser.ast.stmt.ReturnStmt;
import java.util.ArrayList;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * The possible string values of an expression, for naming topics, tables, cache keys and
 * ports that plain Java code builds at runtime. Follows constants, config-file lookups
 * ({@code props.getProperty("db.table", "x")}), locals, fields and their assignments,
 * ternaries, string concatenation and, one call level at a time, the arguments callers pass
 * for a parameter. Parts that cannot be resolved become "*".
 */
final class Values {

    /**
     * A possible value. {@code site} is the call in another method that supplied it through a
     * parameter (the outermost one, where the literal was found), or null when the value is
     * decided inside the method being analysed.
     */
    record Value(String text, Node site) {}

    /** What the resolver needs from the analyzer. */
    interface Context {
        /** Calls and constructor invocations that target c (from the call graph). */
        List<Node> callSitesOf(CallableDeclaration<?> c);

        /** Merged config properties of the module that contains n. */
        Map<String, String> config(Node n);

        /** The in-repo method a call resolved to, or null. */
        CallableDeclaration<?> target(Node call);

        /**
         * For an accessor of an in-repo record (cfg.port()): the argument every `new Cfg(...)`
         * passes for that component. Empty when the call is not one.
         */
        default List<Expression> recordComponent(MethodCallExpr call) {
            return List.of();
        }
    }

    static final String UNKNOWN = "*";
    private static final int MAX_VALUES = 16;
    private static final int MAX_DEPTH = 10;

    private static final Set<String> CONFIG_GETTERS = Set.of("getProperty", "getString", "getOrDefault", "get",
        "getValue", "getenv", "getRequiredProperty", "getInt", "getInteger", "getLong", "getBoolean");
    private static final Set<String> PASS_ARG = Set.of("parseInt", "parseLong", "parseBoolean", "valueOf",
        "requireNonNull", "ofNullable", "of", "singletonList", "singleton", "asList", "requireNonNullElse",
        "nonNull", "copyOf");
    private static final Set<String> PASS_SCOPE = Set.of("trim", "strip", "toLowerCase", "toUpperCase", "intern",
        "toString", "orElseThrow", "get");
    /** Reading an element back out of a list / queue / map. */
    private static final Set<String> TAKE = Set.of("get", "poll", "peek", "take", "remove", "element", "getFirst",
        "getLast", "pop", "pollFirst", "pollLast", "peekFirst", "peekLast");
    /** Putting one in (the element is the last argument: list.add(x), map.put(k, x)). */
    private static final Set<String> PUT = Set.of("add", "offer", "put", "push", "addFirst", "addLast", "offerFirst",
        "offerLast", "putIfAbsent", "set");
    private static final Pattern CONFIG_KEY = Pattern.compile("[A-Za-z][A-Za-z0-9_.-]*");

    private final Context ctx;
    private final Map<Node, Boolean> active = new IdentityHashMap<>();
    /**
     * Helpers entered through a particular call (getter / prop(key, default) style): inside
     * them a parameter is that call's argument, not every caller's.
     */
    private final Map<CallableDeclaration<?>, NodeWithArguments<?>> bound = new IdentityHashMap<>();

    private Values(Context ctx) {
        this.ctx = ctx;
    }

    /** Possible values of e, de-duplicated; empty when nothing is known. */
    static List<Value> of(Expression e, Context ctx) {
        List<Value> out = new ArrayList<>();
        new Values(ctx).eval(e, 0, null, out);
        Map<String, Value> unique = new LinkedHashMap<>();
        for (Value v : out) {
            unique.putIfAbsent(v.text() + "\u0000" + System.identityHashCode(v.site()), v);
        }
        return new ArrayList<>(unique.values());
    }

    /** Values that are fully known (no "*" part). */
    static List<Value> known(Expression e, Context ctx) {
        return of(e, ctx).stream().filter(v -> !v.text().contains(UNKNOWN)).toList();
    }

    private void eval(Expression e, int depth, Node site, List<Value> out) {
        if (e == null || depth > MAX_DEPTH || out.size() >= MAX_VALUES || active.containsKey(e)) {
            return;
        }
        active.put(e, true);
        try {
            evalInner(e, depth, site, out);
        } finally {
            active.remove(e);
        }
    }

    private void evalInner(Expression e, int depth, Node site, List<Value> out) {
        String constant = Ast.constString(e);
        if (constant != null) {
            out.add(new Value(constant, site));
            return;
        }
        if (e instanceof IntegerLiteralExpr i) {
            out.add(new Value(i.getValue().replace("_", ""), site));
        } else if (e instanceof LongLiteralExpr l) {
            out.add(new Value(l.getValue().replaceAll("[_lL]", ""), site));
        } else if (e instanceof EnclosedExpr en) {
            eval(en.getInner(), depth, site, out);
        } else if (e instanceof CastExpr c) {
            eval(c.getExpression(), depth, site, out);
        } else if (e instanceof ConditionalExpr c) {
            // an unresolvable branch still happens at runtime: it contributes "*"
            out.addAll(part(c.getThenExpr(), depth, site));
            out.addAll(part(c.getElseExpr(), depth, site));
        } else if (e instanceof BinaryExpr b && b.getOperator() == BinaryExpr.Operator.PLUS) {
            concat(b, depth, site, out);
        } else if (e instanceof MethodCallExpr call) {
            call(call, depth, site, out);
        } else if (e instanceof NameExpr n) {
            name(n, n.getNameAsString(), depth, site, out);
        } else if (e instanceof FieldAccessExpr f && f.getScope() instanceof ThisExpr) {
            field(f, f.getNameAsString(), depth, site, out);
        }
    }

    /** "INSERT INTO " + table + " (...)": every combination, "*" for unknown parts. */
    private void concat(BinaryExpr b, int depth, Node site, List<Value> out) {
        List<Value> left = part(b.getLeft(), depth, site);
        List<Value> right = part(b.getRight(), depth, site);
        for (Value l : left) {
            for (Value r : right) {
                if (out.size() >= MAX_VALUES) {
                    return;
                }
                out.add(new Value(l.text() + r.text(), r.site() != site ? r.site() : l.site()));
            }
        }
    }

    private List<Value> part(Expression e, int depth, Node site) {
        List<Value> vs = new ArrayList<>();
        eval(e, depth + 1, site, vs);
        if (vs.isEmpty()) {
            vs.add(new Value(UNKNOWN, site));
        }
        return vs;
    }

    private void call(MethodCallExpr call, int depth, Node site, List<Value> out) {
        String name = call.getNameAsString();
        // config lookups: props.getProperty("key"[, "default"]), System.getenv("KEY")
        if (CONFIG_GETTERS.contains(name) && call.getArguments().isNonEmpty()) {
            String key = constant(call.getArgument(0));
            if (key != null && CONFIG_KEY.matcher(key).matches() && (key.contains(".") || !name.equals("get"))) {
                String v = ctx.config(call).get(key);
                if (v != null && !v.contains("${")) {
                    out.add(new Value(v, site));
                } else if (call.getArguments().size() > 1) {
                    eval(call.getArgument(1), depth + 1, site, out);
                }
                return;
            }
        }
        if (name.equals("split") && call.getScope().isPresent() && call.getArguments().size() == 1) {
            String sep = Ast.constString(call.getArgument(0));
            List<Value> whole = new ArrayList<>();
            eval(call.getScope().get(), depth + 1, site, whole);
            for (Value v : whole) {
                for (String piece : sep == null ? new String[] {v.text()} : v.text().split(sep)) {
                    if (!piece.isBlank()) {
                        out.add(new Value(piece.trim(), v.site()));
                    }
                }
            }
            return;
        }
        if (name.equals("orElse") || name.equals("orElseGet")) {
            call.getScope().ifPresent(s -> eval(s, depth + 1, site, out));
            eval(call.getArgument(0), depth + 1, site, out);
            return;
        }
        // an element of a collection filled in the same method / class: what was put into it
        if (TAKE.contains(name) && call.getArguments().size() <= 1 && call.getScope().isPresent()
            && collection(call.getScope().get(), depth, site, out)) {
            return;
        }
        if (PASS_ARG.contains(name)) {
            for (Expression a : call.getArguments()) {
                eval(a, depth + 1, site, out);
            }
            return;
        }
        if (PASS_SCOPE.contains(name) && call.getArguments().isEmpty() && call.getScope().isPresent()) {
            eval(call.getScope().get(), depth + 1, site, out);
            return;
        }
        // a record accessor: what the record was built with
        List<Expression> components = ctx.recordComponent(call);
        if (!components.isEmpty()) {
            for (Expression c : components) {
                eval(c, depth + 1, site, out);
            }
            return;
        }
        // an in-repo method: what it returns (getters, helpers like normalizePrefix(raw))
        if (ctx.target(call) instanceof MethodDeclaration md && md.getBody().isPresent()) {
            NodeWithArguments<?> outer = bound.put(md, call);
            try {
                for (ReturnStmt r : md.getBody().get().findAll(ReturnStmt.class)) {
                    if (r.getExpression().isPresent() && Ast.enclosingCallable(r) == md && !insideLambda(r, md)) {
                        out.addAll(part(r.getExpression().get(), depth, site));
                    }
                }
            } finally {
                if (outer == null) {
                    bound.remove(md);
                } else {
                    bound.put(md, outer);
                }
            }
            return;
        }
        // an unresolved helper taking one value, e.g. sanitize(table): assume it passes it through
        if (call.getArguments().size() == 1 && call.getScope().isEmpty()) {
            eval(call.getArgument(0), depth + 1, site, out);
        }
    }

    /**
     * Values put into the collection named by scope (a local, or a field of this class): true
     * when the scope is such a collection and at least one put was found.
     */
    private boolean collection(Expression scope, int depth, Node site, List<Value> out) {
        String var = scope instanceof NameExpr n ? n.getNameAsString()
            : scope instanceof FieldAccessExpr f && f.getScope() instanceof ThisExpr ? f.getNameAsString() : null;
        if (var == null) {
            return false;
        }
        CallableDeclaration<?> c = Ast.enclosingCallable(scope);
        boolean local = c != null && c.findAll(VariableDeclarator.class).stream().anyMatch(v -> v.getNameAsString().equals(var));
        Node area = local ? c : scope.findAncestor(TypeDeclaration.class).orElse(null);
        if (area == null) {
            return false;
        }
        boolean found = false;
        for (MethodCallExpr put : area.findAll(MethodCallExpr.class)) {
            if (!PUT.contains(put.getNameAsString()) || put.getArguments().isEmpty() || put.getScope().isEmpty()) {
                continue;
            }
            Expression s = put.getScope().get();
            boolean same = s instanceof NameExpr n && n.getNameAsString().equals(var)
                || s instanceof FieldAccessExpr f && f.getScope() instanceof ThisExpr && f.getNameAsString().equals(var);
            if (same) {
                found = true;
                eval(put.getArgument(put.getArguments().size() - 1), depth + 1, site, out);
            }
        }
        return found;
    }

    /** A constant string, or a parameter of a helper entered through a call passing one. */
    private String constant(Expression e) {
        String c = Ast.constString(e);
        if (c != null || !(e instanceof NameExpr n)) {
            return c;
        }
        CallableDeclaration<?> m = Ast.enclosingCallable(e);
        NodeWithArguments<?> via = m == null ? null : bound.get(m);
        if (via == null) {
            return null;
        }
        for (int i = 0; i < m.getParameters().size() && i < via.getArguments().size(); i++) {
            if (m.getParameter(i).getNameAsString().equals(n.getNameAsString())) {
                // the argument may itself be a parameter of an outer helper: required(p, key) -> str(p, key, "")
                Expression arg = via.getArguments().get(i);
                return arg == e ? null : constant(arg);
            }
        }
        return null;
    }

    private static boolean insideLambda(Node n, Node stop) {
        for (Node p = n.getParentNode().orElse(null); p != null && p != stop; p = p.getParentNode().orElse(null)) {
            if (p instanceof LambdaExpr) {
                return true;
            }
        }
        return false;
    }

    /**
     * The values worth showing when several describe the same key: "position::" (a helper's
     * "" default) gives way to "position:*:*", and "*:*:*" gives way to "position:*:*". A value
     * is dropped when another one from the same site covers it and is at least as specific,
     * or when it covers a more specific one.
     */
    static List<Value> representative(List<Value> values) {
        List<Value> out = new ArrayList<>();
        for (Value a : values) {
            boolean drop = false;
            for (Value b : values) {
                if (a == b || b.site() != a.site() || b.text().equals(a.text())) {
                    continue;
                }
                boolean bCoversA = wildcard(b.text()).matcher(a.text()).matches();
                boolean aCoversB = wildcard(a.text()).matcher(b.text()).matches();
                if (bCoversA && literals(b.text()) >= literals(a.text()) || aCoversB && literals(b.text()) > literals(a.text())) {
                    drop = true;
                    break;
                }
            }
            if (!drop) {
                out.add(a);
            }
        }
        return out;
    }

    private static int literals(String s) {
        return s.replace(UNKNOWN, "").length();
    }

    /** "a:*:b" as a regex where * matches anything, including nothing. */
    private static Pattern wildcard(String glob) {
        String[] parts = glob.split("\\*", -1);
        StringBuilder re = new StringBuilder();
        for (int i = 0; i < parts.length; i++) {
            if (i > 0) {
                re.append(".*");
            }
            re.append(Pattern.quote(parts[i]));
        }
        return Pattern.compile(re.toString());
    }

    private void name(Node at, String name, int depth, Node site, List<Value> out) {
        if (isLambdaParameter(at, name)) {
            return;
        }
        CallableDeclaration<?> c = Ast.enclosingCallable(at);
        if (c != null) {
            // a local: its initializer and later assignments
            boolean local = false;
            for (VariableDeclarator v : c.findAll(VariableDeclarator.class)) {
                if (v.getNameAsString().equals(name)) {
                    local = true;
                    v.getInitializer().ifPresent(init -> eval(init, depth + 1, site, out));
                }
            }
            for (AssignExpr a : c.findAll(AssignExpr.class)) {
                if (a.getTarget() instanceof NameExpr t && t.getNameAsString().equals(name)) {
                    local = true;
                    eval(a.getValue(), depth + 1, site, out);
                }
            }
            if (local) {
                return;
            }
            // a parameter: what callers pass
            for (int i = 0; i < c.getParameters().size(); i++) {
                Parameter p = c.getParameter(i);
                if (!p.getNameAsString().equals(name)) {
                    continue;
                }
                NodeWithArguments<?> via = bound.get(c);
                if (via != null) {
                    // reached through one call: only its argument
                    if (via.getArguments().size() > i) {
                        eval(via.getArguments().get(i), depth + 1, site, out);
                    }
                    return;
                }
                for (Node callSite : ctx.callSitesOf(c)) {
                    if (callSite instanceof NodeWithArguments<?> withArgs && withArgs.getArguments().size() > i) {
                        eval(withArgs.getArgument(i), depth + 1, callSite, out);
                    }
                }
                return;
            }
        }
        field(at, name, depth, site, out);
    }

    /**
     * A field: its initializer and every assignment to it in the declaring type. A value that
     * reaches the I/O through a field was stored earlier (configuration, say), so the call
     * sites it came through do not decide who performs the I/O: they are dropped.
     */
    private void field(Node at, String name, int depth, Node site, List<Value> out) {
        VariableDeclarator v = Ast.fieldInScope(at, name);
        if (v == null) {
            return;
        }
        List<Value> found = new ArrayList<>();
        v.getInitializer().ifPresent(init -> eval(init, depth + 1, site, found));
        TypeDeclaration<?> owner = v.findAncestor(TypeDeclaration.class).orElse(null);
        if (owner != null) {
            for (AssignExpr a : owner.findAll(AssignExpr.class)) {
                Expression t = a.getTarget();
                boolean match = t instanceof FieldAccessExpr f && f.getScope() instanceof ThisExpr && f.getNameAsString().equals(name)
                    || t instanceof NameExpr n && n.getNameAsString().equals(name) && !shadowed(a, name);
                if (match) {
                    eval(a.getValue(), depth + 1, site, found);
                }
            }
        }
        for (Value f : found) {
            out.add(new Value(f.text(), site));
        }
    }

    /** True when name is a local or parameter of the method containing n (so `name = x` is not the field). */
    private static boolean shadowed(Node n, String name) {
        CallableDeclaration<?> c = Ast.enclosingCallable(n);
        if (c == null) {
            return false;
        }
        return c.getParameters().stream().anyMatch(p -> p.getNameAsString().equals(name))
            || c.findAll(VariableDeclarator.class).stream().anyMatch(v -> v.getNameAsString().equals(name));
    }

    private static boolean isLambdaParameter(Node at, String name) {
        for (Node p = at.getParentNode().orElse(null); p != null && !(p instanceof CallableDeclaration<?>); p = p.getParentNode().orElse(null)) {
            if (p instanceof LambdaExpr l && l.getParameters().stream().anyMatch(x -> x.getNameAsString().equals(name))) {
                return true;
            }
        }
        return false;
    }
}
