package api

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"codeatlas/core/internal/analysis"
	"codeatlas/core/internal/auth"
	"codeatlas/core/internal/config"
	"codeatlas/core/internal/store"
)

// newTestServer runs against CODEATLAS_TEST_DATABASE_URL in a throwaway schema.
func newTestServer(t *testing.T) (*httptest.Server, *store.Store) {
	t.Helper()
	dbURL := os.Getenv("CODEATLAS_TEST_DATABASE_URL")
	if dbURL == "" {
		t.Skip("CODEATLAS_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()

	b := make([]byte, 6)
	rand.Read(b)
	schema := "test_" + hex.EncodeToString(b)
	admin, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		admin.Exec(context.Background(), "DROP SCHEMA "+schema+" CASCADE")
		admin.Close()
	})

	cfg, err := pgxpool.ParseConfig(dbURL)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	st, err := store.OpenConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(st.Close)
	for range 2 { // migrations must be idempotent
		if err := st.Migrate(ctx); err != nil {
			t.Fatal(err)
		}
	}

	// git profiles live in a temp dir: never the real ~/.git-profiles and ~/.ssh
	gitDir := t.TempDir()
	appCfg := config.Config{SessionTTL: time.Hour, MaxUploadBytes: 10 << 20, Analysis: config.Analysis{
		GitProfiles: filepath.Join(gitDir, "git-profiles"), SSHDir: filepath.Join(gitDir, "ssh")}}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := httptest.NewServer(New(appCfg, st, nil, log).Handler())
	t.Cleanup(srv.Close)
	return srv, st
}

func createUser(t *testing.T, st *store.Store, email string, role store.Role) {
	t.Helper()
	hash, err := auth.HashPassword("password-123456")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.CreateUser(context.Background(), email, hash, role); err != nil {
		t.Fatal(err)
	}
}

type client struct {
	t     *testing.T
	base  string
	token string
}

func (c *client) do(method, path string, body any) (int, []byte) {
	c.t.Helper()
	var r io.Reader
	switch b := body.(type) {
	case nil:
	case []byte:
		r = bytes.NewReader(b)
	default:
		j, _ := json.Marshal(b)
		r = bytes.NewReader(j)
	}
	req, _ := http.NewRequest(method, c.base+path, r)
	req.Header.Set("Content-Type", "application/json")
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer resp.Body.Close()
	out, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, out
}

func (c *client) mustDo(method, path string, body any, wantStatus int, into any) {
	c.t.Helper()
	status, out := c.do(method, path, body)
	if status != wantStatus {
		c.t.Fatalf("%s %s: want %d, got %d: %s", method, path, wantStatus, status, out)
	}
	if into != nil {
		if err := json.Unmarshal(out, into); err != nil {
			c.t.Fatalf("%s %s: decode: %v: %s", method, path, err, out)
		}
	}
}

func login(t *testing.T, base, email string) *client {
	t.Helper()
	c := &client{t: t, base: base}
	var res loginResponse
	c.mustDo("POST", "/api/v1/auth/login", loginRequest{email, "password-123456"}, 200, &res)
	c.token = res.Token
	return c
}

