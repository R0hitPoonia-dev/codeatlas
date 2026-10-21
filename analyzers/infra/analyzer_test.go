package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"codeatlas/core/ir"
)

func analyzeDemo(t *testing.T) (map[string]ir.Node, func(s, t string, k ir.EdgeKind) *ir.Edge) {
	t.Helper()
	root, _ := filepath.Abs("../../demo/shop")
	doc, warnings, err := analyze(root, ir.Source{Repo: "shop", Commit: "c", Analyzer: ir.Analyzer{Name: "infra", Version: "test"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(warnings) > 0 {
		t.Errorf("warnings: %v", warnings)
	}
	if err := doc.Validate(); err != nil {
		t.Fatal(err)
	}
	nodes := map[string]ir.Node{}
	for _, n := range doc.Nodes {
		nodes[n.ID] = n
	}
	edge := func(s, tg string, k ir.EdgeKind) *ir.Edge {
		for i, e := range doc.Edges {
			if e.Source == s && e.Target == tg && e.Kind == k {
				return &doc.Edges[i]
			}
		}
		return nil
	}
	return nodes, edge
}

func TestCompose(t *testing.T) {
	nodes, edge := analyzeDemo(t)
	orders := nodes["ctr:orders-service"]
	if orders.Attrs["buildContext"] != "orders" || orders.OTel["service.name"] != "orders-service" {
		t.Errorf("orders container = %+v", orders)
	}
	if nodes["ctr:inventory-service"].Attrs["buildContext"] != "inventory" { // build: {context: ./inventory}
		t.Errorf("inventory build context = %v", nodes["ctr:inventory-service"].Attrs["buildContext"])
	}
	if nodes["ctr:orders-db"].Attrs["role"] != "database" || nodes["ctr:kafka"].Attrs["role"] != "broker" {
		t.Error("image roles not detected")
	}
	if e := edge("ctr:inventory-service", "ctr:inventory-db", ir.EdgeConnectsTo); e == nil { // depends_on map form
		t.Error("depends_on (map form) missing")
	}
	// discovered from an env value, not depends_on
	e := edge("ctr:storefront-bff", "ctr:orders-service", ir.EdgeConnectsTo)
	if e == nil || !slices.Contains(e.Attrs["env"].([]string), "ORDERS_URL") {
		t.Errorf("env-derived connection = %+v", e)
	}
	// env values (which may hold secrets) are never recorded
	for _, n := range nodes {
		for k, v := range n.Attrs {
			if s, ok := v.(string); ok && (k == "DATABASE_URL" || s == "postgresql://notify:secret@notifications-db:5432/notifications") {
				t.Errorf("env value leaked into %s.%s", n.ID, k)
			}
		}
	}
}

func TestKubernetes(t *testing.T) {
	nodes, edge := analyzeDemo(t)
	d, ok := nodes["k8s:shop/orders-service"]
	if !ok {
		t.Fatal("deployment missing")
	}
	if d.Attrs["replicas"] != 3 || !slices.Contains(d.Attrs["hostnames"].([]string), "orders-service.shop.svc.cluster.local") {
		t.Errorf("deployment attrs = %+v", d.Attrs)
	}
	if e := edge("ingress:shop.example.com", "k8s:shop/orders-service", ir.EdgeConnectsTo); e == nil {
		t.Error("ingress not linked through its Service to the deployment")
	}
}

func TestOpenAPI(t *testing.T) {
	nodes, _ := analyzeDemo(t)
	ep, ok := nodes["endpoint:orders-service:GET /orders/{id}"]
	if !ok {
		t.Fatal("endpoint missing; service should come from the servers[0] host")
	}
	if ep.Attrs["operationId"] != "getOrder" || ep.OTel["http.route"] != "/orders/{id}" || ep.Parent != "svc:orders-service" {
		t.Errorf("endpoint = %+v", ep)
	}
	if ep.Location == nil || *ep.Location.StartLine != 14 {
		t.Errorf("location = %+v", ep.Location)
	}
}

func TestSpecService(t *testing.T) {
	cases := []struct {
		spec openAPISpec
		want string
	}{
		{openAPISpec{ServiceName: "billing"}, "billing"},
		{openAPISpec{Host: "api.example.com:443"}, "api.example.com"},
		{func() openAPISpec {
			s := openAPISpec{}
			s.Info.Title = "Payments API (v2)"
			s.Servers = append(s.Servers, struct {
				URL string `yaml:"url"`
			}{"http://localhost:8080"})
			return s
		}(), "payments-api-v2"},
	}
	for _, c := range cases {
		if got := specService(&c.spec); got != c.want {
			t.Errorf("specService = %q, want %q", got, c.want)
		}
	}
}

func TestLaunchCommand(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "compose.yml"), []byte(`
services:
  producer:
    image: eclipse-temurin:17
    command: ["java", "-jar", "/app/producer-1.2.jar"]
  consumer:
    image: eclipse-temurin:17
    entrypoint: java -cp /app/consumer.jar consumer.Main
`), 0o644)
	doc, _, err := analyze(dir, ir.Source{Repo: "r", Commit: "c", Analyzer: ir.Analyzer{Name: "infra", Version: "t"}})
	if err != nil {
		t.Fatal(err)
	}
	nodes := map[string]ir.Node{}
	for _, n := range doc.Nodes {
		nodes[n.ID] = n
	}
	if jars := nodes["ctr:producer"].Attrs["jars"]; !slices.Equal(jars.([]string), []string{"producer-1.2.jar"}) {
		t.Errorf("producer jars = %v", jars)
	}
	consumer := nodes["ctr:consumer"].Attrs
	if !slices.Contains(consumer["jars"].([]string), "consumer.jar") || !slices.Contains(consumer["mainClasses"].([]string), "consumer.Main") {
		t.Errorf("consumer launch = %+v", consumer)
	}
}

func TestDockerfileLaunch(t *testing.T) {
	dir := t.TempDir()
	os.MkdirAll(filepath.Join(dir, "engine"), 0o755)
	os.WriteFile(filepath.Join(dir, "compose.yml"), []byte(`
services:
  consumer:
    build: {context: ./engine, dockerfile: Dockerfile.consumer}
  producer:
    build: ./engine
    command: ["java", "-Dsecret.key=hunter2.value", "-cp", "/app/app.jar", "producer.Main"]
`), 0o644)
	os.WriteFile(filepath.Join(dir, "engine", "Dockerfile.consumer"), []byte(`
FROM maven:3 AS build
COPY . .
ENTRYPOINT ["mvn"]
FROM eclipse-temurin:17
ENV DB_PASSWORD=s3cret.pass
COPY --from=build target/consumer-*.jar \
     /app/app.jar
ENTRYPOINT ["java", "-jar", "/app/app.jar"]
`), 0o644)
	os.WriteFile(filepath.Join(dir, "engine", "Dockerfile"), []byte("FROM eclipse-temurin:17\nCMD java -jar /app/ignored.jar\n"), 0o644)
	doc, _, err := analyze(dir, ir.Source{Repo: "r", Commit: "c", Analyzer: ir.Analyzer{Name: "infra", Version: "t"}})
	if err != nil {
		t.Fatal(err)
	}
	nodes := map[string]ir.Node{}
	for _, n := range doc.Nodes {
		nodes[n.ID] = n
	}
	consumer := nodes["ctr:consumer"].Attrs
	if consumer["dockerfile"] != "engine/Dockerfile.consumer" {
		t.Errorf("consumer dockerfile = %v", consumer["dockerfile"])
	}
	if jars := consumer["jars"].([]string); !slices.Equal(jars, []string{"app.jar", "consumer-*.jar"}) {
		t.Errorf("consumer jars = %v (the build stage's ENTRYPOINT is not the image's)", jars)
	}
	producer := nodes["ctr:producer"].Attrs
	if classes := producer["mainClasses"].([]string); !slices.Equal(classes, []string{"producer.Main"}) {
		t.Errorf("producer main classes = %v", classes)
	}
	if jars := producer["jars"].([]string); slices.Contains(jars, "ignored.jar") {
		t.Errorf("compose command replaces the Dockerfile CMD: %v", jars)
	}
	for _, n := range doc.Nodes {
		for k, v := range n.Attrs {
			if s := fmt.Sprint(v); strings.Contains(s, "hunter2") || strings.Contains(s, "s3cret") {
				t.Errorf("option / ENV value leaked into %s.%s = %s", n.ID, k, s)
			}
		}
	}
}

func TestMentionsHost(t *testing.T) {
	if !mentionsHost("kafka:9092,kafka-2:9092", "kafka") || mentionsHost("kafkaesque:1", "kafka") {
		t.Error("host matching wrong")
	}
}

func TestRepoConfig(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, ".codeatlas.yml"), []byte(`
groups:
  - name: Trade pipeline
    members: ["com.acme.ledger.processor.threads.*", "com.acme.ledger.processor.db.TradeWriter"]
  - name: ""
    members: ["ignored"]
rename:
  proc:thread: Consumer threads
`), 0o644)
	doc, warnings, err := analyze(dir, ir.Source{Repo: "r", Commit: "c", Analyzer: ir.Analyzer{Name: "infra", Version: "t"}})
	if err != nil || len(warnings) > 0 {
		t.Fatal(err, warnings)
	}
	groups, _ := doc.Config["groups"].([]any)
	if len(groups) != 1 || groups[0].(map[string]any)["name"] != "Trade pipeline" {
		t.Fatalf("groups = %#v", doc.Config["groups"])
	}
	if doc.Config["rename"].(map[string]any)["proc:thread"] != "Consumer threads" {
		t.Fatalf("rename = %#v", doc.Config["rename"])
	}
	if err := doc.Validate(); err != nil {
		t.Fatal(err)
	}
	// round-trips through the strict decoder
	b, _ := json.Marshal(doc)
	if _, err := ir.DecodeBytes(b); err != nil {
		t.Fatal(err)
	}

	empty, _, _ := analyze(t.TempDir(), ir.Source{Repo: "r", Commit: "c", Analyzer: ir.Analyzer{Name: "infra", Version: "t"}})
	if empty.Config != nil {
		t.Fatalf("no file: config = %#v", empty.Config)
	}
}
