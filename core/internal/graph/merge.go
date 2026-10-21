// Package graph combines per-analyzer snapshots into one repo graph and derives
// cross-analyzer links (code service <-> container, external host <-> known service).
package graph

import (
	"maps"
	"path"
	"sort"
	"strings"

	"codeatlas/core/ir"
)

// Graph mirrors the IR node/edge lists; it is what the API returns.
type Graph struct {
	Nodes []ir.Node `json:"nodes"`
	Edges []ir.Edge `json:"edges"`
}

// Merge unions graphs in order. Nodes with the same id are combined: earlier
// non-empty scalar fields win, otel/attrs maps are merged. Duplicate edges
// (same source, target, kind) are collapsed and their locations concatenated.
// Then derived links are added (see link*).
func Merge(parts ...*Graph) *Graph {
	out := &Graph{Nodes: []ir.Node{}, Edges: []ir.Edge{}}
	index := map[string]int{}
	for _, p := range parts {
		for _, n := range p.Nodes {
			if i, ok := index[n.ID]; ok {
				out.Nodes[i] = mergeNode(out.Nodes[i], n)
				continue
			}
			index[n.ID] = len(out.Nodes)
			out.Nodes = append(out.Nodes, n)
		}
	}
	type edgeKey struct {
		s, t string
		k    ir.EdgeKind
	}
	edges := map[edgeKey]int{}
	addEdge := func(e ir.Edge) {
		k := edgeKey{e.Source, e.Target, e.Kind}
		if i, ok := edges[k]; ok {
			out.Edges[i].Locations = append(out.Edges[i].Locations, e.Locations...)
			return
		}
		edges[k] = len(out.Edges)
		out.Edges = append(out.Edges, e)
	}
	for _, p := range parts {
		for _, e := range p.Edges {
			addEdge(e)
		}
	}

	links := linkContainers(out.Nodes)
	links = append(links, linkDatabaseContainers(out.Nodes, out.Edges, links)...)
	for _, e := range links {
		addEdge(e)
	}
	resolveExternalServices(out)
	return out
}

// Filter keeps nodes whose kind is in kinds (all nodes if kinds is empty) and the
// edges between kept nodes.
func Filter(g *Graph, kinds []string) *Graph {
	if len(kinds) == 0 {
		return g
	}
	want := map[ir.NodeKind]bool{}
	for _, k := range kinds {
		want[ir.NodeKind(k)] = true
	}
	out := &Graph{Nodes: []ir.Node{}, Edges: []ir.Edge{}}
	keep := map[string]bool{}
	for _, n := range g.Nodes {
		if want[n.Kind] {
			keep[n.ID] = true
			out.Nodes = append(out.Nodes, n)
		}
	}
	for _, e := range g.Edges {
		if keep[e.Source] && keep[e.Target] {
			out.Edges = append(out.Edges, e)
		}
	}
	return out
}

func mergeNode(a, b ir.Node) ir.Node {
	if a.QualifiedName == "" {
		a.QualifiedName = b.QualifiedName
	}
	if a.Parent == "" {
		a.Parent = b.Parent
	}
	if a.Language == "" {
		a.Language = b.Language
	}
	if a.Location == nil {
		a.Location = b.Location
	}
	if len(b.OTel) > 0 {
		m := maps.Clone(b.OTel)
		maps.Copy(m, a.OTel)
		a.OTel = m
	}
	if len(b.Attrs) > 0 {
		m := maps.Clone(b.Attrs)
		maps.Copy(m, a.Attrs)
		a.Attrs = m
	}
	return a
}

