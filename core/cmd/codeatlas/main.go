// Command codeatlas is the CLI for indexing repositories into a CodeAtlas server.
//
//	codeatlas scan <repo-dir> [--repo NAME] [--commit SHA] [--branch NAME] [--out-dir DIR] [--no-upload]
//	codeatlas upload [--repo NAME] FILE...
//	codeatlas validate FILE...
//
// Server and credentials come from CODEATLAS_URL and CODEATLAS_TOKEN (an API token from
// POST /api/v1/tokens). Analyzer locations can be overridden with CODEATLAS_JAVA_ANALYZER
// (jar), CODEATLAS_TS_ANALYZER (main.js) and CODEATLAS_INFRA_ANALYZER (binary).
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	scanpkg "codeatlas/core/internal/scan"
	"codeatlas/core/ir"
)

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	var err error
	switch os.Args[1] {
	case "scan":
		err = scan(os.Args[2:])
	case "upload":
		err = upload(os.Args[2:])
	case "validate":
		err = validate(os.Args[2:])
	case "-h", "--help", "help":
		usage()
	default:
		fmt.Fprintf(os.Stderr, "codeatlas: unknown command %q\n", os.Args[1])
		usage()
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "codeatlas:", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprint(os.Stderr, `usage:
  codeatlas scan <repo-dir> [--repo NAME] [--commit SHA] [--branch NAME] [--out-dir DIR] [--no-upload]
  codeatlas upload [--repo NAME] FILE...
  codeatlas validate FILE...

env: CODEATLAS_URL, CODEATLAS_TOKEN, CODEATLAS_JAVA_ANALYZER, CODEATLAS_TS_ANALYZER, CODEATLAS_INFRA_ANALYZER
`)
	os.Exit(2)
}

// ---- scan ----

func scan(args []string) error {
	fset := flag.NewFlagSet("scan", flag.ExitOnError)
	repo := fset.String("repo", "", "repo name in CodeAtlas (default: directory name)")
	commit := fset.String("commit", "", "commit sha (default: git HEAD)")
	branch := fset.String("branch", "", "branch (default: current git branch)")
	outDir := fset.String("out-dir", "", "keep IR files here (default: temp dir)")
	noUpload := fset.Bool("no-upload", false, "only run analyzers and validate")
	dir, rest := splitPositional(args)
	fset.Parse(rest)
	if dir == "" {
		return errors.New("scan: repo directory required")
	}
	root, err := filepath.Abs(dir)
	if err != nil {
		return err
	}
	if *repo == "" {
		*repo = filepath.Base(root)
	}
	if *commit == "" {
		*commit = gitOut(root, "rev-parse", "HEAD")
		if *commit == "" {
			return errors.New("scan: not a git checkout; pass --commit")
		}
	}
	if *branch == "" {
		*branch = gitOut(root, "rev-parse", "--abbrev-ref", "HEAD")
	}
	if *outDir == "" {
		if *outDir, err = os.MkdirTemp("", "codeatlas-ir-"); err != nil {
			return err
		}
		defer os.RemoveAll(*outDir)
	} else if err := os.MkdirAll(*outDir, 0o755); err != nil {
		return err
	}

	var client *apiClient
	if !*noUpload {
		if client, err = newClient(); err != nil {
			return err
		}
	}

	opts := scanpkg.Options{Root: root, Repo: *repo, Commit: *commit, Branch: *branch, OutDir: *outDir, Log: os.Stderr}
	return scanpkg.Run(context.Background(), opts, func(lang string, _ *ir.Document, path string) error {
		if client == nil {
			return nil
		}
		if err := client.uploadSnapshot(*repo, path); err != nil {
			return fmt.Errorf("upload %s: %w", lang, err)
		}
		return nil
	})
}

// ---- upload / validate ----

