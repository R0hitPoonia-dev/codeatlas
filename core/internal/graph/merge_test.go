package graph

import (
	"testing"

	"codeatlas/core/ir"
)

func TestMergeCombinesNodesAndEdges(t *testing.T) {
	a := &Graph{
		Nodes: []ir.Node{
			{ID: "svc:orders", Kind: ir.NodeService, Name: "orders", Attrs: map[string]any{"path": "orders"}},
			{ID: "m:a", Kind: ir.NodeMethod, Name: "a"},
			{ID: "m:b", Kind: ir.NodeMethod, Name: "b"},
		},
		Edges: []ir.Edge{{Source: "m:a", Target: "m:b", Kind: ir.EdgeCalls, Locations: []ir.Location{{File: "A.java"}}}},
	}
	b := &Graph{
		Nodes: []ir.Node{
			{ID: "svc:orders", Kind: ir.NodeService, Name: "orders", OTel: map[string]string{"service.name": "orders"}},
			{ID: "ctr:orders", Kind: ir.NodeContainer, Name: "orders-app", Attrs: map[string]any{"buildContext": "./orders/"}},
		},
		Edges: []ir.Edge{{Source: "m:a", Target: "m:b", Kind: ir.EdgeCalls, Locations: []ir.Location{{File: "B.java"}}}},
	}
	g := Merge(a, b)

	if len(g.Nodes) != 4 {
		t.Fatalf("nodes = %d", len(g.Nodes))
	}
	svc := g.Nodes[0]
	if svc.OTel["service.name"] != "orders" || svc.Attrs["path"] != "orders" {
		t.Errorf("service not merged: %+v", svc)
	}
	var calls, deploys int
	for _, e := range g.Edges {
		switch e.Kind {
		case ir.EdgeCalls:
			calls++
			if len(e.Locations) != 2 {
				t.Errorf("locations not concatenated: %+v", e.Locations)
			}
		case ir.EdgeDeploys:
			deploys++
			if e.Source != "ctr:orders" || e.Target != "svc:orders" {
				t.Errorf("deploys edge = %+v", e)
			}
		}
	}
	if calls != 1 || deploys != 1 {
		t.Errorf("calls=%d deploys=%d", calls, deploys)
	}
}

func TestLinkByNameAndDatabaseHost(t *testing.T) {
	g := Merge(
		&Graph{Nodes: []ir.Node{
			{ID: "svc:orders", Kind: ir.NodeService, Name: "orders", OTel: map[string]string{"service.name": "orders-service"}},
			{ID: "db:orders-db/orders", Kind: ir.NodeDatabase, Name: "orders", Attrs: map[string]any{"host": "orders-db"}},
		}},
		&Graph{Nodes: []ir.Node{
			// K8s deployment named differently, reachable via its Service hostname
			{ID: "k8s:shop/orders-api", Kind: ir.NodeDeployment, Name: "orders-api",
				Attrs: map[string]any{"hostnames": []any{"orders-service"}}},
			{ID: "ctr:orders-db", Kind: ir.NodeContainer, Name: "orders-db"},
		}},
	)
	want := map[[2]string]bool{
		{"k8s:shop/orders-api", "svc:orders"}:    false,
		{"ctr:orders-db", "db:orders-db/orders"}: false,
	}
	for _, e := range g.Edges {
		if e.Kind == ir.EdgeDeploys {
			want[[2]string{e.Source, e.Target}] = true
		}
	}
	for k, found := range want {
		if !found {
			t.Errorf("missing deploys edge %s -> %s", k[0], k[1])
		}
	}
}

func TestDatabaseContainerByConnection(t *testing.T) {
	g := Merge(&Graph{
		Nodes: []ir.Node{
			{ID: "svc:notify", Kind: ir.NodeService, Name: "notify", Attrs: map[string]any{"path": "notify"}},
			{ID: "db:notify-db", Kind: ir.NodeDatabase, Name: "notify-db", Attrs: map[string]any{"usedBy": "svc:notify"}},
			{ID: "ctr:notify", Kind: ir.NodeContainer, Name: "notify", Attrs: map[string]any{"buildContext": "notify"}},
			{ID: "ctr:pg", Kind: ir.NodeContainer, Name: "pg", Attrs: map[string]any{"role": "database"}},
		},
		Edges: []ir.Edge{{Source: "ctr:notify", Target: "ctr:pg", Kind: ir.EdgeConnectsTo}},
	})
	for _, e := range g.Edges {
		if e.Kind == ir.EdgeDeploys && e.Source == "ctr:pg" && e.Target == "db:notify-db" {
			return
		}
	}
	t.Fatalf("database container not linked: %+v", g.Edges)
}

