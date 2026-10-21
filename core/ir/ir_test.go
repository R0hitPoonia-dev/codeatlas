package ir

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

const repoRoot = "../.."

func loadFixture(t *testing.T) *Document {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(repoRoot, "ir/fixtures/orders-service.java.json"))
	if err != nil {
		t.Fatal(err)
	}
	doc, err := DecodeBytes(b)
	if err != nil {
		t.Fatal(err)
	}
	return doc
}

func TestFixtureIsValid(t *testing.T) {
	doc := loadFixture(t)
	if err := doc.Validate(); err != nil {
		t.Fatalf("fixture invalid: %v", err.(*ValidationError).Problems)
	}
}

func TestValidateProblems(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*Document)
		want   string
	}{
		{"version", func(d *Document) { d.IRVersion = "2" }, "irVersion"},
		{"missing repo", func(d *Document) { d.Source.Repo = "" }, "source.repo"},
		{"duplicate id", func(d *Document) { d.Nodes = append(d.Nodes, d.Nodes[0]) }, "duplicate"},
		{"bad node kind", func(d *Document) { d.Nodes[0].Kind = "widget" }, `unknown "widget"`},
		{"unknown parent", func(d *Document) { d.Nodes[1].Parent = "nope" }, `parent: unknown node "nope"`},
		{"self parent", func(d *Document) { d.Nodes[1].Parent = d.Nodes[1].ID }, "cannot contain itself"},
		{"dangling edge", func(d *Document) { d.Edges[0].Target = "missing" }, `target: unknown node "missing"`},
		{"bad edge kind", func(d *Document) { d.Edges[0].Kind = "likes" }, `unknown "likes"`},
		{"line order", func(d *Document) {
			start, end := 10, 5
			d.Nodes[2].Location = &Location{File: "a.java", StartLine: &start, EndLine: &end}
		}, "before startLine"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			doc := loadFixture(t)
			tt.mutate(doc)
			err := doc.Validate()
			var ve *ValidationError
			if !errors.As(err, &ve) {
				t.Fatalf("want ValidationError, got %v", err)
			}
			if !slices.ContainsFunc(ve.Problems, func(p string) bool { return strings.Contains(p, tt.want) }) {
				t.Fatalf("no problem containing %q in %v", tt.want, ve.Problems)
			}
		})
	}
}

func TestDecodeRejectsUnknownFields(t *testing.T) {
	_, err := DecodeBytes([]byte(`{"irVersion":"1","bogus":true}`))
	if err == nil || !strings.Contains(err.Error(), "bogus") {
		t.Fatalf("want unknown-field error, got %v", err)
	}
}

func TestDecodeRejectsTrailingData(t *testing.T) {
	_, err := DecodeBytes([]byte(`{"irVersion":"1"} {}`))
	if err == nil {
		t.Fatal("want error for trailing data")
	}
}

// TestKindsMatchSchema keeps the Go enums and the JSON schema from drifting.
func TestKindsMatchSchema(t *testing.T) {
	b, err := os.ReadFile(filepath.Join(repoRoot, "ir/schema/ir.v1.schema.json"))
	if err != nil {
		t.Fatal(err)
	}
	var schema struct {
		Defs map[string]struct {
			Enum []string `json:"enum"`
		} `json:"$defs"`
	}
	if err := json.Unmarshal(b, &schema); err != nil {
		t.Fatal(err)
	}
	check := func(def string, got []string) {
		want := schema.Defs[def].Enum
		if !slices.Equal(want, got) {
			t.Errorf("%s: schema %v != Go %v", def, want, got)
		}
	}
	check("nodeKind", toStrings(NodeKinds))
	check("edgeKind", toStrings(EdgeKinds))
}

func toStrings[T ~string](xs []T) []string {
	out := make([]string, len(xs))
	for i, x := range xs {
		out[i] = string(x)
	}
	return out
}
