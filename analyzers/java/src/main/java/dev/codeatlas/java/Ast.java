package dev.codeatlas.java;

import com.github.javaparser.ast.AccessSpecifier;
import com.github.javaparser.ast.Node;
import com.github.javaparser.ast.body.BodyDeclaration;
import com.github.javaparser.ast.body.CallableDeclaration;
import com.github.javaparser.ast.body.ConstructorDeclaration;
import com.github.javaparser.ast.body.FieldDeclaration;
import com.github.javaparser.ast.body.TypeDeclaration;
import com.github.javaparser.ast.body.VariableDeclarator;
import com.github.javaparser.ast.expr.AnnotationExpr;
import com.github.javaparser.ast.expr.ConditionalExpr;
import com.github.javaparser.ast.expr.LambdaExpr;
import com.github.javaparser.ast.expr.MethodCallExpr;
import com.github.javaparser.ast.expr.ArrayInitializerExpr;
import com.github.javaparser.ast.expr.BinaryExpr;
import com.github.javaparser.ast.expr.Expression;
import com.github.javaparser.ast.expr.FieldAccessExpr;
import com.github.javaparser.ast.expr.NameExpr;
import com.github.javaparser.ast.expr.NormalAnnotationExpr;
import com.github.javaparser.ast.expr.ObjectCreationExpr;
import com.github.javaparser.ast.expr.SingleMemberAnnotationExpr;
import com.github.javaparser.ast.expr.StringLiteralExpr;
import com.github.javaparser.ast.expr.TextBlockLiteralExpr;
import com.github.javaparser.ast.nodeTypes.modifiers.NodeWithAccessModifiers;
import com.github.javaparser.ast.nodeTypes.NodeWithAnnotations;
import com.github.javaparser.ast.stmt.CatchClause;
import com.github.javaparser.ast.stmt.DoStmt;
import com.github.javaparser.ast.stmt.ForEachStmt;
import com.github.javaparser.ast.stmt.ForStmt;
import com.github.javaparser.ast.stmt.IfStmt;
import com.github.javaparser.ast.stmt.SwitchEntry;
import com.github.javaparser.ast.stmt.SwitchStmt;
import com.github.javaparser.ast.stmt.WhileStmt;
import com.github.javaparser.ast.expr.SwitchExpr;
import com.github.javaparser.ast.type.Type;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.stream.Collectors;

/** Syntax helpers shared by the analyzer rules. */
final class Ast {
    private Ast() {}

    static Ir.Location loc(Node n, String file) {
        return n.getRange().map(r -> new Ir.Location(file, r.begin.line, r.end.line)).orElse(new Ir.Location(file, null, null));
    }

    static Ir.Location line(Node n, String file) {
        return n.getRange().map(r -> new Ir.Location(file, r.begin.line, null)).orElse(new Ir.Location(file, null, null));
    }

    // ---- annotations ----

    static Optional<AnnotationExpr> annotation(NodeWithAnnotations<?> n, String simpleName) {
        for (AnnotationExpr a : n.getAnnotations()) {
            if (a.getName().getIdentifier().equals(simpleName)) {
                return Optional.of(a);
            }
        }
        return Optional.empty();
    }

    static boolean has(NodeWithAnnotations<?> n, String simpleName) {
        return annotation(n, simpleName).isPresent();
    }

    static List<String> annotationNames(NodeWithAnnotations<?> n) {
        return n.getAnnotations().stream().map(a -> a.getName().getIdentifier()).collect(Collectors.toList());
    }

    /** Raw expressions of the given attributes; for a single-member annotation, the member counts as "value". */
    static List<Expression> attr(AnnotationExpr a, String... keys) {
        Set<String> want = Set.of(keys);
        List<Expression> out = new ArrayList<>();
        if (a instanceof SingleMemberAnnotationExpr s && want.contains("value")) {
            flattenArray(s.getMemberValue(), out);
        } else if (a instanceof NormalAnnotationExpr na) {
            na.getPairs().forEach(p -> {
                if (want.contains(p.getNameAsString())) {
                    flattenArray(p.getValue(), out);
                }
            });
        }
        return out;
    }

    private static void flattenArray(Expression e, List<Expression> out) {
        if (e instanceof ArrayInitializerExpr arr) {
            arr.getValues().forEach(v -> flattenArray(v, out));
        } else {
            out.add(e);
        }
    }

    /** String values of the given attributes (constants resolved when possible). */
    static List<String> attrStrings(AnnotationExpr a, String... keys) {
        List<String> out = new ArrayList<>();
        for (Expression e : attr(a, keys)) {
            String s = constString(e);
            if (s != null) {
                out.add(s);
            }
        }
        return out;
    }

    static Optional<String> attrString(AnnotationExpr a, String... keys) {
        List<String> v = attrStrings(a, keys);
        return v.isEmpty() ? Optional.empty() : Optional.of(v.get(0));
    }

