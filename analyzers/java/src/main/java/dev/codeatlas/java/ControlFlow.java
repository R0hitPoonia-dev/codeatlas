package dev.codeatlas.java;

import com.github.javaparser.ast.Node;
import com.github.javaparser.ast.body.CallableDeclaration;
import com.github.javaparser.ast.body.ConstructorDeclaration;
import com.github.javaparser.ast.body.MethodDeclaration;
import com.github.javaparser.ast.expr.Expression;
import com.github.javaparser.ast.expr.LambdaExpr;
import com.github.javaparser.ast.expr.MethodCallExpr;
import com.github.javaparser.ast.expr.ObjectCreationExpr;
import com.github.javaparser.ast.expr.SwitchExpr;
import com.github.javaparser.ast.stmt.BlockStmt;
import com.github.javaparser.ast.stmt.BreakStmt;
import com.github.javaparser.ast.stmt.CatchClause;
import com.github.javaparser.ast.stmt.ContinueStmt;
import com.github.javaparser.ast.stmt.DoStmt;
import com.github.javaparser.ast.stmt.EmptyStmt;
import com.github.javaparser.ast.stmt.ExplicitConstructorInvocationStmt;
import com.github.javaparser.ast.stmt.ExpressionStmt;
import com.github.javaparser.ast.stmt.ForEachStmt;
import com.github.javaparser.ast.stmt.ForStmt;
import com.github.javaparser.ast.stmt.IfStmt;
import com.github.javaparser.ast.stmt.LabeledStmt;
import com.github.javaparser.ast.stmt.ReturnStmt;
import com.github.javaparser.ast.stmt.Statement;
import com.github.javaparser.ast.stmt.SwitchEntry;
import com.github.javaparser.ast.stmt.SwitchStmt;
import com.github.javaparser.ast.stmt.SynchronizedStmt;
import com.github.javaparser.ast.stmt.ThrowStmt;
import com.github.javaparser.ast.stmt.TryStmt;
import com.github.javaparser.ast.stmt.WhileStmt;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * Structured control flow of a method body, stored as attrs.controlFlow on method nodes:
 * a list of steps (do / if / switch / loop / try / return / throw / jump / sync), each listing
 * the calls it makes, resolved to in-repo methods or to the data stores / topics / remote
 * services they touch. The UI renders it as an activity diagram and walks it for sequence
 * diagrams.
 */
final class ControlFlow {

    /** Upper bound on steps per method, so generated code can't blow up the IR. */
    private static final int MAX_STEPS = 400;

    private final Map<Node, Map<String, Object>> callInfo;
    /** Lambdas charted as functions of their own: their calls don't belong to the enclosing body. */
    private final Set<LambdaExpr> separate;
    private final LambdaExpr self;
    private int steps;

    private ControlFlow(Map<Node, Map<String, Object>> callInfo, Set<LambdaExpr> separate, LambdaExpr self) {
        this.callInfo = callInfo;
        this.separate = separate;
        this.self = self;
    }

    /**
     * @param callInfo what each call/constructor expression resolved to (identity map), as
     *                 recorded by the analyzer's call pass: {kind, target?, name}
     */
    static List<Map<String, Object>> of(CallableDeclaration<?> c, Map<Node, Map<String, Object>> callInfo) {
        return of(c, callInfo, Set.of());
    }

    static List<Map<String, Object>> of(CallableDeclaration<?> c, Map<Node, Map<String, Object>> callInfo, Set<LambdaExpr> separate) {
        BlockStmt body = c instanceof MethodDeclaration m ? m.getBody().orElse(null)
            : c instanceof ConstructorDeclaration k ? k.getBody() : null;
        if (body == null) {
            return null;
        }
        ControlFlow cf = new ControlFlow(callInfo, separate, null);
        List<Map<String, Object>> out = cf.block(body.getStatements());
        if (cf.steps > MAX_STEPS) {
            out = new ArrayList<>(out.subList(0, Math.min(out.size(), 20)));
            out.add(step("do", body, Map.of("items", List.of(item("… (method too large to chart)", body, List.of())))));
        }
        return out;
    }

    /** Control flow of a lambda body (handlers and tasks given their own function node). */
    static List<Map<String, Object>> ofLambda(LambdaExpr l, Map<Node, Map<String, Object>> callInfo, Set<LambdaExpr> separate) {
        ControlFlow cf = new ControlFlow(callInfo, separate, l);
        if (l.getBody() instanceof BlockStmt b) {
            return cf.block(b.getStatements());
        }
        Map<String, Object> extra = new LinkedHashMap<>();
        Node body = l.getBody() instanceof ExpressionStmt e ? e.getExpression() : l.getBody();
        extra.put("text", Ast.text(body));
        cf.putCalls(extra, body, l.getBody());
        return List.of(step("return", l, extra));
    }

