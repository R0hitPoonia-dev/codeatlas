// Command codeatlas-infra emits CodeAtlas IR for a repo's infrastructure files:
// docker-compose services, Kubernetes manifests and OpenAPI/Swagger specs.
//
//	codeatlas-infra <repo-dir> [--repo NAME] [--commit SHA] [--branch NAME] [--out FILE]
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"gopkg.in/yaml.v3"

	"codeatlas/core/ir"
)

const version = "0.1.0"

var skipDirs = map[string]bool{".git": true, "node_modules": true, "target": true, "build": true, "dist": true, ".terraform": true, "vendor": true}

type analyzer struct {
	root      string
	b         *builder
	workloads []k8sWorkload
	services  []k8sService
	ingresses []k8sIngress
	warnings  []string
}

func analyze(root string, src ir.Source) (*ir.Document, []string, error) {
	a := &analyzer{root: root, b: newBuilder()}
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if p != root && (skipDirs[d.Name()] || strings.HasPrefix(d.Name(), ".")) {
				return filepath.SkipDir
			}
			return nil
		}
		name := d.Name()
		ext := strings.ToLower(filepath.Ext(name))
		if ext != ".yml" && ext != ".yaml" && ext != ".json" {
			return nil
		}
		info, err := d.Info()
		if err != nil || info.Size() > 5<<20 {
			return nil
		}
		rel, _ := filepath.Rel(root, p)
		rel = filepath.ToSlash(rel)
		data, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		var ferr error
		switch {
		case composeFileRe.MatchString(name):
			ferr = a.compose(rel, data)
		case ext == ".json" && name != "package.json" && !strings.HasSuffix(name, "lock.json"):
			_, ferr = a.openapi(rel, data)
		case ext != ".json":
			var ok bool
			if ok, ferr = a.openapi(rel, data); !ok && ferr == nil {
				ferr = a.k8s(rel, data)
			}
		}
		if ferr != nil {
			a.warnings = append(a.warnings, ferr.Error())
		}
		return nil
	})
	if err != nil {
		return nil, nil, err
	}
	a.linkK8s()
	doc := a.b.build(src)
	if cfg, err := repoConfig(root); err != nil {
		a.warnings = append(a.warnings, err.Error())
	} else {
		doc.Config = cfg
	}
	return doc, a.warnings, nil
}

// repoConfig reads .codeatlas.yml at the repo root: diagram groups and group renames.
//
//	groups:
//	  - name: Trade pipeline
//	    members: ["com.acme.ledger.processor.threads.*", "com.acme.ledger.processor.db.TradeWriter"]
//	rename:
//	  proc:thread: Consumer threads
func repoConfig(root string) (map[string]any, error) {
	var data []byte
	var name string
	for _, n := range []string{".codeatlas.yml", ".codeatlas.yaml"} {
		if b, err := os.ReadFile(filepath.Join(root, n)); err == nil {
			data, name = b, n
			break
		}
	}
	if data == nil {
		return nil, nil
	}
	var raw struct {
		Groups []struct {
			Name    string   `yaml:"name"`
			Members []string `yaml:"members"`
		} `yaml:"groups"`
		Rename map[string]string `yaml:"rename"`
	}
	if err := yaml.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("%s: %w", name, err)
	}
	cfg := map[string]any{}
	var groups []any
	for _, g := range raw.Groups {
		if strings.TrimSpace(g.Name) == "" || len(g.Members) == 0 {
			continue
		}
		members := make([]any, len(g.Members))
		for i, m := range g.Members {
			members[i] = m
		}
		groups = append(groups, map[string]any{"name": strings.TrimSpace(g.Name), "members": members})
	}
	if len(groups) > 0 {
		cfg["groups"] = groups
	}
	if len(raw.Rename) > 0 {
		rename := map[string]any{}
		for k, v := range raw.Rename {
			rename[k] = v
		}
		cfg["rename"] = rename
	}
	if len(cfg) == 0 {
		return nil, nil
	}
	return cfg, nil
}

func main() {
	fs := flag.NewFlagSet("codeatlas-infra", flag.ExitOnError)
	repo := fs.String("repo", "", "repo name (default: directory name)")
	commit := fs.String("commit", "", "commit sha (default: git HEAD)")
	branch := fs.String("branch", "", "branch (default: current git branch)")
	out := fs.String("out", "", "output file (default: stdout)")
	fs.Usage = func() {
		fmt.Fprintln(os.Stderr, "usage: codeatlas-infra <repo-dir> [--repo NAME] [--commit SHA] [--branch NAME] [--out FILE]")
	}
	// allow flags after the positional directory
	args := os.Args[1:]
	var dir string
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		dir, args = args[0], args[1:]
	}
	fs.Parse(args)
	if dir == "" && fs.NArg() == 1 {
		dir = fs.Arg(0)
	}
	if dir == "" {
		fs.Usage()
		os.Exit(2)
	}
	root, err := filepath.Abs(dir)
	if err != nil {
		fatal(err)
	}
	if *repo == "" {
		*repo = filepath.Base(root)
	}
	if *commit == "" {
		*commit = git(root, "rev-parse", "HEAD")
	}
	if *commit == "" {
		fatal(fmt.Errorf("not a git checkout; pass --commit"))
	}
	if *branch == "" {
		*branch = git(root, "rev-parse", "--abbrev-ref", "HEAD")
	}
	now := time.Now().UTC()
	doc, warnings, err := analyze(root, ir.Source{
		Repo: *repo, Commit: *commit, Branch: *branch,
		Analyzer: ir.Analyzer{Name: "infra", Version: version}, GeneratedAt: &now,
	})
	if err != nil {
		fatal(err)
	}
	for _, w := range warnings {
		fmt.Fprintln(os.Stderr, "codeatlas-infra: warning:", w)
	}
	if err := doc.Validate(); err != nil {
		fatal(err)
	}
	w := os.Stdout
	if *out != "" {
		f, err := os.Create(*out)
		if err != nil {
			fatal(err)
		}
		defer f.Close()
		w = f
	}
	if err := json.NewEncoder(w).Encode(doc); err != nil {
		fatal(err)
	}
	if *out != "" {
		fmt.Fprintf(os.Stderr, "codeatlas-infra: wrote %d nodes, %d edges to %s\n", len(doc.Nodes), len(doc.Edges), *out)
	}
}

func git(dir string, args ...string) string {
	out, err := exec.Command("git", append([]string{"-C", dir}, args...)...).Output()
	s := strings.TrimSpace(string(out))
	if err != nil || s == "HEAD" {
		return ""
	}
	return s
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "codeatlas-infra:", err)
	os.Exit(1)
}