    /** Enum-ish attribute values as their last identifier, e.g. RequestMethod.POST -> POST. */
    static List<String> attrNames(AnnotationExpr a, String key) {
        List<String> out = new ArrayList<>();
        for (Expression e : attr(a, key)) {
            if (e instanceof FieldAccessExpr f) {
                out.add(f.getNameAsString());
            } else if (e instanceof NameExpr n) {
                out.add(n.getNameAsString());
            }
        }
        return out;
    }

    // ---- constants ----

    /** Evaluates string literals, concatenations of them and references to constant fields. */
    static String constString(Expression e) {
        return constString(e, 0);
    }

    private static String constString(Expression e, int depth) {
        if (e == null || depth > 6) {
            return null;
        }
        if (e instanceof StringLiteralExpr s) {
            return s.asString();
        }
        if (e instanceof TextBlockLiteralExpr t) {
            return t.asString();
        }
        if (e instanceof BinaryExpr b && b.getOperator() == BinaryExpr.Operator.PLUS) {
            String l = constString(b.getLeft(), depth + 1);
            String r = constString(b.getRight(), depth + 1);
            return l != null && r != null ? l + r : null;
        }
        if (e instanceof NameExpr || e instanceof FieldAccessExpr) {
            VariableDeclarator v = constantField(e);
            if (v != null && v.getInitializer().isPresent()) {
                return constString(v.getInitializer().get(), depth + 1);
            }
        }
        return null;
    }

    /** Leading literal part of a string expression, e.g. "http://x/" + id -> "http://x/". */
    static String constPrefix(Expression e) {
        String full = constString(e);
        if (full != null) {
            return full;
        }
        if (e instanceof BinaryExpr b && b.getOperator() == BinaryExpr.Operator.PLUS) {
            return constPrefix(b.getLeft());
        }
        return null;
    }

    private static VariableDeclarator constantField(Expression e) {
        try {
            var resolved = e instanceof NameExpr n ? n.resolve() : ((FieldAccessExpr) e).resolve();
            Optional<Node> ast = resolved.toAst();
            if (ast.isPresent() && ast.get() instanceof FieldDeclaration fd) {
                String name = resolved.getName();
                return fd.getVariables().stream().filter(v -> v.getNameAsString().equals(name)).findFirst().orElse(null);
            }
        } catch (RuntimeException | StackOverflowError ignored) {
            // fall back to a syntactic lookup in the enclosing types
        }
        String name = e instanceof NameExpr n ? n.getNameAsString() : ((FieldAccessExpr) e).getNameAsString();
        return fieldInScope(e, name);
    }

    /** Field named `name` declared in an enclosing type of `n`. */
    static VariableDeclarator fieldInScope(Node n, String name) {
        Optional<Node> p = n.getParentNode();
        while (p.isPresent()) {
            if (p.get() instanceof TypeDeclaration<?> td) {
                for (FieldDeclaration f : td.getFields()) {
                    for (VariableDeclarator v : f.getVariables()) {
                        if (v.getNameAsString().equals(name)) {
                            return v;
                        }
                    }
                }
            }
            p = p.get().getParentNode();
        }
        return null;
    }

    // ---- declarations ----

    /**
     * The method/constructor that encloses n, skipping members of anonymous classes so
     * their calls are attributed to the named method that created them.
     */
    static CallableDeclaration<?> enclosingCallable(Node n) {
        Optional<Node> p = n.getParentNode();
        while (p.isPresent()) {
            if (p.get() instanceof CallableDeclaration<?> c && isNamedMember(c)) {
                return c;
            }
            p = p.get().getParentNode();
        }
        return null;
    }

    static boolean isNamedMember(BodyDeclaration<?> d) {
        return d.getParentNode().map(p -> p instanceof TypeDeclaration<?>).orElse(false)
            && !(d.getParentNode().get().getParentNode().orElse(null) instanceof ObjectCreationExpr);
    }

    static String visibility(NodeWithAccessModifiers<?> n) {
        AccessSpecifier a = n.getAccessSpecifier();
        return switch (a) {
            case PUBLIC -> "public";
            case PRIVATE -> "private";
            case PROTECTED -> "protected";
            default -> "package";
        };
    }

    static String callableName(CallableDeclaration<?> c) {
        return c instanceof ConstructorDeclaration ? "<init>" : c.getNameAsString();
    }

    /** Type as written without generic arguments: Map<String, List<X>> -> Map. */
    static String erase(Type t) {
        return erase(t.asString());
    }

    static String erase(String s) {
        StringBuilder out = new StringBuilder();
        int depth = 0;
        for (char c : s.toCharArray()) {
            if (c == '<') {
                depth++;
            } else if (c == '>') {
                depth--;
            } else if (depth == 0) {
                out.append(c);
            }
        }
        return out.toString().trim();
    }

