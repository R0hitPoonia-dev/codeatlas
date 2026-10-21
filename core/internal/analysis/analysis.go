// Package analysis clones registered repos and runs the analyzers on the server, so a
// repo can be indexed from the UI without a local checkout or a CI job.
package analysis

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"codeatlas/core/internal/config"
	"codeatlas/core/internal/gitprofiles"
	"codeatlas/core/internal/scan"
	"codeatlas/core/internal/store"
	"codeatlas/core/ir"
)

type State string

const (
	Queued    State = "queued"
	Cloning   State = "cloning"
	Analyzing State = "analyzing"
	Succeeded State = "succeeded"
	Failed    State = "failed"
	Canceled  State = "canceled"
)

func (s State) Active() bool { return s == Queued || s == Cloning || s == Analyzing }

// Job is one analysis run of a repo. Jobs are kept in memory only: after a restart the
// stored snapshots remain but the run history and logs are gone.
type Job struct {
	Repo       string     `json:"repo"`
	State      State      `json:"state"`
	Commit     string     `json:"commit,omitempty"`
	Branch     string     `json:"branch,omitempty"`
	Stored     []string   `json:"stored"` // analyzers whose snapshots were saved
	Error      string     `json:"error,omitempty"`
	QueuedAt   time.Time  `json:"queuedAt"`
	StartedAt  *time.Time `json:"startedAt,omitempty"`
	FinishedAt *time.Time `json:"finishedAt,omitempty"`
	Log        []string   `json:"log,omitempty"`
}

var (
	ErrBusy  = errors.New("an analysis of this repo is already queued or running")
	ErrNoURL = errors.New("repo has no git URL to clone")
)

// Saver stores analyzer output; *store.Store implements it.
type Saver interface {
	SaveSnapshot(ctx context.Context, repoID string, doc *ir.Document) (*store.Snapshot, error)
}

const (
	maxLogLines = 400
	maxLineLen  = 1000
)

// Runner runs analyses in the background, one at a time; the rest wait in a queue.
type Runner struct {
	cfg      config.Analysis
	saver    Saver
	profiles *gitprofiles.Store // may be nil: repos with a git profile then fail to clone
	log      *slog.Logger
	ctx      context.Context
	stop     context.CancelFunc
	wg       sync.WaitGroup
	slots    chan struct{}

	mu   sync.Mutex
	jobs map[string]*job // latest job per repo ID
}

type job struct {
	Job
	cancel context.CancelFunc
}

func NewRunner(cfg config.Analysis, saver Saver, profiles *gitprofiles.Store, log *slog.Logger) *Runner {
	ctx, stop := context.WithCancel(context.Background())
	return &Runner{cfg: cfg, saver: saver, profiles: profiles, log: log, ctx: ctx, stop: stop,
		slots: make(chan struct{}, 1), jobs: map[string]*job{}}
}

// Close cancels every queued and running analysis and waits for them to stop.
func (r *Runner) Close() {
	r.stop()
	r.wg.Wait()
}

