package dev.codeatlas.java;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.stream.Collectors;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/** Runs the analyzer over demo/ledger, a plain-Java (no Spring) system, and checks its I/O. */
class PlainJavaTest {

    static Ir.Document doc;
    static Map<String, Ir.Node> nodes;

    static final String P = "com.acme.ledger.";

    @BeforeAll
    static void analyze() throws Exception {
        Path ledger = Path.of("../../demo/ledger").toAbsolutePath().normalize();
        doc = new JavaAnalyzer(ledger).run(new Ir.Source("ledger", "test", "main", new Ir.Analyzer("java", "test"), null));
        nodes = doc.nodes().stream().collect(Collectors.toMap(n -> n.id, n -> n));
    }

    static Optional<Ir.Edge> edge(String source, String target, String kind) {
        return doc.edges().stream()
            .filter(e -> e.source.equals(source) && e.target.equals(target) && e.kind.equals(kind)).findFirst();
    }

    static Ir.Edge mustEdge(String source, String target, String kind) {
        return edge(source, target, kind).orElseThrow(() -> new AssertionError(kind + " edge " + source + " -> " + target));
    }

    static Set<String> targets(String source, String kind) {
        return doc.edges().stream().filter(e -> e.source.equals(source) && e.kind.equals(kind))
            .map(e -> e.target).collect(Collectors.toSet());
    }

    @Test
    @SuppressWarnings("unchecked")
    void everyReferenceResolves() {
        for (Ir.Edge e : doc.edges()) {
            assertTrue(nodes.containsKey(e.source) && nodes.containsKey(e.target), "dangling edge " + e.source + " -> " + e.target);
        }
    }

    @Test
    @SuppressWarnings("unchecked")
    void kafkaConsumersThroughAWrapper() {
        // TopicReader(props, topic) subscribes; each thread passes its own TOPIC constant
        String run = "method:" + P + "processor.threads.TradeConsumerThread#run()";
        Ir.Edge e = mustEdge(run, "topic:trades", "consumes");
        assertEquals(List.of("method:" + P + "processor.kafka.TopicReader#<init>(Properties,String)"), e.attrs.get("via"));
        assertEquals("Trade", ((List<Map<String, Object>>) e.attrs.get("payloads")).get(0).get("type")); // Trade.parse(record.value())
        assertEquals(Set.of("topic:trades"), targets(run, "consumes"));
        assertEquals(Set.of("topic:quotes"), targets("method:" + P + "processor.threads.QuoteConsumerThread#run()", "consumes"));
        // the wrapper itself is not credited with every topic
        assertTrue(targets("method:" + P + "processor.kafka.TopicReader#<init>(Properties,String)", "consumes").isEmpty());
    }

    @Test
    void kafkaProducerTopicsFromConfig() {
        // topic = routes.get(type), filled from topic.route.<n> keys
        String publish = "method:" + P + "gateway.EventPublisher#publish(int,String,byte[])";
        assertEquals(Set.of("topic:trades", "topic:quotes"), targets(publish, "publishes"));
        Ir.Edge e = mustEdge(publish, "topic:trades", "publishes");
        assertEquals("config", e.attrs.get("inferred"));
        assertEquals(List.of("topic.route.1"), e.attrs.get("configKeys"));
    }

    @Test
    @SuppressWarnings("unchecked")
    void jdbcTablesFromSqlText() {
        Ir.Node db = nodes.get("db:ledger-db/ledger");
        assertNotNull(db, "database from db.url=jdbc:postgresql://ledger-db:5432/ledger");
        assertEquals("postgresql", db.otel.get("db.system"));

        // "INSERT INTO " + tableName + ..., tableName from config via the constructor
        String insert = "method:" + P + "processor.db.TradeWriter#insert(List)";
        Ir.Edge w = mustEdge(insert, "table:ledger-db/ledger.trade_book", "writes");
        assertEquals(List.of("INSERT"), w.attrs.get("operations"));
        Map<String, Object> row = ((List<Map<String, Object>>) w.attrs.get("payloads")).get(0);
        assertEquals(List.of("trade_id", "account_id", "account_email", "symbol", "quantity", "price"), row.get("fields"));
        assertEquals("table:ledger-db/ledger.trade_book", nodes.get("table:ledger-db/ledger.trade_book").id);
        assertEquals(6, ((List<?>) nodes.get("table:ledger-db/ledger.trade_book").attrs.get("columns")).size());

        mustEdge("method:" + P + "processor.db.TradeWriter#truncate()", "table:ledger-db/ledger.trade_book", "writes");
        Ir.Edge r = mustEdge("method:" + P + "processor.db.AccountDirectory#reload()", "table:ledger-db/ledger.accounts", "reads");
        assertEquals(List.of("SELECT"), r.attrs.get("operations"));
        // a value stored in a field is configuration: main decides the name but does not write
        assertTrue(edge("method:" + P + "processor.ProcessorMain#main(String[])", "table:ledger-db/ledger.trade_book", "writes").isEmpty());
    }