    private List<Map<String, Object>> block(List<Statement> stmts) {
        List<Map<String, Object>> out = new ArrayList<>();
        List<Map<String, Object>> pending = new ArrayList<>(); // consecutive simple statements
        Node pendingStart = null;
        for (Statement s : stmts) {
            if (steps++ > MAX_STEPS) {
                break;
            }
            Map<String, Object> simple = simpleItem(s);
            if (simple != null) {
                if (pending.isEmpty()) {
                    pendingStart = s;
                }
                pending.add(simple);
                continue;
            }
            if (!pending.isEmpty()) {
                out.add(step("do", pendingStart, Map.of("items", pending)));
                pending = new ArrayList<>();
            }
            Map<String, Object> st = statement(s);
            if (st != null) {
                out.add(st);
            }
        }
        if (!pending.isEmpty()) {
            out.add(step("do", pendingStart, Map.of("items", pending)));
        }
        return out;
    }

    /** One-line statements that are merged into an action: expressions, declarations, super(...). */
    private Map<String, Object> simpleItem(Statement s) {
        if (s instanceof ExpressionStmt e && !(e.getExpression() instanceof SwitchExpr)) {
            return item(Ast.text(e.getExpression()), s, calls(e.getExpression(), s));
        }
        if (s instanceof ExplicitConstructorInvocationStmt x) {
            return item(Ast.text(x), s, calls(x, s));
        }
        return null;
    }

    private Map<String, Object> statement(Statement s) {
        if (s instanceof BlockStmt b) {
            List<Map<String, Object>> inner = block(b.getStatements());
            return inner.isEmpty() ? null : step("block", s, Map.of("body", inner));
        }
        if (s instanceof LabeledStmt l) {
            return statement(l.getStatement());
        }
        if (s instanceof EmptyStmt) {
            return null;
        }
        if (s instanceof IfStmt i) {
            Map<String, Object> extra = new LinkedHashMap<>();
            extra.put("cond", Ast.text(i.getCondition()));
            putCalls(extra, i.getCondition(), s);
            extra.put("then", branch(i.getThenStmt()));
            i.getElseStmt().ifPresent(e -> extra.put("else", branch(e)));
            return step("if", s, extra);
        }
        if (s instanceof SwitchStmt sw) {
            return switchStep(s, Ast.text(sw.getSelector()), sw.getSelector(), sw.getEntries());
        }
        if (s instanceof ExpressionStmt e && e.getExpression() instanceof SwitchExpr sw) {
            return switchStep(s, Ast.text(sw.getSelector()), sw.getSelector(), sw.getEntries());
        }
        if (s instanceof ForEachStmt f) {
            Map<String, Object> extra = loop("foreach",
                "for each " + f.getVariableDeclarator().getNameAsString() + " in " + Ast.text(f.getIterable()), f.getBody());
            putCalls(extra, f.getIterable(), s);
            return step("loop", s, extra);
        }
        if (s instanceof ForStmt f) {
            Map<String, Object> extra = loop("for", f.getCompare().map(c -> "while " + Ast.text(c)).orElse("loop"), f.getBody());
            f.getCompare().ifPresent(c -> putCalls(extra, c, s));
            return step("loop", s, extra);
        }
        if (s instanceof WhileStmt w) {
            Map<String, Object> extra = loop("while", "while " + Ast.text(w.getCondition()), w.getBody());
            putCalls(extra, w.getCondition(), s);
            return step("loop", s, extra);
        }
        if (s instanceof DoStmt d) {
            Map<String, Object> extra = loop("do", "repeat while " + Ast.text(d.getCondition()), d.getBody());
            putCalls(extra, d.getCondition(), s);
            return step("loop", s, extra);
        }
        if (s instanceof TryStmt t) {
            Map<String, Object> extra = new LinkedHashMap<>();
            if (!t.getResources().isEmpty()) {
                extra.put("resources", t.getResources().stream().map(Ast::text).toList());
                List<Map<String, Object>> rc = new ArrayList<>();
                t.getResources().forEach(r -> rc.addAll(calls(r, s)));
                if (!rc.isEmpty()) {
                    extra.put("calls", rc);
                }
            }
            extra.put("body", block(t.getTryBlock().getStatements()));
            List<Map<String, Object>> catches = new ArrayList<>();
            for (CatchClause c : t.getCatchClauses()) {
                catches.add(Map.of("type", c.getParameter().getType().asString(), "body", block(c.getBody().getStatements())));
            }
            if (!catches.isEmpty()) {
                extra.put("catches", catches);
            }
            t.getFinallyBlock().ifPresent(f -> extra.put("finally", block(f.getStatements())));
            return step("try", s, extra);
        }
        if (s instanceof ReturnStmt r) {
            Map<String, Object> extra = new LinkedHashMap<>();
            r.getExpression().ifPresent(e -> {
                extra.put("text", Ast.text(e));
                putCalls(extra, e, s);
            });
            return step("return", s, extra);
        }
        if (s instanceof ThrowStmt t) {
            Map<String, Object> extra = new LinkedHashMap<>();
            extra.put("text", Ast.text(t.getExpression()));
            putCalls(extra, t.getExpression(), s);
            return step("throw", s, extra);
        }
        if (s instanceof BreakStmt) {
            return step("jump", s, Map.of("text", "break"));
        }
        if (s instanceof ContinueStmt) {
            return step("jump", s, Map.of("text", "continue"));
        }
        if (s instanceof SynchronizedStmt sy) {
            return step("sync", s, Map.of("text", "synchronized (" + Ast.text(sy.getExpression()) + ")",
                "body", block(sy.getBody().getStatements())));
        }
        // local class declarations, yield, assert...: keep as a plain action
        return step("do", s, Map.of("items", List.of(item(Ast.text(s), s, calls(s, s)))));
    }