// linkContainers adds container/deployment --deploys--> service|database edges:
//   - a container built from the directory a code analyzer reported as a service's path,
//     or, when that directory builds several programs, the one whose jar or main class
//     the container's command names (attrs.jars / attrs.mainClasses);
//   - otherwise one whose name, OTel service name or in-cluster hostnames equal the
//     service's name (compose service "orders-service", K8s Deployment "orders-service");
//   - a container whose name is the host in a service's database connection URL.
func linkContainers(nodes []ir.Node) []ir.Edge {
	byPath := map[string][]string{}
	byName := map[string]string{}
	byJar := map[string]string{}
	byMain := map[string]string{}
	dbByHost := map[string][]string{}
	for _, n := range nodes {
		switch n.Kind {
		case ir.NodeService:
			if p, ok := n.Attrs["path"].(string); ok {
				byPath[cleanPath(p)] = append(byPath[cleanPath(p)], n.ID)
			}
			byName[n.Name] = n.ID
			if sn := n.OTel["service.name"]; sn != "" {
				byName[sn] = n.ID
			}
			if jar, ok := n.Attrs["jar"].(string); ok && jar != "" {
				byJar[path.Base(jar)] = n.ID
			}
			if mc, ok := n.Attrs["mainClass"].(string); ok && mc != "" {
				byMain[mc] = n.ID
			}
		case ir.NodeDatabase:
			if h, ok := n.Attrs["host"].(string); ok {
				dbByHost[h] = append(dbByHost[h], n.ID)
			}
		}
	}
	var edges []ir.Edge
	for _, n := range nodes {
		if n.Kind != ir.NodeContainer && n.Kind != ir.NodeDeployment {
			continue
		}
		svc := ""
		var limit []string
		restrict := false
		if ctx, ok := n.Attrs["buildContext"].(string); ok {
			ids := byPath[cleanPath(ctx)]
			switch len(ids) {
			case 1:
				svc = ids[0]
			default:
				if len(ids) > 1 {
					// one directory builds several programs; the command says which jar it runs
					restrict = true
					limit = ids
				}
			}
		}
		if svc == "" && restrict {
			svc = launchTarget(n, byJar, byMain, limit)
		}
		if svc == "" {
			svc = namedService(n, byName, limit, restrict)
		}
		if svc == "" && !restrict {
			svc = launchTarget(n, byJar, byMain, nil)
		}
		if svc != "" {
			edges = append(edges, ir.Edge{Source: n.ID, Target: svc, Kind: ir.EdgeDeploys})
		}
		for _, name := range containerNames(n) {
			for _, db := range dbByHost[name] {
				edges = append(edges, ir.Edge{Source: n.ID, Target: db, Kind: ir.EdgeDeploys})
			}
		}
	}
	return edges
}

// namedService is the service a container's own names point at. When limit is set, only a
// service built from the same directory qualifies.
func namedService(n ir.Node, byName map[string]string, limit []string, restrict bool) string {
	for _, name := range containerNames(n) {
		id := byName[name]
		if id == "" || restrict && !contains(limit, id) {
			continue
		}
		return id
	}
	return ""
}

// launchTarget is the service whose jar file or main class a container's command names.
func launchTarget(n ir.Node, byJar, byMain map[string]string, limit []string) string {
	allowed := func(id string) bool {
		return id != "" && (limit == nil || contains(limit, id))
	}
	hit := ""
jars:
	for _, jar := range attrStrings(n.Attrs["jars"]) {
		for _, id := range jarOwners(path.Base(jar), byJar) {
			if !allowed(id) {
				continue
			}
			if hit != "" && hit != id {
				hit = ""
				break jars
			}
			hit = id
		}
	}
	if hit != "" {
		return hit
	}
	for _, class := range attrStrings(n.Attrs["mainClasses"]) {
		if allowed(byMain[class]) {
			return byMain[class]
		}
	}
	return ""
}

