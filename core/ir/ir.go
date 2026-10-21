// Package ir defines the CodeAtlas intermediate representation: the graph every
// analyzer emits. It mirrors ir/schema/ir.v1.schema.json; keep the two in sync.
package ir

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"time"
)

const Version = "1"

type NodeKind string

const (
	NodeService    NodeKind = "service"
	NodeModule     NodeKind = "module"
	NodePackage    NodeKind = "package"
	NodeFile       NodeKind = "file"
	NodeClass      NodeKind = "class"
	NodeInterface  NodeKind = "interface"
	NodeEnum       NodeKind = "enum"
	NodeFunction   NodeKind = "function"
	NodeMethod     NodeKind = "method"
	NodeField      NodeKind = "field"
	NodeEndpoint   NodeKind = "endpoint"
	NodeDatabase   NodeKind = "database"
	NodeTable      NodeKind = "table"
	NodeTopic      NodeKind = "topic"
	NodeQueue      NodeKind = "queue"
	NodeExternal   NodeKind = "external"
	NodeContainer  NodeKind = "container"
	NodeDeployment NodeKind = "deployment"
)

// NodeKinds lists every valid node kind.
var NodeKinds = []NodeKind{
	NodeService, NodeModule, NodePackage, NodeFile,
	NodeClass, NodeInterface, NodeEnum, NodeFunction, NodeMethod, NodeField,
	NodeEndpoint, NodeDatabase, NodeTable, NodeTopic, NodeQueue,
	NodeExternal, NodeContainer, NodeDeployment,
}

type EdgeKind string

const (
	EdgeContains   EdgeKind = "contains"
	EdgeImports    EdgeKind = "imports"
	EdgeDependsOn  EdgeKind = "depends_on"
	EdgeCalls      EdgeKind = "calls"
	EdgeExtends    EdgeKind = "extends"
	EdgeImplements EdgeKind = "implements"
	EdgeReferences EdgeKind = "references"
	EdgeHandles    EdgeKind = "handles"
	EdgeReads      EdgeKind = "reads"
	EdgeWrites     EdgeKind = "writes"
	EdgePublishes  EdgeKind = "publishes"
	EdgeConsumes   EdgeKind = "consumes"
	EdgeHTTPCalls  EdgeKind = "http_calls"
	EdgeDeploys    EdgeKind = "deploys"
	EdgeConnectsTo EdgeKind = "connects_to"
	EdgeRuns       EdgeKind = "runs"
)

// EdgeKinds lists every valid edge kind.
var EdgeKinds = []EdgeKind{
	EdgeContains, EdgeImports, EdgeDependsOn,
	EdgeCalls, EdgeExtends, EdgeImplements, EdgeReferences,
	EdgeHandles, EdgeReads, EdgeWrites, EdgePublishes, EdgeConsumes,
	EdgeHTTPCalls, EdgeDeploys, EdgeConnectsTo, EdgeRuns,
}

var (
	validNodeKinds = setOf(NodeKinds)
	validEdgeKinds = setOf(EdgeKinds)
)

func setOf[T comparable](xs []T) map[T]bool {
	m := make(map[T]bool, len(xs))
	for _, x := range xs {
		m[x] = true
	}
	return m
}

type Document struct {
	IRVersion string `json:"irVersion"`
	Source    Source `json:"source"`
	Nodes     []Node `json:"nodes"`
	Edges     []Edge `json:"edges"`
	// Config is the repo's own CodeAtlas settings (.codeatlas.yml: groups, renames), passed
	// through to the UI. Only the infra analyzer sets it.
	Config map[string]any `json:"config,omitempty"`
}

type Source struct {
	Repo        string     `json:"repo"`
	Commit      string     `json:"commit"`
	Branch      string     `json:"branch,omitempty"`
	Analyzer    Analyzer   `json:"analyzer"`
	GeneratedAt *time.Time `json:"generatedAt,omitempty"`
}

type Analyzer struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

type Location struct {
	File      string `json:"file"`
	StartLine *int   `json:"startLine,omitempty"`
	EndLine   *int   `json:"endLine,omitempty"`
}

type Node struct {
	ID            string            `json:"id"`
	Kind          NodeKind          `json:"kind"`
	Name          string            `json:"name"`
	QualifiedName string            `json:"qualifiedName,omitempty"`
	Parent        string            `json:"parent,omitempty"`
	Language      string            `json:"language,omitempty"`
	Location      *Location         `json:"location,omitempty"`
	OTel          map[string]string `json:"otel,omitempty"`
	Attrs         map[string]any    `json:"attrs,omitempty"`
}