    private List<Map<String, Object>> branch(Statement s) {
        if (s instanceof BlockStmt b) {
            return block(b.getStatements());
        }
        return block(List.of(s));
    }

    private Map<String, Object> loop(String kind, String text, Statement body) {
        Map<String, Object> extra = new LinkedHashMap<>();
        extra.put("kind", kind);
        extra.put("text", text);
        extra.put("body", branch(body));
        return extra;
    }

    private Map<String, Object> switchStep(Statement s, String on, Expression selector, List<SwitchEntry> entries) {
        Map<String, Object> extra = new LinkedHashMap<>();
        extra.put("on", on);
        putCalls(extra, selector, s);
        List<Map<String, Object>> cases = new ArrayList<>();
        for (SwitchEntry e : entries) {
            String label = e.getLabels().isEmpty() ? "default"
                : e.getLabels().stream().map(Ast::text).collect(Collectors.joining(", "));
            cases.add(Map.of("label", label, "body", block(e.getStatements())));
        }
        extra.put("cases", cases);
        return step("switch", s, extra);
    }

    private void putCalls(Map<String, Object> extra, Node expr, Node stmt) {
        List<Map<String, Object>> c = calls(expr, stmt);
        if (!c.isEmpty()) {
            extra.put("calls", c);
        }
    }

    /**
     * Resolved calls inside `expr`, in evaluation order (arguments before the call that uses
     * them). Calls only reachable under a lambda/ternary/short-circuit guard get `when`.
     */
    private List<Map<String, Object>> calls(Node expr, Node stmt) {
        List<Node> found = new ArrayList<>();
        found.addAll(expr.findAll(MethodCallExpr.class));
        found.addAll(expr.findAll(ObjectCreationExpr.class));
        found.sort(Comparator.comparing((Node n) -> n.getRange().map(r -> r.end).orElse(null),
            Comparator.nullsLast(Comparator.naturalOrder())));
        List<Map<String, Object>> out = new ArrayList<>();
        for (Node n : found) {
            Map<String, Object> info = callInfo.get(n);
            if (info == null || inSeparateLambda(n, stmt)) {
                continue;
            }
            Map<String, Object> c = new LinkedHashMap<>(info);
            c.put("text", Ast.text(n).length() > 70 ? Ast.text(n).substring(0, 67) + "..." : Ast.text(n));
            n.getRange().ifPresent(r -> c.put("line", r.begin.line));
            List<String> when = guardsWithin(n, stmt);
            if (!when.isEmpty()) {
                c.put("when", String.join(" › ", when));
            }
            out.add(c);
        }
        return out;
    }

    private boolean inSeparateLambda(Node n, Node stop) {
        for (Node p = n.getParentNode().orElse(null); p != null && p != stop; p = p.getParentNode().orElse(null)) {
            if (p instanceof LambdaExpr l && l != self && separate.contains(l)) {
                return true;
            }
        }
        return false;
    }

    /** Guards between a call and its enclosing statement (lambdas, ternaries, && / ||). */
    private static List<String> guardsWithin(Node n, Node stmt) {
        List<String> all = Ast.guards(n);
        List<String> outer = Ast.guards(stmt);
        return all.size() > outer.size() ? new ArrayList<>(all.subList(outer.size(), all.size())) : List.of();
    }

    private static Map<String, Object> item(String text, Node at, List<Map<String, Object>> calls) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("text", text);
        at.getRange().ifPresent(r -> m.put("line", r.begin.line));
        if (!calls.isEmpty()) {
            m.put("calls", calls);
        }
        return m;
    }

    private static Map<String, Object> step(String kind, Node at, Map<String, Object> extra) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("k", kind);
        at.getRange().ifPresent(r -> m.put("line", r.begin.line));
        m.putAll(extra);
        return m;
    }
}
