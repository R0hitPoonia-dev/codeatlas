package dev.codeatlas.java;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** Every variable a function uses is reported with the scope it is declared in. */
class VariablesTest {

    @TempDir
    static Path dir;
    static Map<String, Ir.Node> nodes;

    @BeforeAll
    static void analyze() throws Exception {
        Path src = dir.resolve("src/main/java/demo");
        Files.createDirectories(src);
        Files.writeString(dir.resolve("pom.xml"), "<project><artifactId>vars</artifactId></project>");
        Files.writeString(src.resolve("Limits.java"), """
            package demo;

            public class Limits {
                public static final int MAX = 10;
            }
            """);
        Files.writeString(src.resolve("Counter.java"), """
            package demo;

            import java.util.ArrayList;
            import java.util.List;

            /**
             * Counts orders and remembers the last ones.
             *
             * <p>Second paragraph is left out.
             */
            public class Counter {
                private static int total;
                private final List<String> recent = new ArrayList<>();
                private String name;

                /** Adds an order to the {@code recent} list. */
                public int add(String order, int qty) {
                    int sum = qty * 2;
                    total += sum;
                    recent.add(order);
                    if (sum > Limits.MAX) {
                        this.name = order;
                    }
                    String name = "shadow";
                    return sum + name.length();
                }

                public void start(String tag) {
                    new Thread(() -> System.out.println(tag + recent.size())).start();
                }
            }
            """);
        Ir.Document doc = new JavaAnalyzer(dir).run(new Ir.Source("vars", "test", "main", new Ir.Analyzer("java", "test"), null));
        nodes = doc.nodes().stream().collect(Collectors.toMap(n -> n.id, n -> n));
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> variable(String fn, String scope, String name) {
        List<Map<String, Object>> vars = (List<Map<String, Object>>) nodes.get(fn).attrs.get("variables");
        assertNotNull(vars, fn + " has no variables");
        return vars.stream().filter(v -> v.get("name").equals(name) && v.get("scope").equals(scope)).findFirst().orElse(null);
    }

    static final String ADD = "method:demo.Counter#add(String,int)";

    @Test
    void ownParamsAndLocals() {
        assertEquals("int", variable(ADD, "param", "qty").get("type"));
        assertEquals("int", variable(ADD, "local", "sum").get("type"));
        assertEquals(1, variable(ADD, "local", "name").get("reads")); // the local shadowing the field
    }

    @Test
    void stateDeclaredOutsideTheFunction() {
        Map<String, Object> total = variable(ADD, "static", "total");
        assertEquals("field:demo.Counter#total", total.get("declaredIn"));
        assertEquals(1, total.get("writes"));
        assertEquals(List.of(19), total.get("lines"));
        assertEquals(List.of(19), total.get("writeLines"));
        Map<String, Object> recent = variable(ADD, "field", "recent");
        assertEquals(true, recent.get("final"));
        assertEquals(1, recent.get("writes")); // recent.add(...) changes it
        Map<String, Object> name = variable(ADD, "field", "name");
        assertEquals(1, name.get("writes"));
        Map<String, Object> max = variable(ADD, "static", "Limits.MAX");
        assertEquals("field:demo.Limits#MAX", max.get("declaredIn"));
        assertEquals(true, max.get("final"));
        assertEquals(1, max.get("reads"));
    }

    @Test
    void lambdasCaptureFromTheirEnclosingFunction() {
        String lambda = nodes.keySet().stream().filter(id -> id.contains("#lambda@")).findFirst().orElseThrow();
        Map<String, Object> tag = variable(lambda, "captured", "tag");
        assertEquals("method:demo.Counter#start(String)", tag.get("declaredIn"));
        assertNotNull(variable(lambda, "field", "recent"));
        // the method that starts the thread does not list what only the lambda uses
        assertTrue(variable("method:demo.Counter#start(String)", "field", "recent") == null);
    }

    @Test
    void javadocSaysWhatItDoes() {
        assertEquals("Counts orders and remembers the last ones.", nodes.get("class:demo.Counter").attrs.get("doc"));
        assertEquals("Adds an order to the recent list.", nodes.get(ADD).attrs.get("doc"));
        assertFalse(nodes.get("method:demo.Counter#start(String)").attrs.containsKey("doc"));
    }
}
