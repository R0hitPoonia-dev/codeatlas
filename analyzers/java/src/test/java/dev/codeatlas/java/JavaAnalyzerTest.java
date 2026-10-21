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

/** Runs the analyzer over demo/shop and checks the facts each rule should extract. */
class JavaAnalyzerTest {

    static Ir.Document doc;
    static Map<String, Ir.Node> nodes;

    @BeforeAll
    static void analyze() throws Exception {
        Path shop = Path.of("../../demo/shop").toAbsolutePath().normalize();
        doc = new JavaAnalyzer(shop).run(new Ir.Source("shop", "test", "main", new Ir.Analyzer("java", "test"), null));
        nodes = doc.nodes().stream().collect(Collectors.toMap(n -> n.id, n -> n));
    }

    static Optional<Ir.Edge> edge(String source, String target, String kind) {
        return doc.edges().stream()
            .filter(e -> e.source.equals(source) && e.target.equals(target) && e.kind.equals(kind)).findFirst();
    }

    static void assertEdge(String source, String target, String kind) {
        assertTrue(edge(source, target, kind).isPresent(), kind + " edge " + source + " -> " + target);
    }

    @Test
    void everyReferenceResolves() {
        for (Ir.Edge e : doc.edges()) {
            assertTrue(nodes.containsKey(e.source) && nodes.containsKey(e.target), "dangling edge " + e.source + " -> " + e.target);
        }
        for (Ir.Node n : doc.nodes()) {
            assertTrue(n.parent == null || nodes.containsKey(n.parent), "dangling parent of " + n.id);
        }
    }

    @Test
    void servicesFromSpringBootModules() {
        Ir.Node orders = nodes.get("svc:orders-service");
        assertNotNull(orders);
        assertEquals("orders", orders.attrs.get("path"));
        assertEquals("orders-service", orders.otel.get("service.name"));
        assertNotNull(nodes.get("svc:inventory-service"));
        assertEquals("svc:orders-service", nodes.get("pkg:com.acme.orders.api").parent);
    }

    @Test
    void typesAndMembers() {
        Ir.Node order = nodes.get("class:com.acme.orders.domain.Order");
        assertEquals("Entity", order.attrs.get("stereotype"));
        assertEquals("pkg:com.acme.orders.domain", order.parent);
        assertEquals("orders/src/main/java/com/acme/orders/domain/Order.java", order.location.file());

        Ir.Node find = nodes.get("method:com.acme.orders.service.OrderService#find(long)");
        assertEquals("com.acme.orders.service.OrderService", find.otel.get("code.namespace"));
        assertEquals("find", find.otel.get("code.function"));
        assertEquals("Order", find.attrs.get("returnType"));

        assertEquals("interface", nodes.get("class:com.acme.orders.domain.OrderRepository").kind);
        assertEquals(List.of("NEW", "PAID", "CANCELLED"), nodes.get("class:com.acme.orders.domain.OrderStatus").attrs.get("values"));
        assertEquals(true, nodes.get("class:com.acme.orders.api.CreateOrderRequest").attrs.get("record"));
        assertNotNull(nodes.get("field:com.acme.orders.api.CreateOrderRequest#customerEmail"));
    }

    @Test
    void inheritanceAndAssociations() {
        assertEdge("class:com.acme.orders.domain.Order", "class:com.acme.orders.domain.BaseEntity", "extends");
        Ir.Edge lines = edge("class:com.acme.orders.domain.Order", "class:com.acme.orders.domain.OrderLine", "references").orElseThrow();
        assertEquals(true, lines.attrs.get("many"));
        assertEquals(List.of("lines"), lines.attrs.get("fields"));
        // library supertypes are kept as labels
        assertEquals(List.of("JpaRepository<Order,Long>"),
            nodes.get("class:com.acme.orders.domain.OrderRepository").attrs.get("extends"));
    }