type Edge struct {
	Source    string         `json:"source"`
	Target    string         `json:"target"`
	Kind      EdgeKind       `json:"kind"`
	Locations []Location     `json:"locations,omitempty"`
	Attrs     map[string]any `json:"attrs,omitempty"`
}

// Decode strictly parses an IR document: unknown fields and trailing data are errors.
func Decode(r io.Reader) (*Document, error) {
	dec := json.NewDecoder(r)
	dec.DisallowUnknownFields()
	var doc Document
	if err := dec.Decode(&doc); err != nil {
		return nil, fmt.Errorf("decode IR: %w", err)
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, fmt.Errorf("decode IR: unexpected data after document")
	}
	return &doc, nil
}

// DecodeBytes is Decode for an in-memory document.
func DecodeBytes(b []byte) (*Document, error) { return Decode(bytes.NewReader(b)) }

// ValidationError collects every problem found in a document.
type ValidationError struct {
	Problems []string `json:"problems"`
	// Truncated is true when more problems existed than were recorded.
	Truncated bool `json:"truncated,omitempty"`
}

func (e *ValidationError) Error() string {
	msg := fmt.Sprintf("invalid IR: %d problem(s)", len(e.Problems))
	if len(e.Problems) > 0 {
		msg += ": " + e.Problems[0]
	}
	return msg
}

const maxProblems = 100

// Validate checks the semantic rules the JSON schema cannot express
// (unique ids, resolvable references) as well as the structural ones.
// It returns *ValidationError or nil.
func (d *Document) Validate() error {
	v := &ValidationError{}
	add := func(format string, args ...any) {
		if len(v.Problems) >= maxProblems {
			v.Truncated = true
			return
		}
		v.Problems = append(v.Problems, fmt.Sprintf(format, args...))
	}

	if d.IRVersion != Version {
		add("irVersion: want %q, got %q", Version, d.IRVersion)
	}
	if d.Source.Repo == "" {
		add("source.repo: required")
	}
	if d.Source.Commit == "" {
		add("source.commit: required")
	}
	if d.Source.Analyzer.Name == "" {
		add("source.analyzer.name: required")
	}
	if d.Source.Analyzer.Version == "" {
		add("source.analyzer.version: required")
	}

	ids := make(map[string]bool, len(d.Nodes))
	for i, n := range d.Nodes {
		if n.ID == "" {
			add("nodes[%d].id: required", i)
		} else if ids[n.ID] {
			add("nodes[%d].id: duplicate %q", i, n.ID)
		}
		ids[n.ID] = true
		if !validNodeKinds[n.Kind] {
			add("nodes[%d] (%s).kind: unknown %q", i, n.ID, n.Kind)
		}
		if n.Name == "" {
			add("nodes[%d] (%s).name: required", i, n.ID)
		}
		if n.Location != nil {
			validateLocation(*n.Location, fmt.Sprintf("nodes[%d] (%s).location", i, n.ID), add)
		}
	}
	for i, n := range d.Nodes {
		if n.Parent == "" {
			continue
		}
		if n.Parent == n.ID {
			add("nodes[%d] (%s).parent: node cannot contain itself", i, n.ID)
		} else if !ids[n.Parent] {
			add("nodes[%d] (%s).parent: unknown node %q", i, n.ID, n.Parent)
		}
	}
	for i, e := range d.Edges {
		if !ids[e.Source] {
			add("edges[%d].source: unknown node %q", i, e.Source)
		}
		if !ids[e.Target] {
			add("edges[%d].target: unknown node %q", i, e.Target)
		}
		if !validEdgeKinds[e.Kind] {
			add("edges[%d].kind: unknown %q", i, e.Kind)
		}
		for j, loc := range e.Locations {
			validateLocation(loc, fmt.Sprintf("edges[%d].locations[%d]", i, j), add)
		}
	}

	if len(v.Problems) > 0 {
		return v
	}
	return nil
}

func validateLocation(l Location, path string, add func(string, ...any)) {
	if l.File == "" {
		add("%s.file: required", path)
	}
	if l.StartLine != nil && *l.StartLine < 1 {
		add("%s.startLine: must be >= 1", path)
	}
	if l.EndLine != nil && *l.EndLine < 1 {
		add("%s.endLine: must be >= 1", path)
	}
	if l.StartLine != nil && l.EndLine != nil && *l.EndLine < *l.StartLine {
		add("%s.endLine: before startLine", path)
	}
}