func TestSnapshotLifecycle(t *testing.T) {
	srv, st := newTestServer(t)
	createUser(t, st, "admin@example.com", store.RoleAdmin)
	c := login(t, srv.URL, "ADMIN@example.com") // email is case-insensitive

	var me store.User
	c.mustDo("GET", "/api/v1/me", nil, 200, &me)
	if me.Role != store.RoleAdmin {
		t.Fatalf("role = %s", me.Role)
	}

	c.mustDo("POST", "/api/v1/repos", map[string]string{"name": "orders-service"}, 201, nil)
	c.mustDo("POST", "/api/v1/repos", map[string]string{"name": "orders-service"}, 409, nil)

	fixture, err := os.ReadFile("../../../ir/fixtures/orders-service.java.json")
	if err != nil {
		t.Fatal(err)
	}
	var snap store.Snapshot
	c.mustDo("POST", "/api/v1/repos/orders-service/snapshots", fixture, 201, &snap)
	if snap.NodeCount != 12 || snap.EdgeCount != 6 {
		t.Fatalf("counts = %d nodes, %d edges", snap.NodeCount, snap.EdgeCount)
	}

	// Re-uploading the same commit+analyzer replaces the snapshot.
	c.mustDo("POST", "/api/v1/repos/orders-service/snapshots", fixture, 201, &snap)
	var snaps []store.Snapshot
	c.mustDo("GET", "/api/v1/repos/orders-service/snapshots", nil, 200, &snaps)
	if len(snaps) != 1 || snaps[0].ID != snap.ID {
		t.Fatalf("snapshots = %+v", snaps)
	}

	var g store.Graph
	c.mustDo("GET", "/api/v1/snapshots/"+snap.ID+"/graph", nil, 200, &g)
	if len(g.Nodes) != 12 || len(g.Edges) != 6 {
		t.Fatalf("graph = %d nodes, %d edges", len(g.Nodes), len(g.Edges))
	}
	found := false
	for _, n := range g.Nodes {
		if n.ID == "method:com.acme.orders.OrderService#find(long)" {
			found = true
			if n.OTel["code.function"] != "find" || n.Location == nil || *n.Location.StartLine != 18 {
				t.Fatalf("node round-trip lost data: %+v", n)
			}
		}
	}
	if !found {
		t.Fatal("method node missing")
	}

	c.mustDo("GET", "/api/v1/snapshots/"+snap.ID+"/graph?kind=method&kind=table", nil, 200, &g)
	if len(g.Nodes) != 3 || len(g.Edges) != 2 { // 2 methods + table; calls + reads
		t.Fatalf("filtered graph = %d nodes, %d edges: %+v", len(g.Nodes), len(g.Edges), g.Edges)
	}

	// A second analyzer for the same commit is merged into the repo graph.
	infra := map[string]any{
		"irVersion": "1",
		"source":    map[string]any{"repo": "orders-service", "commit": "3f2a9c1", "analyzer": map[string]string{"name": "infra", "version": "test"}},
		"nodes": []map[string]any{
			{"id": "svc:orders-service", "kind": "service", "name": "orders-service", "attrs": map[string]any{"path": "."}},
			{"id": "ctr:orders", "kind": "container", "name": "orders", "attrs": map[string]any{"buildContext": "."}},
		},
		"edges": []any{},
	}
	c.mustDo("POST", "/api/v1/repos/orders-service/snapshots", infra, 201, nil)
	var commits []store.Commit
	c.mustDo("GET", "/api/v1/repos/orders-service/commits", nil, 200, &commits)
	if len(commits) != 1 || len(commits[0].Analyzers) != 2 {
		t.Fatalf("commits = %+v", commits)
	}
	var rg struct {
		Commit    string
		Snapshots []store.Snapshot
		store.Graph
	}
	c.mustDo("GET", "/api/v1/repos/orders-service/graph", nil, 200, &rg)
	if rg.Commit != "3f2a9c1" || len(rg.Snapshots) != 2 || len(rg.Nodes) != 13 {
		t.Fatalf("repo graph: commit=%s snaps=%d nodes=%d", rg.Commit, len(rg.Snapshots), len(rg.Nodes))
	}
	deploys := false
	for _, e := range rg.Edges {
		deploys = deploys || (e.Kind == "deploys" && e.Source == "ctr:orders" && e.Target == "svc:orders-service")
	}
	if !deploys {
		t.Fatal("container not linked to service")
	}
	c.mustDo("GET", "/api/v1/repos/orders-service/graph?commit=nope", nil, 404, nil)

	c.mustDo("GET", "/api/v1/snapshots/not-a-uuid", nil, 404, nil)
	c.mustDo("GET", "/api/v1/snapshots/00000000-0000-0000-0000-000000000000", nil, 404, nil)
}

func TestSnapshotRejections(t *testing.T) {
	srv, st := newTestServer(t)
	createUser(t, st, "admin@example.com", store.RoleAdmin)
	c := login(t, srv.URL, "admin@example.com")
	c.mustDo("POST", "/api/v1/repos", map[string]string{"name": "other"}, 201, nil)

	fixture, _ := os.ReadFile("../../../ir/fixtures/orders-service.java.json")
	c.mustDo("POST", "/api/v1/repos/missing/snapshots", fixture, 404, nil)
	// source.repo says orders-service, path says other
	c.mustDo("POST", "/api/v1/repos/other/snapshots", fixture, 422, nil)

	bad := bytes.Replace(fixture, []byte(`"kind": "handles"`), []byte(`"kind": "likes"`), 1)
	var errBody apiError
	c.mustDo("POST", "/api/v1/repos/other/snapshots", bad, 422, &errBody)
	if !strings.Contains(string(mustJSON(errBody.Details)), "likes") {
		t.Fatalf("details = %v", errBody.Details)
	}
	c.mustDo("POST", "/api/v1/repos/other/snapshots", []byte(`{nope`), 400, nil)
}