    @Test
    void callGraph() {
        assertEdge("method:com.acme.orders.api.OrderController#getOrder(long)",
            "method:com.acme.orders.service.OrderService#find(long)", "calls");
        // interface call (Feign client) and a call inside a lambda
        assertEdge("method:com.acme.orders.service.OrderService#place(Order,String)",
            "method:com.acme.orders.client.InventoryClient#reserve(String,int)", "calls");
        assertEdge("method:com.acme.orders.service.OrderService#find(long)",
            "method:com.acme.orders.service.OrderNotFoundException#<init>(long)", "calls");
        Ir.Edge e = edge("method:com.acme.orders.api.OrderController#getOrder(long)",
            "method:com.acme.orders.service.OrderService#find(long)", "calls").orElseThrow();
        assertEquals(19, e.locations.get(0).startLine());
    }

    @Test
    void packageDependencies() {
        assertEdge("pkg:com.acme.orders.api", "pkg:com.acme.orders.service", "depends_on");
        assertEdge("pkg:com.acme.orders.service", "pkg:com.acme.orders.domain", "depends_on");
        assertFalse(edge("pkg:com.acme.orders.domain", "pkg:com.acme.orders.api", "depends_on").isPresent());
    }

    @Test
    void endpoints() {
        Ir.Node get = nodes.get("endpoint:orders-service:GET /orders/{id}");
        assertEquals("/orders/{id}", get.otel.get("http.route"));
        assertEquals("GET", get.otel.get("http.request.method"));
        assertEquals("svc:orders-service", get.parent);
        assertEdge(get.id, "method:com.acme.orders.api.OrderController#getOrder(long)", "handles");
        // @RequestMapping(value=..., method=RequestMethod.POST)
        assertNotNull(nodes.get("endpoint:orders-service:POST /orders/{id}/cancel"));
        assertNotNull(nodes.get("endpoint:orders-service:POST /orders"));
        // Feign interfaces are clients, not endpoints
        assertNull(nodes.get("endpoint:orders-service:POST /reservations"));
    }

    @Test
    @SuppressWarnings("unchecked")
    void jpaTables() {
        Ir.Node orders = nodes.get("table:orders-db/orders.orders");
        assertEquals("db:orders-db/orders", orders.parent);
        List<Map<String, Object>> cols = (List<Map<String, Object>>) orders.attrs.get("columns");
        Set<String> names = cols.stream().map(c -> (String) c.get("name")).collect(Collectors.toSet());
        // inherited from @MappedSuperclass; @Transient and @OneToMany(mappedBy) excluded
        assertEquals(Set.of("id", "created_at", "customer_email", "status", "total", "customer_id"), names);
        assertEquals("postgresql", nodes.get("db:orders-db/orders").otel.get("db.system"));
        assertEquals("orders-db", nodes.get("db:orders-db/orders").attrs.get("host"));

        assertNotNull(nodes.get("table:orders-db/orders.order_line")); // default snake_case name
        Ir.Edge fk = edge("table:orders-db/orders.order_line", "table:orders-db/orders.orders", "references").orElseThrow();
        assertEquals("order_id", fk.attrs.get("column"));
        assertEquals("many-to-one", fk.attrs.get("cardinality"));
    }

    @Test
    void springDataAccess() {
        String find = "method:com.acme.orders.service.OrderService#find(long)";
        assertEquals(List.of("findById"), edge(find, "table:orders-db/orders.orders", "reads").orElseThrow().attrs.get("operations"));
        assertEdge("method:com.acme.orders.service.OrderService#place(Order,String)", "table:orders-db/orders.orders", "writes");
        assertEdge("method:com.acme.inventory.StockService#reserve(String,int)", "table:inventory-db/inventory.stock_items", "reads");
    }

    @Test
    void messaging() {
        assertEdge("method:com.acme.orders.service.OrderService#place(Order,String)", "topic:order-events", "publishes");
        assertEdge("method:com.acme.orders.events.PaymentEventsListener#onPayment(PaymentEvent)", "topic:payment-events", "consumes");
        assertEquals("kafka", nodes.get("topic:order-events").otel.get("messaging.system"));
    }