    static String simpleName(String typeName) {
        String erased = erase(typeName);
        int dot = erased.lastIndexOf('.');
        return dot >= 0 ? erased.substring(dot + 1) : erased;
    }

    // ---- logic: the conditions a statement runs under ----

    private static final Map<String, String> LAMBDA_GUARDS = Map.of(
        "orElseThrow", "if empty", "orElseGet", "if empty", "ifPresent", "if present",
        "ifPresentOrElse", "if present", "forEach", "for each", "exceptionally", "on error",
        "onErrorResume", "on error", "doOnError", "on error");

    /**
     * Conditions under which node n executes within its method, outermost first, e.g.
     * ["for each line in order.getLines()", "if result != null && result.approved()"].
     * Empty when it always runs.
     */
    static List<String> guards(Node n) {
        return guards(n, null);
    }

    /** Like {@link #guards(Node)}, stopping at `stop` (a lambda that is its own function) if reached first. */
    static List<String> guards(Node n, Node stop) {
        List<String> out = new ArrayList<>();
        Node child = n;
        for (Node p = n.getParentNode().orElse(null); p != null; child = p, p = p.getParentNode().orElse(null)) {
            if (p == stop || p instanceof CallableDeclaration<?> c && isNamedMember(c)) {
                break;
            }
            String g = guard(p, child);
            if (g != null) {
                out.add(g);
            }
        }
        Collections.reverse(out);
        return out;
    }

    private static String guard(Node p, Node child) {
        if (p instanceof IfStmt s) {
            if (s.getThenStmt() == child) {
                return "if " + text(s.getCondition());
            }
            if (s.getElseStmt().orElse(null) == child) {
                return "if not (" + text(s.getCondition()) + ")";
            }
        } else if (p instanceof ConditionalExpr c) {
            if (c.getThenExpr() == child) {
                return "if " + text(c.getCondition());
            }
            if (c.getElseExpr() == child) {
                return "if not (" + text(c.getCondition()) + ")";
            }
        } else if (p instanceof SwitchEntry e) {
            String selector = e.getParentNode().map(sw -> sw instanceof SwitchStmt ss ? text(ss.getSelector())
                : sw instanceof SwitchExpr se ? text(se.getSelector()) : "").orElse("");
            return e.getLabels().isEmpty() ? "default case of " + selector
                : "if " + selector + " is " + e.getLabels().stream().map(Ast::text).collect(Collectors.joining(" or "));
        } else if (p instanceof ForEachStmt f && f.getBody() == child) {
            return "for each " + f.getVariableDeclarator().getNameAsString() + " in " + text(f.getIterable());
        } else if (p instanceof ForStmt f && f.getBody() == child) {
            return f.getCompare().map(c -> "loop while " + text(c)).orElse("loop");
        } else if (p instanceof WhileStmt w && w.getBody() == child) {
            return "while " + text(w.getCondition());
        } else if (p instanceof DoStmt d && d.getBody() == child) {
            return "repeat while " + text(d.getCondition());
        } else if (p instanceof CatchClause c) {
            return "on " + c.getParameter().getType().asString();
        } else if (p instanceof BinaryExpr b && b.getRight() == child) {
            if (b.getOperator() == BinaryExpr.Operator.AND) {
                return "if " + text(b.getLeft());
            }
            if (b.getOperator() == BinaryExpr.Operator.OR) {
                return "if not (" + text(b.getLeft()) + ")";
            }
        } else if (p instanceof LambdaExpr && p.getParentNode().orElse(null) instanceof MethodCallExpr m) {
            return LAMBDA_GUARDS.get(m.getNameAsString());
        }
        return null;
    }

    /** Source text of an expression on one line, shortened for display. */
    static String text(Node n) {
        String s = n.toString().replaceAll("\\s+", " ").trim();
        return s.length() > 90 ? s.substring(0, 87) + "..." : s;
    }

    static String snakeCase(String s) {
        return s.replaceAll("([a-z0-9])([A-Z])", "$1_$2").replaceAll("([A-Z])([A-Z][a-z])", "$1_$2").toLowerCase();
    }

    /** The first paragraph of a Javadoc comment, without tags: what the code says it does. */
    static Optional<String> doc(Node n) {
        if (!(n instanceof BodyDeclaration<?> b)) {
            return Optional.empty();
        }
        return b.getComment().filter(c -> c.isJavadocComment()).map(c -> {
            String text = c.asJavadocComment().parse().getDescription().toText();
            String first = text.split("\\n\\s*\\n", 2)[0]
                .replaceAll("<[^>]+>", "").replaceAll("\\{@\\w+\\s+([^}]*)}", "$1").replaceAll("\\s+", " ").trim();
            return first.length() > 400 ? first.substring(0, 397) + "..." : first;
        }).filter(t -> !t.isEmpty());
    }
}