// jarOwners are the services building the jar a command or COPY names; a Dockerfile's
// glob (target/producer-*.jar) matches by pattern.
func jarOwners(jar string, byJar map[string]string) []string {
	if !strings.ContainsAny(jar, "*?[") {
		if id := byJar[jar]; id != "" {
			return []string{id}
		}
		return nil
	}
	var ids []string
	for name, id := range byJar {
		if ok, _ := path.Match(jar, name); ok && !contains(ids, id) {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	return ids
}

func contains(xs []string, want string) bool {
	for _, x := range xs {
		if x == want {
			return true
		}
	}
	return false
}

func attrStrings(v any) []string {
	switch xs := v.(type) {
	case []string:
		return xs
	case []any:
		var out []string
		for _, x := range xs {
			if s, ok := x.(string); ok {
				out = append(out, s)
			}
		}
		return out
	default:
		return nil
	}
}

// linkDatabaseContainers handles databases whose host isn't known statically (e.g. Prisma
// reading DATABASE_URL from the environment): if a service's container connects to exactly
// one database container, and the service uses exactly one still-unlinked database node,
// the database container deploys that node.
func linkDatabaseContainers(nodes []ir.Node, edges, links []ir.Edge) []ir.Edge {
	byID := map[string]ir.Node{}
	for _, n := range nodes {
		byID[n.ID] = n
	}
	serviceOf := map[string]string{} // container -> service
	linkedDB := map[string]bool{}
	for _, e := range links {
		switch byID[e.Target].Kind {
		case ir.NodeService:
			serviceOf[e.Source] = e.Target
		case ir.NodeDatabase:
			linkedDB[e.Target] = true
		}
	}
	dbContainers := map[string][]string{} // service -> database containers it connects to
	for _, e := range edges {
		svc := serviceOf[e.Source]
		if e.Kind == ir.EdgeConnectsTo && svc != "" && byID[e.Target].Attrs["role"] == "database" {
			dbContainers[svc] = append(dbContainers[svc], e.Target)
		}
	}
	var out []ir.Edge
	for svc, ctrs := range dbContainers {
		if len(ctrs) != 1 {
			continue
		}
		var candidates []string
		for _, n := range nodes {
			if n.Kind == ir.NodeDatabase && n.Attrs["usedBy"] == svc && !linkedDB[n.ID] {
				candidates = append(candidates, n.ID)
			}
		}
		if len(candidates) == 1 {
			out = append(out, ir.Edge{Source: ctrs[0], Target: candidates[0], Kind: ir.EdgeDeploys})
		}
	}
	return out
}

// containerNames are the names other components use to reach a container/deployment.
func containerNames(n ir.Node) []string {
	names := []string{n.Name}
	if sn := n.OTel["service.name"]; sn != "" {
		names = append(names, sn)
	}
	switch hs := n.Attrs["hostnames"].(type) {
	case []string:
		names = append(names, hs...)
	case []any: // after a JSON round-trip
		for _, h := range hs {
			if s, ok := h.(string); ok {
				names = append(names, s)
			}
		}
	}
	return names
}

func cleanPath(p string) string {
	p = path.Clean(strings.TrimPrefix(strings.ReplaceAll(p, "\\", "/"), "./"))
	if p == "." {
		return ""
	}
	return p
}

// resolveExternalServices retargets edges that point at an external host which is
// really another service in this graph (e.g. http://inventory-service/...), so the
// architecture view shows service -> service instead of service -> "external".
func resolveExternalServices(g *Graph) {
	known := map[string]string{} // host name -> node id
	for _, n := range g.Nodes {
		switch n.Kind {
		case ir.NodeService:
			known[n.Name] = n.ID
			if sn := n.OTel["service.name"]; sn != "" {
				known[sn] = n.ID
			}
		case ir.NodeContainer, ir.NodeDeployment:
			// containers resolve to the service they deploy, if any (handled below)
			for _, name := range containerNames(n) {
				if _, taken := known[name]; !taken {
					known[name] = n.ID
				}
			}
		}
	}
	deploys := map[string]string{} // container id -> service id
	for _, e := range g.Edges {
		if e.Kind == ir.EdgeDeploys {
			deploys[e.Source] = e.Target
		}
	}

	replace := map[string]string{} // external node id -> service/container id
	for _, n := range g.Nodes {
		if n.Kind != ir.NodeExternal {
			continue
		}
		host := n.OTel["server.address"]
		if host == "" {
			host = n.Name
		}
		target, ok := known[host]
		if !ok {
			continue
		}
		if svc, ok := deploys[target]; ok {
			target = svc
		}
		replace[n.ID] = target
	}
	if len(replace) == 0 {
		return
	}
	nodes := g.Nodes[:0]
	for _, n := range g.Nodes {
		if _, drop := replace[n.ID]; !drop {
			nodes = append(nodes, n)
		}
	}
	g.Nodes = nodes
	edges := g.Edges[:0]
	for _, e := range g.Edges {
		if t, ok := replace[e.Target]; ok {
			e.Target = t
		}
		if s, ok := replace[e.Source]; ok {
			e.Source = s
		}
		if e.Source != e.Target {
			edges = append(edges, e)
		}
	}
	g.Edges = edges
}