    @Test
    void redisKeysAndChannels() {
        String publish = "method:" + P + "processor.cache.SnapshotPublisher#publish(Position,String)";
        Ir.Node redis = nodes.get("db:redis/ledger-cache");
        assertEquals("redis", redis.otel.get("db.system"));
        Ir.Node key = nodes.get("table:redis/ledger-cache.position:*:*");
        assertNotNull(key, "key pattern from \"position:\" + id + \":\" + symbol");
        assertEquals(true, key.attrs.get("keyPattern"));
        mustEdge(publish, key.id, "writes");
        assertEquals("set", nodes.get("table:redis/ledger-cache.symbols").attrs.get("redisType"));
        Ir.Node channel = nodes.get("topic:redis:positions");
        assertEquals("positions", channel.name);
        assertEquals("redis", channel.otel.get("messaging.system"));
        mustEdge(publish, channel.id, "publishes");
        mustEdge("method:" + P + "processor.cache.SnapshotPublisher#latest(String,String)", key.id, "reads");
    }

    @Test
    void socketAndHttpEntryPoints() {
        // two Netty servers on ports from gateway.properties, both handled by PacketHandler
        String handler = "method:" + P + "gateway.PacketHandler#channelRead0(ChannelHandlerContext,ByteBuf)";
        for (String port : List.of("7001", "7002")) {
            Ir.Node ep = nodes.get("endpoint:ledger:TCP :" + port);
            assertNotNull(ep, "TCP endpoint on " + port);
            assertEquals("tcp", ep.attrs.get("protocol"));
            assertEquals(port, ep.otel.get("server.port"));
            mustEdge(ep.id, handler, "handles");
        }
        Ir.Node positions = nodes.get("endpoint:ledger:ANY /positions");
        assertEquals("jdk-httpserver", positions.attrs.get("framework"));
        mustEdge(positions.id, "method:" + P + "processor.http.PositionsHandler#handle(HttpExchange)", "handles");
        assertNotNull(nodes.get("endpoint:ledger:ANY /health")); // lambda handler: no handles edge
    }

    @Test
    void entryPointsBeyondHttp() {
        assertEquals("main", nodes.get("method:" + P + "processor.ProcessorMain#main(String[])").attrs.get("entryPoint"));
        assertEquals("thread", nodes.get("method:" + P + "processor.threads.TradeConsumer#run()").attrs.get("entryPoint"));
        assertEquals("thread", nodes.get("method:" + P + "processor.threads.TradeConsumerThread#run()").attrs.get("entryPoint"));
        Ir.Node snapshot = nodes.get("method:" + P + "processor.SnapshotJob#run()");
        assertEquals("scheduled", snapshot.attrs.get("entryPoint")); // scheduleAtFixedRate(new SnapshotJob(...))
        assertEquals("scheduled", nodes.get("method:" + P + "processor.db.AccountDirectory#reload()").attrs.get("entryPoint")); // accounts::reload
        assertNull(nodes.get("method:" + P + "processor.engine.PositionBook#apply(Trade)").attrs.get("entryPoint"));
    }

    @Test
    void controlFlowShowsTheConsumeAtTheCallSite() {
        Map<String, Object> run = nodes.get("method:" + P + "processor.threads.TradeConsumerThread#run()").attrs;
        String cf = String.valueOf(run.get("controlFlow"));
        assertTrue(cf.contains("consumes") && cf.contains("topic:trades"), cf);
        assertFalse(cf.isEmpty());
    }

    @Test
    void mainStartsThreadsJobsAndServers() {
        String main = "method:" + P + "processor.ProcessorMain#main(String[])";
        Ir.Edge batched = mustEdge(main, "method:" + P + "processor.threads.TradeConsumerThread#run()", "calls");
        assertEquals("thread", batched.attrs.get("async"));
        assertEquals(List.of("if Boolean.parseBoolean(config.getProperty(\"batching\", \"true\"))"), batched.attrs.get("conditions"));
        // new Thread(new TradeConsumer(...)): the runnable runs on the new thread
        assertEquals("thread", mustEdge(main, "method:" + P + "processor.threads.TradeConsumer#run()", "calls").attrs.get("async"));
        assertEquals("scheduled", mustEdge(main, "method:" + P + "processor.SnapshotJob#run()", "calls").attrs.get("async"));
        assertEquals("scheduled", mustEdge(main, "method:" + P + "processor.db.AccountDirectory#reload()", "calls").attrs.get("async"));
        assertEquals("shutdown", mustEdge("method:" + P + "gateway.GatewayMain#main(String[])",
            "method:" + P + "gateway.EventPublisher#close()", "calls").attrs.get("async"));
        // plain calls stay synchronous
        assertNull(mustEdge(main, "method:" + P + "processor.db.TradeWriter#truncate()", "calls").attrs.get("async"));

        assertEquals(List.of("method:" + P + "gateway.PacketServer#start()"), nodes.get("endpoint:ledger:TCP :7001").attrs.get("openedBy"));
        assertEquals(List.of("method:" + P + "processor.http.StatusServer#<init>(int,PositionBook)"),
            nodes.get("endpoint:ledger:ANY /positions").attrs.get("openedBy"));
    }
}
