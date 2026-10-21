package analysis

import (
	"context"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"codeatlas/core/internal/config"
	"codeatlas/core/internal/gitprofiles"
	"codeatlas/core/internal/store"
	"codeatlas/core/ir"
)

type memSaver struct {
	mu   sync.Mutex
	docs []*ir.Document
}

func (m *memSaver) SaveSnapshot(_ context.Context, _ string, doc *ir.Document) (*store.Snapshot, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.docs = append(m.docs, doc)
	return &store.Snapshot{NodeCount: len(doc.Nodes), EdgeCount: len(doc.Edges)}, nil
}

// fakeAnalyzer installs a stand-in infra analyzer that writes a one-node IR document
// after sleeping for delay seconds.
func fakeAnalyzer(t *testing.T, delay int) {
	t.Helper()
	script := filepath.Join(t.TempDir(), "infra.sh")
	body := `#!/bin/sh
sleep ` + strconv.Itoa(delay) + ` </dev/null >/dev/null 2>&1
shift
while [ $# -gt 1 ]; do case $1 in --repo) repo=$2;; --commit) commit=$2;; --out) out=$2;; esac; shift 2; done
printf '{"irVersion":"1","source":{"repo":"%s","commit":"%s","analyzer":{"name":"infra","version":"test"}},"nodes":[{"id":"svc:x","kind":"service","name":"x"}],"edges":[]}' "$repo" "$commit" > "$out"
`
	if err := os.WriteFile(script, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CODEATLAS_INFRA_ANALYZER", script)
}

// gitRepo creates a one-commit repository and returns its path and HEAD sha.
func gitRepo(t *testing.T) (string, string) {
	t.Helper()
	dir := t.TempDir()
	run := func(args ...string) string {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@example.com",
			"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@example.com")
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	run("init", "-q", "-b", "trunk")
	os.WriteFile(filepath.Join(dir, "docker-compose.yml"), []byte("services:\n  x:\n    image: nginx\n"), 0o644)
	run("add", ".")
	run("commit", "-q", "-m", "init")
	return dir, run("rev-parse", "HEAD")
}

func newRunner(saver Saver) *Runner {
	return NewRunner(config.Analysis{Timeout: time.Minute}, saver, nil, slog.New(slog.NewTextHandler(io.Discard, nil)))
}

func wait(t *testing.T, r *Runner, repoID string) Job {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		if j, _ := r.Get(repoID, true); !j.State.Active() {
			return j
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("analysis did not finish")
	return Job{}
}

func TestAnalyzeClonesAndStores(t *testing.T) {
	fakeAnalyzer(t, 0)
	src, head := gitRepo(t)
	saver := &memSaver{}
	r := newRunner(saver)
	defer r.Close()

	repo := store.Repo{ID: "r1", Name: "svc", URL: src}
	if _, err := r.Start(repo); err != nil {
		t.Fatal(err)
	}
	j := wait(t, r, "r1")
	if j.State != Succeeded || j.Commit != head || j.Branch != "trunk" || len(j.Stored) != 1 || j.Stored[0] != "infra" {
		t.Fatalf("job = %+v", j)
	}
	if len(saver.docs) != 1 || saver.docs[0].Source.Repo != "svc" || saver.docs[0].Source.Commit != head {
		t.Fatalf("saved = %+v", saver.docs)
	}
	if all := r.Jobs(); len(all["r1"].Log) != 0 {
		t.Fatal("Jobs() should not include logs")
	}
}

func TestAnalyzeReportsCloneFailure(t *testing.T) {
	r := newRunner(&memSaver{})
	defer r.Close()

	if _, err := r.Start(store.Repo{ID: "r1", Name: "svc"}); err != ErrNoURL {
		t.Fatalf("no URL: err = %v", err)
	}
	r.Start(store.Repo{ID: "r1", Name: "svc", URL: filepath.Join(t.TempDir(), "missing")})
	j := wait(t, r, "r1")
	if j.State != Failed || !strings.HasPrefix(j.Error, "git clone: fatal:") {
		t.Fatalf("job = %+v", j)
	}
}

func TestAnalyzeCancel(t *testing.T) {
	fakeAnalyzer(t, 9)
	src, _ := gitRepo(t)
	r := newRunner(&memSaver{})
	defer r.Close()

	repo := store.Repo{ID: "r1", Name: "svc", URL: src}
	r.Start(repo)
	if _, err := r.Start(repo); err != ErrBusy {
		t.Fatalf("second start: err = %v", err)
	}
	for {
		if j, _ := r.Get("r1", false); j.State == Analyzing {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	// A second repo waits for the first one's slot (started only now: the two would race for it).
	r.Start(store.Repo{ID: "r2", Name: "other", URL: src})
	if j, _ := r.Get("r2", false); j.State != Queued {
		t.Fatalf("r2 = %s", j.State)
	}
	start := time.Now()
	if !r.Cancel("r1") || !r.Cancel("r2") {
		t.Fatal("cancel found nothing to cancel")
	}
	if j := wait(t, r, "r1"); j.State != Canceled {
		t.Fatalf("r1 = %+v", j)
	}
	if j := wait(t, r, "r2"); j.State != Canceled || j.StartedAt != nil {
		t.Fatalf("r2 = %+v", j)
	}
	if time.Since(start) > 8*time.Second {
		t.Fatal("cancel did not stop the analyzer")
	}
	if r.Cancel("r1") {
		t.Fatal("cancel of a finished job")
	}
}

func TestRedactURL(t *testing.T) {
	for in, want := range map[string]string{
		"https://user:tok@github.com/a/b": "https://github.com/a/b",
		"https://github.com/a/b":          "https://github.com/a/b",
		"git@github.com:a/b.git":          "git@github.com:a/b.git",
	} {
		if got := redactURL(in); got != want {
			t.Errorf("redactURL(%q) = %q", in, got)
		}
	}
}

func TestAnalyzeWithGitProfile(t *testing.T) {
	fakeAnalyzer(t, 0)
	src, head := gitRepo(t)
	dir := t.TempDir()
	keys := filepath.Join(dir, "ssh")
	profiles := gitprofiles.New(filepath.Join(dir, "profiles"), keys)
	if _, err := profiles.Add(context.Background(), gitprofiles.Profile{Name: "work", UserName: "R", Email: "r@w.com"}, true); err != nil {
		t.Fatal(err)
	}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))

	// a known profile: the clone runs with its key (a local path needs no SSH, so it succeeds)
	r := NewRunner(config.Analysis{Timeout: time.Minute}, &memSaver{}, profiles, log)
	defer r.Close()
	r.Start(store.Repo{ID: "r1", Name: "svc", URL: src, GitProfile: "work"})
	if j := wait(t, r, "r1"); j.State != Succeeded || j.Commit != head || !strings.Contains(strings.Join(j.Log, "\n"), "using git profile work") {
		t.Fatalf("job = %+v", j)
	}
	// a profile that is gone, or a server without profiles: a clear failure, nothing cloned
	r.Start(store.Repo{ID: "r2", Name: "svc", URL: src, GitProfile: "personal"})
	if j := wait(t, r, "r2"); j.State != Failed || j.Error != `git profile "personal": no such git profile` {
		t.Fatalf("missing profile: %+v", j)
	}
	bare := NewRunner(config.Analysis{Timeout: time.Minute}, &memSaver{}, nil, log)
	defer bare.Close()
	bare.Start(store.Repo{ID: "r3", Name: "svc", URL: src, GitProfile: "work"})
	if j := wait(t, bare, "r3"); j.State != Failed || !strings.Contains(j.Error, "no git profiles") {
		t.Fatalf("no profiles: %+v", j)
	}
}
