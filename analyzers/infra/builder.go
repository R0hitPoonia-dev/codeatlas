package main

import (
	"slices"

	"codeatlas/core/ir"
)

// builder collects nodes and edges, merging duplicates by id / (source, target, kind).
type builder struct {
	nodes     []*ir.Node
	nodeIndex map[string]*ir.Node
	edges     []*ir.Edge
	edgeIndex map[[3]string]*ir.Edge
}

func newBuilder() *builder {
	return &builder{nodeIndex: map[string]*ir.Node{}, edgeIndex: map[[3]string]*ir.Edge{}}
}

func (b *builder) node(id string, kind ir.NodeKind, name string) *ir.Node {
	if n, ok := b.nodeIndex[id]; ok {
		return n
	}
	n := &ir.Node{ID: id, Kind: kind, Name: name, Attrs: map[string]any{}, OTel: map[string]string{}}
	b.nodes = append(b.nodes, n)
	b.nodeIndex[id] = n
	return n
}

func (b *builder) edge(source, target string, kind ir.EdgeKind) *ir.Edge {
	k := [3]string{source, target, string(kind)}
	if e, ok := b.edgeIndex[k]; ok {
		return e
	}
	e := &ir.Edge{Source: source, Target: target, Kind: kind, Attrs: map[string]any{}}
	b.edges = append(b.edges, e)
	b.edgeIndex[k] = e
	return e
}

func addToList(attrs map[string]any, key, value string) {
	list, _ := attrs[key].([]string)
	if !slices.Contains(list, value) {
		attrs[key] = append(list, value)
	}
}

// build returns the document, dropping dangling references and empty maps.
func (b *builder) build(src ir.Source) *ir.Document {
	doc := &ir.Document{IRVersion: ir.Version, Source: src, Nodes: []ir.Node{}, Edges: []ir.Edge{}}
	for _, n := range b.nodes {
		if n.Parent != "" && b.nodeIndex[n.Parent] == nil {
			n.Parent = ""
		}
		if len(n.Attrs) == 0 {
			n.Attrs = nil
		}
		if len(n.OTel) == 0 {
			n.OTel = nil
		}
		doc.Nodes = append(doc.Nodes, *n)
	}
	for _, e := range b.edges {
		if b.nodeIndex[e.Source] == nil || b.nodeIndex[e.Target] == nil || e.Source == e.Target {
			continue
		}
		if len(e.Attrs) == 0 {
			e.Attrs = nil
		}
		doc.Edges = append(doc.Edges, *e)
	}
	return doc
}
