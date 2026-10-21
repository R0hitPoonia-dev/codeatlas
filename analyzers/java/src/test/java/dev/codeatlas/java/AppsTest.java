package dev.codeatlas.java;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.stream.Collectors;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * A module that builds several programs stays one module of code, and each program is its own
 * service. One program keeps the old shape: the module is the service.
 */
class AppsTest {

    @TempDir
    Path dir;

    @Test
    void twoShadedJarsAreTwoServicesOverOneModule() throws Exception {
        write("pom.xml", """
            <project>
              <artifactId>livepnl</artifactId><version>1.2</version>
              <build><plugins>
                <plugin><artifactId>maven-shade-plugin</artifactId><executions>
                  <execution><configuration>
                    <shadedArtifactAttached>true</shadedArtifactAttached>
                    <shadedClassifierName>producer</shadedClassifierName>
                    <transformers><transformer implementation="org.apache.maven.plugins.shade.resource.ManifestResourceTransformer">
                      <mainClass>producer.Main</mainClass>
                    </transformer></transformers>
                  </configuration></execution>
                  <execution><configuration>
                    <shadedArtifactAttached>true</shadedArtifactAttached>
                    <shadedClassifierName>consumer</shadedClassifierName>
                    <transformers><transformer implementation="org.apache.maven.plugins.shade.resource.ManifestResourceTransformer">
                      <mainClass>consumer.Main</mainClass>
                    </transformer></transformers>
                  </configuration></execution>
                </executions></plugin>
                <plugin><artifactId>maven-antrun-plugin</artifactId><executions><execution><configuration><target>
                  <move file="${project.build.directory}/${project.build.finalName}-producer.jar" tofile="${project.build.directory}/producer-${project.version}.jar"/>
                  <move file="${project.build.directory}/${project.build.finalName}-consumer.jar" tofile="${project.build.directory}/consumer-${project.version}.jar"/>
                </target></configuration></execution></executions></plugin>
              </plugins></build>
            </project>
            """);
        write("src/main/java/producer/Main.java", """
            package producer;
            public class Main {
                public static void main(String[] args) { send(); }
                static void send() {}
            }
            """);
        write("src/main/java/consumer/Main.java", """
            package consumer;
            public class Main {
                public static void main(String[] args) { take(); }
                static void take() {}
            }
            """);
        write("src/main/java/tools/NotPacked.java", """
            package tools;
            public class NotPacked {
                public static void main(String[] args) {}
            }
            """);
        Map<String, Ir.Node> nodes = analyze();

        assertEquals("module", nodes.get("mod:livepnl").kind);
        assertNull(nodes.get("svc:livepnl"), "the shared code is not itself a program");
        Ir.Node producer = nodes.get("svc:livepnl-producer");
        assertNotNull(producer);
        assertEquals("producer.Main", producer.attrs.get("mainClass"));
        assertEquals("producer-1.2.jar", producer.attrs.get("jar"));
        assertEquals("maven-shade", producer.attrs.get("launch"));
        assertEquals("mod:livepnl", producer.attrs.get("module"));
        assertEquals("livepnl-consumer", nodes.get("svc:livepnl-consumer").name);
        assertEquals("consumer-1.2.jar", nodes.get("svc:livepnl-consumer").attrs.get("jar"));

        assertTrue(runs("svc:livepnl-producer", "method:producer.Main#main(String[])"));
        assertTrue(runs("svc:livepnl-consumer", "method:consumer.Main#main(String[])"));
        assertEquals("mod:livepnl", nodes.get("pkg:producer").parent, "the code stays in the module");
        assertNull(nodes.get("method:producer.Main#main(String[])").attrs.get("packaged"));
        assertEquals(false, nodes.get("method:tools.NotPacked#main(String[])").attrs.get("packaged"));
        assertEquals("main", nodes.get("method:tools.NotPacked#main(String[])").attrs.get("entryPoint"));
    }

    @Test
    void oneSpringBootClassStaysOneService() throws Exception {
        write("pom.xml", "<project><artifactId>orders</artifactId></project>");
        write("src/main/java/com/acme/OrdersApplication.java", """
            package com.acme;
            @SpringBootApplication
            public class OrdersApplication {
                public static void main(String[] args) {}
            }
            """);
        Map<String, Ir.Node> nodes = analyze();
        Ir.Node svc = nodes.get("svc:orders");
        assertNotNull(svc);
        assertEquals("service", svc.kind);
        assertEquals("com.acme.OrdersApplication", svc.attrs.get("mainClass"));
        assertEquals("spring-boot", svc.attrs.get("launch"));
        assertNull(svc.attrs.get("module"));
        assertNull(nodes.get("mod:orders"));
        assertTrue(runs("svc:orders", "method:com.acme.OrdersApplication#main(String[])"));
    }