    @Test
    void outboundHttp() {
        Ir.Edge rest = edge("method:com.acme.orders.service.OrderService#place(Order,String)", "ext:payments.example.com", "http_calls").orElseThrow();
        assertEquals("POST", rest.attrs.get("method"));
        assertEquals("/v1/charges", rest.attrs.get("path"));
        Ir.Edge feign = edge("method:com.acme.orders.client.InventoryClient#reserve(String,int)", "ext:inventory-service", "http_calls").orElseThrow();
        assertEquals("/reservations", feign.attrs.get("path"));
    }

    @Test
    @SuppressWarnings("unchecked")
    void endpointDataTypes() {
        Ir.Node create = nodes.get("endpoint:orders-service:POST /orders");
        assertEquals("class:com.acme.orders.api.CreateOrderRequest", ((Map<String, Object>) create.attrs.get("request")).get("typeId"));
        assertEquals("Order", ((Map<String, Object>) create.attrs.get("response")).get("type"));
        Ir.Node get = nodes.get("endpoint:orders-service:GET /orders/{id}");
        assertEquals(List.of(Map.of("name", "id", "type", "long", "in", "path")), get.attrs.get("inputs"));
        assertNull(nodes.get("endpoint:orders-service:POST /orders/{id}/cancel").attrs.get("response")); // void
    }

    @Test
    @SuppressWarnings("unchecked")
    void payloadTypes() {
        String place = "method:com.acme.orders.service.OrderService#place(Order,String)";
        Ir.Edge charge = edge(place, "ext:payments.example.com", "http_calls").orElseThrow();
        assertEquals("ChargeRequest", ((List<Map<String, Object>>) charge.attrs.get("payloads")).get(0).get("type"));
        assertEquals("ChargeResponse", ((List<Map<String, Object>>) charge.attrs.get("responses")).get(0).get("type"));
        Ir.Edge event = edge(place, "topic:order-events", "publishes").orElseThrow();
        assertEquals("class:com.acme.orders.events.OrderPlacedEvent",
            ((List<Map<String, Object>>) event.attrs.get("payloads")).get(0).get("typeId"));
        Ir.Edge consumed = edge("method:com.acme.orders.events.PaymentEventsListener#onPayment(PaymentEvent)",
            "topic:payment-events", "consumes").orElseThrow();
        assertEquals("PaymentEvent", ((List<Map<String, Object>>) consumed.attrs.get("payloads")).get(0).get("type"));
        Ir.Edge read = edge("method:com.acme.orders.service.OrderService#find(long)", "table:orders-db/orders.orders", "reads").orElseThrow();
        assertEquals("Order", ((List<Map<String, Object>>) read.attrs.get("responses")).get(0).get("type"));
    }

    @Test
    void conditions() {
        String place = "method:com.acme.orders.service.OrderService#place(Order,String)";
        Ir.Edge reserve = edge(place, "method:com.acme.orders.client.InventoryClient#reserve(String,int)", "calls").orElseThrow();
        assertEquals(List.of("for each line in order.getLines()"), reserve.attrs.get("conditions"));
        assertNull(reserve.attrs.get("unconditional"));
        Ir.Edge paid = edge(place, "method:com.acme.orders.domain.Order#markPaid()", "calls").orElseThrow();
        assertEquals(List.of("if result != null && result.approved()"), paid.attrs.get("conditions"));
        assertEquals(true, edge(place, "table:orders-db/orders.orders", "writes").orElseThrow().attrs.get("unconditional"));
        Ir.Edge refund = edge("method:com.acme.orders.service.OrderService#cancel(long)", "ext:payments.example.com", "http_calls").orElseThrow();
        assertEquals(List.of("if order.isPaid()"), refund.attrs.get("conditions"));
        // else-if chains keep the negated outer condition; resolved even though the argument type isn't
        Ir.Edge cancel = edge("method:com.acme.orders.events.PaymentEventsListener#onPayment(PaymentEvent)",
            "method:com.acme.orders.service.OrderService#cancel(long)", "calls").orElseThrow();
        assertEquals(List.of("if not (\"PAID\".equals(event.status())) › if \"FAILED\".equals(event.status())"),
            cancel.attrs.get("conditions"));
        assertEquals(List.of("if empty"), edge("method:com.acme.orders.service.OrderService#find(long)",
            "method:com.acme.orders.service.OrderNotFoundException#<init>(long)", "calls").orElseThrow().attrs.get("conditions"));
    }