func TestAuthRules(t *testing.T) {
	srv, st := newTestServer(t)
	createUser(t, st, "admin@example.com", store.RoleAdmin)
	createUser(t, st, "dev@example.com", store.RoleMember)

	anon := &client{t: t, base: srv.URL}
	anon.mustDo("GET", "/api/v1/repos", nil, 401, nil)
	anon.mustDo("POST", "/api/v1/auth/login", loginRequest{"dev@example.com", "wrong-password-1"}, 401, nil)
	anon.mustDo("POST", "/api/v1/auth/login", loginRequest{"nobody@example.com", "password-123456"}, 401, nil)
	anon.mustDo("GET", "/api/v1/nope", nil, 404, nil)

	dev := login(t, srv.URL, "dev@example.com")
	dev.mustDo("GET", "/api/v1/repos", nil, 200, nil)
	dev.mustDo("POST", "/api/v1/repos", map[string]string{"name": "x"}, 403, nil)
	dev.mustDo("GET", "/api/v1/users", nil, 403, nil)

	// API tokens work as bearer tokens.
	var tok map[string]string
	dev.mustDo("POST", "/api/v1/tokens", map[string]string{"name": "ci"}, 201, &tok)
	ci := &client{t: t, base: srv.URL, token: tok["token"]}
	ci.mustDo("GET", "/api/v1/me", nil, 200, nil)

	// Logout revokes the session.
	dev.mustDo("POST", "/api/v1/auth/logout", nil, 204, nil)
	dev.mustDo("GET", "/api/v1/me", nil, 401, nil)

	admin := login(t, srv.URL, "admin@example.com")
	admin.mustDo("POST", "/api/v1/users", map[string]string{"email": "new@example.com", "password": "short"}, 400, nil)
	admin.mustDo("POST", "/api/v1/users", map[string]string{"email": "new@example.com", "password": "password-123456"}, 201, nil)
	admin.mustDo("POST", "/api/v1/users", map[string]string{"email": "NEW@example.com", "password": "password-123456"}, 409, nil)
}

func TestCookieWritesRequireJSON(t *testing.T) {
	srv, st := newTestServer(t)
	createUser(t, st, "admin@example.com", store.RoleAdmin)
	c := login(t, srv.URL, "admin@example.com")

	post := func(contentType string) int {
		req, _ := http.NewRequest("POST", srv.URL+"/api/v1/repos", strings.NewReader(`{"name":"r`+contentType[:4]+`"}`))
		req.Header.Set("Content-Type", contentType)
		req.AddCookie(&http.Cookie{Name: sessionCookie, Value: c.token})
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp.StatusCode
	}
	if got := post("text/plain"); got != http.StatusUnsupportedMediaType {
		t.Errorf("text/plain via cookie: got %d", got)
	}
	if got := post("application/json"); got != http.StatusCreated {
		t.Errorf("json via cookie: got %d", got)
	}
}

func mustJSON(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}