func upload(args []string) error {
	fset := flag.NewFlagSet("upload", flag.ExitOnError)
	repo := fset.String("repo", "", "repo name (default: source.repo of each file)")
	fset.Parse(args)
	if fset.NArg() == 0 {
		return errors.New("upload: no files")
	}
	client, err := newClient()
	if err != nil {
		return err
	}
	for _, f := range fset.Args() {
		doc, err := scanpkg.ReadDoc(f, os.Stderr)
		if err != nil {
			return fmt.Errorf("%s: %w", f, err)
		}
		name := *repo
		if name == "" {
			name = doc.Source.Repo
		}
		if err := client.uploadSnapshot(name, f); err != nil {
			return fmt.Errorf("%s: %w", f, err)
		}
	}
	return nil
}

func validate(files []string) error {
	if len(files) == 0 {
		return errors.New("validate: no files")
	}
	bad := 0
	for _, f := range files {
		doc, err := scanpkg.ReadDoc(f, os.Stderr)
		if err != nil {
			bad++
			fmt.Fprintf(os.Stderr, "%s: %v\n", f, err)
			continue
		}
		fmt.Fprintf(os.Stderr, "%s: ok (%d nodes, %d edges)\n", f, len(doc.Nodes), len(doc.Edges))
	}
	if bad > 0 {
		return fmt.Errorf("%d invalid file(s)", bad)
	}
	return nil
}

// ---- API client ----

type apiClient struct {
	base, token string
	http        *http.Client
}

func newClient() (*apiClient, error) {
	base, token := os.Getenv("CODEATLAS_URL"), os.Getenv("CODEATLAS_TOKEN")
	if base == "" || token == "" {
		return nil, errors.New("set CODEATLAS_URL and CODEATLAS_TOKEN (or use --no-upload)")
	}
	return &apiClient{base: strings.TrimRight(base, "/"), token: token, http: &http.Client{Timeout: 5 * time.Minute}}, nil
}

func (c *apiClient) do(method, path string, body io.Reader) ([]byte, int, error) {
	req, err := http.NewRequest(method, c.base+path, body)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	out, err := io.ReadAll(resp.Body)
	return out, resp.StatusCode, err
}

func (c *apiClient) uploadSnapshot(repo, file string) error {
	data, err := os.ReadFile(file)
	if err != nil {
		return err
	}
	path := "/api/v1/repos/" + repo + "/snapshots"
	body, status, err := c.do(http.MethodPost, path, bytes.NewReader(data))
	if err != nil {
		return err
	}
	if status == http.StatusNotFound {
		// Register the repo on first upload (needs an admin token), then retry.
		reg, _ := json.Marshal(map[string]string{"name": repo})
		if rb, rs, err := c.do(http.MethodPost, "/api/v1/repos", bytes.NewReader(reg)); err != nil {
			return err
		} else if rs != http.StatusCreated && rs != http.StatusConflict {
			return fmt.Errorf("repo %q is not registered and could not be created (%d): %s", repo, rs, strings.TrimSpace(string(rb)))
		}
		fmt.Fprintf(os.Stderr, "codeatlas: registered repo %s\n", repo)
		body, status, err = c.do(http.MethodPost, path, bytes.NewReader(data))
		if err != nil {
			return err
		}
	}
	if status != http.StatusCreated {
		return fmt.Errorf("server returned %d: %s", status, strings.TrimSpace(string(body)))
	}
	var snap struct {
		ID, Analyzer         string
		NodeCount, EdgeCount int
	}
	json.Unmarshal(body, &snap)
	fmt.Fprintf(os.Stderr, "codeatlas: uploaded %s snapshot %s (%d nodes, %d edges)\n", snap.Analyzer, snap.ID, snap.NodeCount, snap.EdgeCount)
	return nil
}

// ---- helpers ----

func splitPositional(args []string) (string, []string) {
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		return args[0], args[1:]
	}
	return "", args
}

func gitOut(dir string, args ...string) string {
	out, err := exec.Command("git", append([]string{"-C", dir}, args...)...).Output()
	s := strings.TrimSpace(string(out))
	if err != nil || s == "HEAD" {
		return ""
	}
	return s
}