// Start queues an analysis of the head of repo's remote default branch.
func (r *Runner) Start(repo store.Repo) (Job, error) {
	if repo.URL == "" {
		return Job{}, ErrNoURL
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if j := r.jobs[repo.ID]; j != nil && j.State.Active() {
		return Job{}, ErrBusy
	}
	ctx, cancel := context.WithCancel(r.ctx)
	j := &job{Job: Job{Repo: repo.Name, State: Queued, Stored: []string{}, QueuedAt: time.Now()}, cancel: cancel}
	r.jobs[repo.ID] = j
	r.wg.Add(1)
	go func() {
		defer r.wg.Done()
		defer cancel()
		r.run(ctx, j, repo)
	}()
	return j.copy(true), nil
}

// Get returns the latest job for a repo, with its log if withLog.
func (r *Runner) Get(repoID string, withLog bool) (Job, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	j := r.jobs[repoID]
	if j == nil {
		return Job{}, false
	}
	return j.copy(withLog), true
}

// Jobs returns the latest job of every repo that has one, by repo ID, without logs.
func (r *Runner) Jobs() map[string]Job {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make(map[string]Job, len(r.jobs))
	for id, j := range r.jobs {
		out[id] = j.copy(false)
	}
	return out
}

// Cancel stops the repo's queued or running analysis. It reports whether there was one.
func (r *Runner) Cancel(repoID string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	j := r.jobs[repoID]
	if j == nil || !j.State.Active() {
		return false
	}
	j.cancel()
	return true
}

func (j *job) copy(withLog bool) Job {
	c := j.Job
	c.Stored = append([]string{}, j.Stored...)
	c.Log = nil
	if withLog {
		c.Log = append([]string{}, j.Log...)
	}
	return c
}

func (r *Runner) update(j *job, f func(*Job)) {
	r.mu.Lock()
	defer r.mu.Unlock()
	f(&j.Job)
}

func (r *Runner) run(ctx context.Context, j *job, repo store.Repo) {
	logw := &logWriter{r: r, j: j}
	err := func() error {
		select {
		case r.slots <- struct{}{}:
		case <-ctx.Done():
			return ctx.Err()
		}
		defer func() { <-r.slots }()
		if r.cfg.Timeout > 0 {
			var cancel context.CancelFunc
			ctx, cancel = context.WithTimeout(ctx, r.cfg.Timeout)
			defer cancel()
		}
		err := r.analyze(ctx, j, repo, logw)
		if err != nil && ctx.Err() != nil {
			err = ctx.Err() // a killed git or analyzer reports "signal: killed"; say why
		}
		return err
	}()
	logw.flush()

	r.mu.Lock()
	defer r.mu.Unlock()
	now := time.Now()
	j.FinishedAt = &now
	switch {
	case err == nil:
		j.State = Succeeded
	case errors.Is(err, context.Canceled):
		j.State, j.Error = Canceled, "canceled"
	case errors.Is(err, context.DeadlineExceeded):
		j.State, j.Error = Failed, fmt.Sprintf("timed out after %s", r.cfg.Timeout)
	default:
		j.State, j.Error = Failed, err.Error()
	}
	r.log.Info("analysis finished", "repo", repo.Name, "state", j.State, "commit", j.Commit,
		"stored", j.Stored, "err", j.Error)
}

func (r *Runner) analyze(ctx context.Context, j *job, repo store.Repo, logw io.Writer) error {
	now := time.Now()
	r.update(j, func(j *Job) { j.State, j.StartedAt = Cloning, &now })

	dir, err := os.MkdirTemp("", "codeatlas-analysis-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	src, outDir := filepath.Join(dir, "src"), filepath.Join(dir, "ir")
	if err := os.Mkdir(outDir, 0o700); err != nil {
		return err
	}

	auth, err := r.auth(repo, logw)
	if err != nil {
		return err
	}
	fmt.Fprintf(logw, "cloning %s\n", redactURL(repo.URL))
	if _, err := r.git(ctx, "", logw, auth, "clone", "--depth=1", "--quiet", "--", repo.URL, src); err != nil {
		return err
	}
	commit, err := r.git(ctx, src, logw, auth, "rev-parse", "HEAD")
	if err != nil {
		return err
	}
	branch, _ := r.git(ctx, src, logw, auth, "rev-parse", "--abbrev-ref", "HEAD")
	if branch == "HEAD" {
		branch = ""
	}
	r.update(j, func(j *Job) { j.State, j.Commit, j.Branch = Analyzing, commit, branch })

	opts := scan.Options{Root: src, Repo: repo.Name, Commit: commit, Branch: branch, OutDir: outDir, Log: logw}
	return scan.Run(ctx, opts, func(lang string, doc *ir.Document, _ string) error {
		snap, err := r.saver.SaveSnapshot(ctx, repo.ID, doc)
		if err != nil {
			return fmt.Errorf("store %s snapshot: %w", lang, err)
		}
		fmt.Fprintf(logw, "stored %s snapshot: %d nodes, %d edges\n", lang, snap.NodeCount, snap.EdgeCount)
		r.update(j, func(j *Job) { j.Stored = append(j.Stored, lang) })
		return nil
	})
}

// gitAuth is how a clone authenticates: a git profile's SSH key, or (zero value) the server's
// token / the server user's own credentials.
type gitAuth struct {
	sshCommand string
}

// auth resolves the repo's git profile, if it has one.
func (r *Runner) auth(repo store.Repo, logw io.Writer) (gitAuth, error) {
	if repo.GitProfile == "" {
		return gitAuth{}, nil
	}
	if r.profiles == nil {
		return gitAuth{}, fmt.Errorf("git profile %q: this server has no git profiles", repo.GitProfile)
	}
	p, err := r.profiles.Get(repo.GitProfile)
	if err != nil {
		return gitAuth{}, fmt.Errorf("git profile %q: %w", repo.GitProfile, err)
	}
	if !p.KeyExists {
		return gitAuth{}, fmt.Errorf("git profile %q: SSH key %s does not exist", p.Name, p.KeyPath)
	}
	fmt.Fprintf(logw, "using git profile %s (%s)\n", p.Name, p.KeyPath)
	return gitAuth{sshCommand: r.profiles.SSHCommand(p)}, nil
}

// git runs a git command that can never stop to ask for credentials, and returns its
// trimmed stdout. Errors carry git's last stderr line, e.g. "fatal: repository not found".
func (r *Runner) git(ctx context.Context, dir string, logw io.Writer, auth gitAuth, args ...string) (string, error) {
	var argv []string
	env := append(os.Environ(), "GIT_TERMINAL_PROMPT=0", "GIT_ASKPASS=", "GCM_INTERACTIVE=never")
	switch {
	case auth.sshCommand != "":
		// the profile's key, also for https://github.com/... URLs (as the terminal helper does)
		env = append(env, "GIT_SSH_COMMAND="+auth.sshCommand)
		argv = append(argv, "-c", "url.git@github.com:.insteadOf=https://github.com/")
	case os.Getenv("GIT_SSH_COMMAND") == "":
		env = append(env, "GIT_SSH_COMMAND=ssh -o BatchMode=yes")
	}
	if r.cfg.GitToken != "" && auth.sshCommand == "" {
		// Replace the user's credential helpers (which may pop up a keychain dialog) with
		// one that answers only for GitHost. The token travels in the environment, not argv.
		argv = append(argv, "-c", "credential.helper=",
			"-c", "credential.https://"+r.cfg.GitHost+".helper="+
				`!f() { test "$1" = get && echo username=x-access-token && echo "password=$CODEATLAS_GIT_TOKEN"; }; f`)
		env = append(env, "CODEATLAS_GIT_TOKEN="+r.cfg.GitToken)
	}
	cmd := exec.CommandContext(ctx, "git", append(argv, args...)...)
	cmd.Dir, cmd.Env, cmd.WaitDelay = dir, env, 5*time.Second
	var stderr bytes.Buffer
	cmd.Stderr = io.MultiWriter(logw, &stderr)
	out, err := cmd.Output()
	if err != nil {
		if errors.Is(err, exec.ErrNotFound) {
			return "", errors.New("git is not installed on the server")
		}
		if msg := lastLine(stderr.String()); msg != "" {
			return "", fmt.Errorf("git %s: %s", args[0], msg)
		}
		return "", fmt.Errorf("git %s: %w", args[0], err)
	}
	return strings.TrimSpace(string(out)), nil
}

// redactURL drops any credentials embedded in an http(s) URL before it is logged.
func redactURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.User == nil {
		return raw
	}
	u.User = nil
	return u.String()
}

func lastLine(s string) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	return strings.TrimSpace(lines[len(lines)-1])
}