func TestServerSideAnalysis(t *testing.T) {
	srv, st := newTestServer(t)
	createUser(t, st, "admin@example.com", store.RoleAdmin)
	createUser(t, st, "dev@example.com", store.RoleMember)
	admin := login(t, srv.URL, "admin@example.com")
	dev := login(t, srv.URL, "dev@example.com")

	// A local repo with one compose file, and a stand-in infra analyzer.
	src := t.TempDir()
	gitEnv := append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@example.com",
		"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@example.com")
	for _, args := range [][]string{{"init", "-q"}, {"add", "."}, {"commit", "-q", "-m", "init"}} {
		if args[0] == "add" {
			os.WriteFile(src+"/docker-compose.yml", []byte("services:\n  web:\n    image: nginx\n"), 0o644)
		}
		cmd := exec.Command("git", args...)
		cmd.Dir, cmd.Env = src, gitEnv
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	script := t.TempDir() + "/infra.sh"
	os.WriteFile(script, []byte(`#!/bin/sh
shift
while [ $# -gt 1 ]; do case $1 in --repo) repo=$2;; --commit) commit=$2;; --out) out=$2;; esac; shift 2; done
printf '{"irVersion":"1","source":{"repo":"%s","commit":"%s","analyzer":{"name":"infra","version":"test"}},"nodes":[{"id":"svc:web","kind":"service","name":"web"}],"edges":[]}' "$repo" "$commit" > "$out"
`), 0o755)
	t.Setenv("CODEATLAS_INFRA_ANALYZER", script)

	admin.mustDo("POST", "/api/v1/repos", map[string]string{"name": "web"}, 201, nil)
	admin.mustDo("POST", "/api/v1/repos/web/analysis", nil, 400, nil) // no URL yet
	admin.mustDo("GET", "/api/v1/repos/web/analysis", nil, 404, nil)
	admin.mustDo("PATCH", "/api/v1/repos/web", map[string]string{"url": "--upload-pack=x"}, 400, nil)
	dev.mustDo("PATCH", "/api/v1/repos/web", map[string]string{"url": src}, 403, nil)
	var repo repoResponse
	admin.mustDo("PATCH", "/api/v1/repos/web", map[string]string{"url": src}, 200, &repo)
	if repo.URL != src || repo.DefaultBranch != "main" || repo.LastCommit != "" {
		t.Fatalf("patched repo = %+v", repo)
	}

	dev.mustDo("POST", "/api/v1/repos/web/analysis", nil, 403, nil)
	admin.mustDo("POST", "/api/v1/repos/web/analysis", nil, 202, nil)
	var job analysis.Job
	for deadline := time.Now().Add(30 * time.Second); ; time.Sleep(50 * time.Millisecond) {
		dev.mustDo("GET", "/api/v1/repos/web/analysis", nil, 200, &job)
		if !job.State.Active() || time.Now().After(deadline) {
			break
		}
	}
	if job.State != analysis.Succeeded || len(job.Log) == 0 {
		t.Fatalf("job = %+v", job)
	}
	admin.mustDo("DELETE", "/api/v1/repos/web/analysis", nil, 404, nil) // nothing running

	var repos []repoResponse
	dev.mustDo("GET", "/api/v1/repos", nil, 200, &repos)
	if len(repos) != 1 || repos[0].LastCommit != job.Commit || repos[0].AnalyzedAt == nil ||
		repos[0].Analysis == nil || repos[0].Analysis.State != analysis.Succeeded || repos[0].Analysis.Log != nil {
		t.Fatalf("repos = %+v", repos)
	}
	var rg struct{ Nodes []map[string]any }
	dev.mustDo("GET", "/api/v1/repos/web/graph", nil, 200, &rg)
	if len(rg.Nodes) != 1 {
		t.Fatalf("graph nodes = %v", rg.Nodes)
	}
}

func TestGroupingConfigAndOverrides(t *testing.T) {
	srv, st := newTestServer(t)
	createUser(t, st, "admin@example.com", store.RoleAdmin)
	createUser(t, st, "dev@example.com", store.RoleMember)
	admin := login(t, srv.URL, "admin@example.com")
	dev := login(t, srv.URL, "dev@example.com")
	admin.mustDo("POST", "/api/v1/repos", map[string]string{"name": "ledger"}, 201, nil)

	// .codeatlas.yml arrives as the infra document's config and is served with the graph
	infra := map[string]any{
		"irVersion": "1",
		"source":    map[string]any{"repo": "ledger", "commit": "c1", "analyzer": map[string]string{"name": "infra", "version": "t"}},
		"nodes":     []map[string]any{{"id": "svc:ledger", "kind": "service", "name": "ledger"}},
		"edges":     []any{},
		"config":    map[string]any{"groups": []any{map[string]any{"name": "Trades", "members": []string{"com.acme.*"}}}},
	}
	admin.mustDo("POST", "/api/v1/repos/ledger/snapshots", infra, 201, nil)
	var g struct {
		Config map[string]any
	}
	dev.mustDo("GET", "/api/v1/repos/ledger/graph", nil, 200, &g)
	if groups, _ := g.Config["groups"].([]any); len(groups) != 1 {
		t.Fatalf("config = %#v", g.Config)
	}

	var o store.GroupOverrides
	dev.mustDo("GET", "/api/v1/repos/ledger/groups", nil, 200, &o)
	if len(o.Rename) != 0 || len(o.Assign) != 0 {
		t.Fatalf("initial overrides = %+v", o)
	}
	edit := map[string]any{"rename": map[string]string{"proc:thread": " Consumer threads ", "pipe:x": ""}, "assign": map[string]string{"method:a#run()": "Trades"},
		"levels": map[string]string{"Blocks": "Loops & error handling"}}
	dev.mustDo("PUT", "/api/v1/repos/ledger/groups", edit, 403, nil)
	admin.mustDo("PUT", "/api/v1/repos/ledger/groups", edit, 200, &o)
	dev.mustDo("GET", "/api/v1/repos/ledger/groups", nil, 200, &o)
	if o.Rename["proc:thread"] != "Consumer threads" || len(o.Rename) != 1 || o.Assign["method:a#run()"] != "Trades" ||
		o.Levels["Blocks"] != "Loops & error handling" {
		t.Fatalf("overrides = %+v", o)
	}
	admin.mustDo("PUT", "/api/v1/repos/ledger/groups", map[string]any{"rename": map[string]string{"x": strings.Repeat("n", 201)}}, 400, nil)
	admin.mustDo("PUT", "/api/v1/repos/ledger/groups", map[string]any{"colors": map[string]string{}}, 400, nil)
	admin.mustDo("GET", "/api/v1/repos/missing/groups", nil, 404, nil)
}

