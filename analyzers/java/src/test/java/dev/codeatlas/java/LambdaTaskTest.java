package dev.codeatlas.java;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.stream.Collectors;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** Lambdas handed to threads, executors, schedulers and HTTP servers become functions of their own. */
class LambdaTaskTest {

    @TempDir
    static Path dir;
    static Ir.Document doc;
    static Map<String, Ir.Node> nodes;

    @BeforeAll
    static void analyze() throws Exception {
        Path src = dir.resolve("src/main/java/demo");
        Files.createDirectories(src);
        Files.writeString(dir.resolve("pom.xml"), "<project><artifactId>jobs</artifactId></project>");
        Files.writeString(src.resolve("Jobs.java"), """
            package demo;

            import com.sun.net.httpserver.HttpServer;
            import java.net.InetSocketAddress;
            import java.util.concurrent.*;

            public class Jobs {
                private final ExecutorService pool = Executors.newFixedThreadPool(2);
                private final ScheduledExecutorService timer = Executors.newScheduledThreadPool(1);

                public void start() throws Exception {
                    new Thread(() -> drain()).start();
                    pool.submit(() -> {
                        if (ready()) {
                            drain();
                        }
                    });
                    timer.scheduleAtFixedRate(() -> sweep(), 0, 5, TimeUnit.SECONDS);
                    HttpServer server = HttpServer.create(new InetSocketAddress(8080), 0);
                    server.createContext("/ping", exchange -> reply());
                    server.start();
                }

                void drain() {}
                boolean ready() { return true; }
                void sweep() {}
                void reply() {}

                public static void main(String[] args) throws Exception {
                    new Jobs().start();
                }
            }
            """);
        doc = new JavaAnalyzer(dir).run(new Ir.Source("jobs", "test", "main", new Ir.Analyzer("java", "test"), null));
        nodes = doc.nodes().stream().collect(Collectors.toMap(n -> n.id, n -> n));
    }

    static Optional<Ir.Edge> edge(String source, String target, String kind) {
        return doc.edges().stream()
            .filter(e -> e.source.equals(source) && e.target.equals(target) && e.kind.equals(kind)).findFirst();
    }

    static String lambdaAt(int line) {
        return "method:demo.Jobs#lambda@" + line + "()";
    }

    @Test
    void lambdasGetTheirOwnNodes() {
        for (int line : new int[] {12, 13, 18, 20}) {
            Ir.Node n = nodes.get(lambdaAt(line));
            assertNotNull(n, "lambda at line " + line);
            assertEquals(true, n.attrs.get("lambda"));
            assertEquals("class:demo.Jobs", n.parent);
            assertEquals("method:demo.Jobs#start()", n.attrs.get("definedIn"));
        }
        assertEquals("λ thread (line 12)", nodes.get(lambdaAt(12)).name);
        assertEquals("λ handler /ping (line 20)", nodes.get(lambdaAt(20)).name);
    }

    @Test
    void callsInsideLambdasBelongToThem() {
        assertTrue(edge(lambdaAt(12), "method:demo.Jobs#drain()", "calls").isPresent());
        Ir.Edge guarded = edge(lambdaAt(13), "method:demo.Jobs#drain()", "calls").orElseThrow();
        assertEquals(List.of("if ready()"), guarded.attrs.get("conditions")); // guards stop at the lambda
        assertTrue(edge(lambdaAt(18), "method:demo.Jobs#sweep()", "calls").isPresent());
        // ...not to the method that registered them
        assertFalse(edge("method:demo.Jobs#start()", "method:demo.Jobs#drain()", "calls").isPresent());
        assertFalse(edge("method:demo.Jobs#start()", "method:demo.Jobs#sweep()", "calls").isPresent());
    }

    @Test
    void startsAreAsyncEdgesAndEntryPointsAreMarked() {
        assertEquals("thread", edge("method:demo.Jobs#start()", lambdaAt(12), "calls").orElseThrow().attrs.get("async"));
        assertEquals("executor", edge("method:demo.Jobs#start()", lambdaAt(13), "calls").orElseThrow().attrs.get("async"));
        assertEquals("scheduled", edge("method:demo.Jobs#start()", lambdaAt(18), "calls").orElseThrow().attrs.get("async"));
        assertEquals("scheduled", nodes.get(lambdaAt(18)).attrs.get("entryPoint"));
        assertTrue(edge("endpoint:jobs:ANY /ping", lambdaAt(20), "handles").isPresent());
    }

    @Test
    @SuppressWarnings("unchecked")
    void controlFlowIsSplitBetweenMethodAndLambdas() {
        List<Map<String, Object>> start = (List<Map<String, Object>>) nodes.get("method:demo.Jobs#start()").attrs.get("controlFlow");
        String targets = start.toString();
        assertFalse(targets.contains("Jobs#drain()"), "start() should not list calls made inside its lambdas");
        List<Map<String, Object>> task = (List<Map<String, Object>>) nodes.get(lambdaAt(13)).attrs.get("controlFlow");
        assertEquals("if", task.get(0).get("k"));
        assertEquals("ready()", task.get(0).get("cond"));
        List<Map<String, Object>> thread = (List<Map<String, Object>>) nodes.get(lambdaAt(12)).attrs.get("controlFlow");
        assertEquals("return", thread.get(0).get("k")); // expression lambda
    }
}