func TestLinkSplitModuleByJar(t *testing.T) {
	g := Merge(&Graph{Nodes: []ir.Node{
		{ID: "mod:livepnl", Kind: ir.NodeModule, Name: "livepnl", Attrs: map[string]any{"path": "engine"}},
		{ID: "svc:producer", Kind: ir.NodeService, Name: "livepnl-producer",
			Attrs: map[string]any{"path": "engine", "jar": "producer-1.2.jar", "mainClass": "producer.Main"}},
		{ID: "svc:consumer", Kind: ir.NodeService, Name: "livepnl-consumer",
			Attrs: map[string]any{"path": "engine", "jar": "consumer-1.2.jar", "mainClass": "consumer.Main"}},
		{ID: "ctr:producer", Kind: ir.NodeContainer, Name: "producer",
			Attrs: map[string]any{"buildContext": "engine", "jars": []any{"producer-1.2.jar"}}},
		{ID: "ctr:consumer", Kind: ir.NodeContainer, Name: "consumer",
			Attrs: map[string]any{"buildContext": "engine", "mainClasses": []any{"consumer.Main"}}},
		{ID: "ctr:both", Kind: ir.NodeContainer, Name: "both",
			Attrs: map[string]any{"buildContext": "engine"}},
		// Dockerfile.consumer: COPY target/consumer-*.jar /app/app.jar
		{ID: "ctr:globbed", Kind: ir.NodeContainer, Name: "globbed",
			Attrs: map[string]any{"buildContext": "engine", "jars": []any{"app.jar", "consumer-*.jar"}}},
		{ID: "ctr:anyjar", Kind: ir.NodeContainer, Name: "anyjar",
			Attrs: map[string]any{"buildContext": "engine", "jars": []any{"*.jar"}}},
	}})
	got := map[string]string{}
	for _, e := range g.Edges {
		if e.Kind == ir.EdgeDeploys {
			got[e.Source] = e.Target
		}
	}
	if got["ctr:producer"] != "svc:producer" || got["ctr:consumer"] != "svc:consumer" {
		t.Errorf("deploys = %v", got)
	}
	if got["ctr:globbed"] != "svc:consumer" {
		t.Errorf("globbed jar deploys %q, want svc:consumer", got["ctr:globbed"])
	}
	for _, c := range []string{"ctr:both", "ctr:anyjar"} {
		if _, ok := got[c]; ok {
			t.Errorf("ambiguous container %s should not pick a program: %v", c, got)
		}
	}
}

func TestExternalHostResolvesToService(t *testing.T) {
	g := Merge(&Graph{
		Nodes: []ir.Node{
			{ID: "svc:orders", Kind: ir.NodeService, Name: "orders"},
			{ID: "svc:inventory", Kind: ir.NodeService, Name: "inventory", Attrs: map[string]any{"path": "inv"}},
			{ID: "ctr:inventory-service", Kind: ir.NodeContainer, Name: "inventory-service", Attrs: map[string]any{"buildContext": "inv"}},
			{ID: "m:place", Kind: ir.NodeMethod, Name: "place", Parent: "svc:orders"},
			{ID: "ext:inventory-service", Kind: ir.NodeExternal, Name: "inventory-service",
				OTel: map[string]string{"server.address": "inventory-service"}},
			{ID: "ext:stripe", Kind: ir.NodeExternal, Name: "api.stripe.com"},
		},
		Edges: []ir.Edge{
			{Source: "m:place", Target: "ext:inventory-service", Kind: ir.EdgeHTTPCalls},
			{Source: "m:place", Target: "ext:stripe", Kind: ir.EdgeHTTPCalls},
		},
	})
	for _, n := range g.Nodes {
		if n.ID == "ext:inventory-service" {
			t.Fatal("resolved external node should be removed")
		}
	}
	targets := map[string]bool{}
	for _, e := range g.Edges {
		if e.Kind == ir.EdgeHTTPCalls {
			targets[e.Target] = true
		}
	}
	// container name -> container -> deploys -> service
	if !targets["svc:inventory"] || !targets["ext:stripe"] {
		t.Errorf("http_calls targets = %v", targets)
	}
}