func TestGitProfiles(t *testing.T) {
	srv, st := newTestServer(t)
	createUser(t, st, "admin@example.com", store.RoleAdmin)
	createUser(t, st, "dev@example.com", store.RoleMember)
	admin := login(t, srv.URL, "admin@example.com")
	dev := login(t, srv.URL, "dev@example.com")

	var ps []map[string]any
	admin.mustDo("GET", "/api/v1/git-profiles", nil, 200, &ps)
	if len(ps) != 0 {
		t.Fatalf("profiles = %v", ps)
	}
	dev.mustDo("GET", "/api/v1/git-profiles", nil, 403, nil)
	dev.mustDo("POST", "/api/v1/git-profiles", map[string]any{"name": "x", "userName": "X", "email": "x@y.z", "generateKey": true}, 403, nil)

	var p map[string]any
	admin.mustDo("POST", "/api/v1/git-profiles", map[string]any{"name": "work", "userName": "Rohit", "email": "r@work.com", "generateKey": true}, 201, &p)
	if !strings.HasPrefix(p["publicKey"].(string), "ssh-ed25519 ") || p["keyExists"] != true {
		t.Fatalf("created = %v", p)
	}
	if _, leaked := p["privateKey"]; leaked {
		t.Fatal("private key in response")
	}
	admin.mustDo("POST", "/api/v1/git-profiles", map[string]any{"name": "work", "userName": "R", "email": "r@w.com", "generateKey": true}, 409, nil)
	admin.mustDo("POST", "/api/v1/git-profiles", map[string]any{"name": "bad name", "userName": "R", "email": "r@w.com", "generateKey": true}, 400, nil)
	admin.mustDo("POST", "/api/v1/git-profiles", map[string]any{"name": "etc", "userName": "R", "email": "r@w.com", "keyPath": "/etc/passwd"}, 400, nil)
	admin.mustDo("POST", "/api/v1/git-profiles/nope/test", nil, 404, nil)

	// repos pick a profile that exists
	admin.mustDo("POST", "/api/v1/repos", map[string]string{"name": "a", "url": "https://github.com/o/a", "gitProfile": "nope"}, 400, nil)
	var repo repoResponse
	admin.mustDo("POST", "/api/v1/repos", map[string]string{"name": "a", "url": "https://github.com/o/a", "gitProfile": "work"}, 201, &repo)
	if repo.GitProfile != "work" {
		t.Fatalf("repo = %+v", repo)
	}
	admin.mustDo("PATCH", "/api/v1/repos/a", map[string]string{"gitProfile": "missing"}, 400, nil)
	var cleared repoResponse
	admin.mustDo("PATCH", "/api/v1/repos/a", map[string]string{"gitProfile": ""}, 200, &cleared)
	if cleared.GitProfile != "" || cleared.URL != "https://github.com/o/a" {
		t.Fatalf("cleared repo = %+v", cleared)
	}
}