    @SuppressWarnings("unchecked")
    static List<Map<String, Object>> cf(String methodId) {
        return (List<Map<String, Object>>) nodes.get(methodId).attrs.get("controlFlow");
    }

    @Test
    @SuppressWarnings("unchecked")
    void controlFlowStructure() {
        List<Map<String, Object>> place = cf("method:com.acme.orders.service.OrderService#place(Order,String)");
        assertEquals(List.of("loop", "do", "if", "do", "return"), place.stream().map(s -> s.get("k")).toList());
        Map<String, Object> loop = place.get(0);
        assertEquals("for each line in order.getLines()", loop.get("text"));
        assertEquals("method:com.acme.orders.domain.Order#getLines()",
            ((List<Map<String, Object>>) loop.get("calls")).get(0).get("target")); // the iterable is evaluated first
        Map<String, Object> decision = place.get(2);
        assertEquals("result != null && result.approved()", decision.get("cond"));
        assertNull(decision.get("else"));

        // else-if chains nest: if PAID ... else { if FAILED ... }
        List<Map<String, Object>> onPayment = cf("method:com.acme.orders.events.PaymentEventsListener#onPayment(PaymentEvent)");
        Map<String, Object> outer = onPayment.get(0);
        List<Map<String, Object>> elseBranch = (List<Map<String, Object>>) outer.get("else");
        assertEquals("if", elseBranch.get(0).get("k"));
        assertEquals("\"FAILED\".equals(event.status())", elseBranch.get(0).get("cond"));
    }

    @Test
    @SuppressWarnings("unchecked")
    void controlFlowCalls() {
        List<Map<String, Object>> place = cf("method:com.acme.orders.service.OrderService#place(Order,String)");
        List<Map<String, Object>> items = (List<Map<String, Object>>) place.get(3).get("items");
        List<Map<String, Object>> save = (List<Map<String, Object>>) items.get(0).get("calls");
        assertEquals(Map.of("kind", "writes", "target", "table:orders-db/orders.orders"),
            Map.of("kind", save.get(0).get("kind"), "target", save.get(0).get("target")));
        List<Map<String, Object>> send = (List<Map<String, Object>>) items.get(1).get("calls");
        // arguments are evaluated before the call that uses them
        assertEquals("publishes", send.get(send.size() - 1).get("kind"));
        assertEquals("topic:order-events", send.get(send.size() - 1).get("target"));

        List<Map<String, Object>> charge = (List<Map<String, Object>>) ((List<Map<String, Object>>) place.get(1).get("items")).get(1).get("calls");
        assertEquals("http_calls", charge.get(0).get("kind"));
        assertEquals("POST /v1/charges", charge.get(0).get("name"));

        // a call only reachable through a lambda carries its guard
        List<Map<String, Object>> find = cf("method:com.acme.orders.service.OrderService#find(long)");
        assertEquals("return", find.get(0).get("k"));
        List<Map<String, Object>> calls = (List<Map<String, Object>>) find.get(0).get("calls");
        Map<String, Object> notFound = calls.stream().filter(c -> String.valueOf(c.get("target")).contains("OrderNotFoundException"))
            .findFirst().orElseThrow();
        assertEquals("if empty", notFound.get("when"));
        assertEquals("reads", calls.stream().filter(c -> "findById".equals(c.get("name"))).findFirst().orElseThrow().get("kind"));
    }

    @Test
    void helpers() {
        assertEquals("/orders/{id}", JavaAnalyzer.route("/orders/", "/{id:\\d+}/"));
        assertEquals("/", JavaAnalyzer.route("", ""));
        assertEquals("payments.example.com", JavaAnalyzer.host("https://payments.example.com/v1/{id}"));
        assertEquals("inventory-service", JavaAnalyzer.host("inventory-service"));
        assertNull(JavaAnalyzer.host("${payments.url}"));
        assertEquals("order_line", Ast.snakeCase("OrderLine"));
        assertEquals("http_url", Ast.snakeCase("HTTPUrl"));
        assertEquals("Map", Ast.erase("Map<String, List<Order>>"));
    }
}