// logWriter appends output to the job's log one line at a time, keeping the last maxLogLines.
type logWriter struct {
	r       *Runner
	j       *job
	partial []byte
}

func (w *logWriter) Write(p []byte) (int, error) {
	w.r.mu.Lock()
	defer w.r.mu.Unlock()
	w.partial = append(w.partial, p...)
	for {
		i := bytes.IndexAny(w.partial, "\r\n")
		if i < 0 {
			break
		}
		w.add(string(w.partial[:i]))
		w.partial = w.partial[i+1:]
	}
	if len(w.partial) > maxLineLen {
		w.add(string(w.partial))
		w.partial = nil
	}
	return len(p), nil
}

func (w *logWriter) flush() {
	w.r.mu.Lock()
	defer w.r.mu.Unlock()
	w.add(string(w.partial))
	w.partial = nil
}

// add must be called with w.r.mu held.
func (w *logWriter) add(line string) {
	line = strings.TrimRight(line, " \t")
	if line == "" {
		return
	}
	if len(line) > maxLineLen {
		line = line[:maxLineLen] + "…"
	}
	w.j.Log = append(w.j.Log, line)
	if n := len(w.j.Log); n > maxLogLines {
		w.j.Log = append(w.j.Log[:0:0], w.j.Log[n-maxLogLines:]...)
	}
}
