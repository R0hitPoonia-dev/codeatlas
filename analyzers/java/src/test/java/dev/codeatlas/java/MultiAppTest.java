package dev.codeatlas.java;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * A repo holding several applications the way TT-dropcopy does: a Maven project keeping its
 * code straight in src/ (sourceDirectory set in the parent pom), apps talking over raw TCP,
 * Kafka settings read through a prop(key, default) helper, Redis channels built in a list.
 */
class MultiAppTest {

    @TempDir
    static Path dir;
    static Ir.Document doc;
    static Map<String, Ir.Node> nodes;

    static void write(String path, String text) throws Exception {
        Path p = dir.resolve(path);
        Files.createDirectories(p.getParent());
        Files.writeString(p, text);
    }

    @BeforeAll
    static void analyze() throws Exception {
        // a Maven parent whose modules keep sources in src/, like decoupled-pnljava-dropcopy
        write("pipeline/pom.xml", """
            <project><artifactId>pipeline</artifactId><packaging>pom</packaging>
              <modules><module>fill-server</module></modules>
              <build><sourceDirectory>src</sourceDirectory></build>
            </project>""");
        write("pipeline/fill-server/pom.xml", "<project><artifactId>fill-server</artifactId></project>");
        write("pipeline/fill-server/src/fill/Server.java", """
            package fill;

            import java.util.ArrayList;
            import java.util.List;
            import java.util.Properties;

            public class Server {
                private final Properties raw = new Properties();

                public static void main(String[] args) throws Exception {
                    new Server().start();
                }

                void start() throws Exception {
                    new io.netty.bootstrap.ServerBootstrap().bind(7001).sync();
                    Properties props = new Properties();
                    props.put("acks", prop("kafka.acks", "all"));
                    props.put("batch.size", prop("kafka.batch.size", "16384"));
                    String topic = prop("kafka.topic", "fills");
                    org.apache.kafka.clients.producer.KafkaProducer<String, String> producer = null;
                    producer.send(new org.apache.kafka.clients.producer.ProducerRecord<>(topic, "k", "v"));
                }

                void announce(redis.clients.jedis.Jedis jedis, String sym) {
                    List<String> channels = new ArrayList<>();
                    channels.add("fill:" + sym);
                    jedis.publish(channels.get(0), "x");
                }

                private String prop(String key, String def) {
                    String v = raw.getProperty(key);
                    return v != null && !v.isBlank() ? v.trim() : def;
                }
            }
            """);
        // an app in the standard layout that sends to fill-server and connects out to a venue
        write("dropcopy/pom.xml", "<project><artifactId>dropcopy</artifactId></project>");
        write("dropcopy/src/main/resources/dropcopy.cfg.example", "venue.host=<venue-host>\nsink.port=7001\n");
        write("dropcopy/src/main/java/dc/Cfg.java", """
            package dc;

            import java.util.Properties;

            public record Cfg(String venueHost, int venuePort, String sinkHost, int sinkPort) {
                static Cfg load(Properties p) {
                    return new Cfg(required(p, "venue.host"), integer(p, "venue.port", 9876),
                        str(p, "sink.host", "127.0.0.1"), integer(p, "sink.port", 6001));
                }

                private static String required(Properties p, String key) {
                    String v = str(p, key, "");
                    if (v.isBlank()) {
                        throw new IllegalArgumentException(key);
                    }
                    return v;
                }

                private static String str(Properties p, String key, String def) {
                    return p.getProperty(key, def).trim();
                }

                private static int integer(Properties p, String key, int def) {
                    return Integer.parseInt(p.getProperty(key, String.valueOf(def)));
                }
            }
            """);
        write("dropcopy/src/main/java/dc/Main.java", """
            package dc;

            import java.net.InetSocketAddress;
            import java.net.Socket;
            import javax.net.ssl.SSLSocketFactory;

            public class Main {
                private final Cfg cfg = Cfg.load(new java.util.Properties());

                public static void main(String[] args) throws Exception {
                    Main m = new Main();
                    m.sink();
                    m.venue();
                    m.prices();
                }

                void sink() throws Exception {
                    Socket socket = new Socket();
                    socket.connect(new InetSocketAddress(cfg.sinkHost(), cfg.sinkPort()), 1000);
                }

                void venue() throws Exception {
                    SSLSocketFactory f = (SSLSocketFactory) SSLSocketFactory.getDefault();
                    f.createSocket(cfg.venueHost(), cfg.venuePort());
                }

                void prices() throws Exception {
                    new Socket("prices.example.com", 9000);
                }
            }
            """);
        doc = new JavaAnalyzer(dir).run(new Ir.Source("multi", "test", "main", new Ir.Analyzer("java", "test"), null));
        nodes = doc.nodes().stream().collect(Collectors.toMap(n -> n.id, n -> n));
    }

    static boolean edge(String source, String target, String kind) {
        return doc.edges().stream().anyMatch(e -> e.source.equals(source) && e.target.equals(target) && e.kind.equals(kind));
    }

    @Test
    void findsModulesWithACustomSourceDirectory() {
        Ir.Node server = nodes.get("svc:fill-server");
        assertNotNull(server, "fill-server (sources in src/ via the parent's sourceDirectory)");
        assertEquals("pipeline/fill-server", server.attrs.get("path"));
        assertNotNull(nodes.get("class:fill.Server"));
        assertNotNull(nodes.get("svc:dropcopy"));
        assertFalse(nodes.containsKey("svc:pipeline"), "the aggregator pom has no code of its own");
    }

    @Test
    void outgoingConnectionReachesTheAppServingThatPort() {
        // cfg.sinkPort() -> record component -> integer(p, "sink.port", 6001) -> 7001 from the example config
        assertTrue(edge("method:dc.Main#sink()", "endpoint:fill-server:TCP :7001", "connects_to"));
    }

    @Test
    void outgoingConnectionsToOtherSystemsAreExternal() {
        Ir.Node venue = nodes.get("ext:tcp:venue-host:9876");
        assertNotNull(venue, "host from the example config, placeholder brackets dropped; port from the code default");
        assertTrue(edge("method:dc.Main#venue()", venue.id, "connects_to"));
        assertTrue(edge("method:dc.Main#prices()", "ext:tcp:prices.example.com:9000", "connects_to"));
        assertEquals("tcp", nodes.get("ext:tcp:prices.example.com:9000").attrs.get("protocol"));
    }

    @Test
    void helperDefaultsBelongToTheirOwnCall() {
        Set<String> topics = doc.nodes().stream().filter(n -> n.kind.equals("topic")).map(n -> n.name).collect(Collectors.toSet());
        assertTrue(topics.contains("fills"));
        assertFalse(topics.contains("all"), "kafka.acks default is not a topic");
        assertFalse(topics.contains("16384"));
    }

    @Test
    void channelsReadBackFromAListKeepTheirName() {
        assertTrue(doc.edges().stream().anyMatch(e -> e.source.startsWith("method:fill.Server#announce(")
            && e.target.equals("topic:redis:fill:*") && e.kind.equals("publishes")));
    }
}