    @Test
    void aNamedSubclassRunsTheMainItInherits() throws Exception {
        write("pom.xml", """
            <project><artifactId>app</artifactId><version>1</version>
              <build><plugins><plugin><artifactId>maven-jar-plugin</artifactId>
                <configuration><archive><manifest><mainClass>app.App</mainClass></manifest></archive></configuration>
              </plugin></plugins></build>
            </project>
            """);
        write("src/main/java/base/Base.java", """
            package base;
            public class Base {
                public static void main(String[] args) {}
            }
            """);
        write("src/main/java/app/App.java", """
            package app;
            public class App extends base.Base {}
            """);
        Map<String, Ir.Node> nodes = analyze();
        assertEquals("app.App", nodes.get("svc:app").attrs.get("mainClass"));
        assertTrue(runs("svc:app", "method:base.Base#main(String[])"), "java App runs Base.main");
        assertEquals("main", nodes.get("method:base.Base#main(String[])").attrs.get("entryPoint"));
    }

    @Test
    void mainsTheLauncherAcceptsEachBecomeAProgram() throws Exception {
        write("src/NoArg.java", "public class NoArg { public static void main() {} }");
        write("src/Instance.java", "public class Instance { void main(String[] args) {} }");
        write("src/VarArgs.java", "public class VarArgs { public static void main(String... args) {} }");
        write("src/Hidden.java", "public class Hidden { private static void main(String[] args) {} }");
        Map<String, Ir.Node> nodes = analyze();
        String mod = "mod:" + dir.getFileName();
        assertNotNull(nodes.get(mod), "no build file: the directory is the module");
        assertNotNull(nodes.get("svc:" + dir.getFileName() + "-no-arg"));
        assertNotNull(nodes.get("svc:" + dir.getFileName() + "-instance"));
        assertNotNull(nodes.get("svc:" + dir.getFileName() + "-var-args"));
        assertTrue(nodes.values().stream().noneMatch(n -> "Hidden".equals(n.attrs.get("mainClass"))));
        assertNull(nodes.get("method:Hidden#main(String[])").attrs.get("entryPoint"));
        assertTrue(runs("svc:" + dir.getFileName() + "-no-arg", "method:NoArg#main()"));
        assertTrue(runs("svc:" + dir.getFileName() + "-var-args", "method:VarArgs#main(String...)"));
    }

    @Test
    @SuppressWarnings("unchecked")
    void aKeyBothProgramsDefineIsReadFromTheFileItsOwnProgramLoads() throws Exception {
        write("pom.xml", "<project><artifactId>livepnl</artifactId></project>");
        write("src/main/resources/producer.config", "kafka.bootstrap.servers=broker:9092\nkafka.acks=all\n");
        write("src/main/resources/consumer.config", "kafka.bootstrap.servers=broker:9092\nkafka.group.id=g\n");
        write("src/main/java/producer/Main.java", """
            package producer;
            public class Main {
                public static void main(String[] args) throws Exception {
                    java.util.Properties p = new java.util.Properties();
                    p.load(Main.class.getResourceAsStream("/producer.config"));
                    new producer.kafka.KafkaConfig(p);
                }
            }
            """);
        write("src/main/java/producer/kafka/KafkaConfig.java", """
            package producer.kafka;
            public class KafkaConfig {
                public KafkaConfig(java.util.Properties p) { String s = p.getProperty("kafka.bootstrap.servers"); }
            }
            """);
        write("src/main/java/consumer/kafka/Settings.java", """
            package consumer.kafka;
            public class Settings {
                String servers(java.util.Properties p) { return p.getProperty("kafka.bootstrap.servers"); }
            }
            """);
        Map<String, Ir.Node> nodes = analyze();
        java.util.function.Function<String, java.util.List<Map<String, Object>>> reads = prefix -> (java.util.List<Map<String, Object>>)
            nodes.values().stream().filter(n -> n.id.startsWith(prefix)).findFirst().orElseThrow().attrs.get("configReads");
        var producer = reads.apply("method:producer.kafka.KafkaConfig#<init>(");
        assertEquals("producer.config", producer.get(0).get("file"), "producer.Main loads producer.config");
        var consumer = reads.apply("method:consumer.kafka.Settings#servers(");
        assertEquals("consumer.config", consumer.get(0).get("file"), "the consumer package matches consumer.config");
    }

    private Ir.Document doc;

    private Map<String, Ir.Node> analyze() throws Exception {
        doc = new JavaAnalyzer(dir).run(new Ir.Source("apps", "test", "main", new Ir.Analyzer("java", "test"), null));
        return doc.nodes().stream().collect(Collectors.toMap(n -> n.id, n -> n));
    }

    private boolean runs(String service, String main) {
        return doc.edges().stream().anyMatch(e -> e.source.equals(service) && e.target.equals(main) && e.kind.equals("runs"));
    }

    private void write(String path, String text) throws Exception {
        Path p = dir.resolve(path);
        Files.createDirectories(p.getParent());
        Files.writeString(p, text);
    }
}
