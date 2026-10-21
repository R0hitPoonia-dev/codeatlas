package api

import (
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"

	"codeatlas/core/internal/analysis"
	"codeatlas/core/internal/auth"
	"codeatlas/core/internal/gitprofiles"
	"codeatlas/core/internal/graph"
	"codeatlas/core/internal/store"
	"codeatlas/core/ir"
)

func (s *Server) listCommits(w http.ResponseWriter, r *http.Request) error {
	repo, err := s.repoFromPath(r)
	if err != nil {
		return err
	}
	commits, err := s.store.ListCommits(r.Context(), repo.ID)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, commits)
	return nil
}

type repoGraphResponse struct {
	Commit    string           `json:"commit"`
	Snapshots []store.Snapshot `json:"snapshots"`
	// Config is the repo's .codeatlas.yml as uploaded with this commit (diagram groups).
	Config map[string]any `json:"config,omitempty"`
	*graph.Graph
}

// getRepoGraph merges every analyzer's snapshot for ?commit= (default: latest
// upload) into one graph; ?kind= filters node kinds after merging.
func (s *Server) getRepoGraph(w http.ResponseWriter, r *http.Request) error {
	repo, err := s.repoFromPath(r)
	if err != nil {
		return err
	}
	snaps, err := s.store.CommitSnapshots(r.Context(), repo.ID, r.URL.Query().Get("commit"))
	if errors.Is(err, store.ErrNotFound) {
		return errNotFound("no snapshots for this commit")
	} else if err != nil {
		return err
	}
	parts := make([]*graph.Graph, 0, len(snaps))
	for _, sn := range snaps {
		g, err := s.store.SnapshotGraph(r.Context(), sn.ID, nil)
		if err != nil {
			return err
		}
		parts = append(parts, g)
	}
	merged := graph.Filter(graph.Merge(parts...), r.URL.Query()["kind"])
	cfg, err := s.store.CommitConfig(r.Context(), repo.ID, snaps[0].Commit)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, repoGraphResponse{Commit: snaps[0].Commit, Snapshots: snaps, Config: cfg, Graph: merged})
	return nil
}

// ---- diagram grouping edits ----

func (s *Server) getGroups(w http.ResponseWriter, r *http.Request) error {
	repo, err := s.repoFromPath(r)
	if err != nil {
		return err
	}
	o, err := s.store.GroupOverrides(r.Context(), repo.ID)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, o)
	return nil
}

const maxGroupOverrides = 5000

// putGroups replaces a repo's grouping edits:
// {"rename": {groupId: label}, "assign": {nodeId: group}, "levels": {defaultLevelName: name}}.
// Entries with an empty value are dropped (that is how an edit is undone).
func (s *Server) putGroups(w http.ResponseWriter, r *http.Request) error {
	repo, err := s.repoFromPath(r)
	if err != nil {
		return err
	}
	var req store.GroupOverrides
	if err := readJSON(w, r, &req); err != nil {
		return err
	}
	clean := func(in map[string]string, what string) (map[string]string, error) {
		out := map[string]string{}
		for k, v := range in {
			k, v = strings.TrimSpace(k), strings.TrimSpace(v)
			if v == "" {
				continue
			}
			if k == "" || len(k) > 500 || len(v) > 200 {
				return nil, errBadRequest(what + ": keys must be 1-500 chars and names 1-200 chars")
			}
			out[k] = v
		}
		return out, nil
	}
	o := &store.GroupOverrides{}
	if o.Rename, err = clean(req.Rename, "rename"); err != nil {
		return err
	}
	if o.Assign, err = clean(req.Assign, "assign"); err != nil {
		return err
	}
	if o.Levels, err = clean(req.Levels, "levels"); err != nil {
		return err
	}
	if len(o.Rename)+len(o.Assign)+len(o.Levels) > maxGroupOverrides {
		return errBadRequest(fmt.Sprintf("at most %d grouping edits per repo", maxGroupOverrides))
	}
	if err := s.store.SetGroupOverrides(r.Context(), repo.ID, o); err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, o)
	return nil
}

// ---- auth ----

type loginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

type loginResponse struct {
	Token     string      `json:"token"`
	ExpiresAt time.Time   `json:"expiresAt"`
	User      *store.User `json:"user"`
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) error {
	var req loginRequest
	if err := readJSON(w, r, &req); err != nil {
		return err
	}
	user, err := s.store.UserByEmail(r.Context(), req.Email)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return err
	}
	hash := ""
	if user != nil {
		hash = user.PasswordHash
	}
	if !auth.CheckPassword(hash, req.Password) {
		return &apiError{Status: http.StatusUnauthorized, Code: "invalid_credentials", Message: "invalid email or password"}
	}

	token, tokenHash, err := auth.NewToken()
	if err != nil {
		return err
	}
	expires := time.Now().Add(s.cfg.SessionTTL)
	if err := s.store.CreateToken(r.Context(), tokenHash, user.ID, store.TokenSession, "", &expires); err != nil {
		return err
	}
	http.SetCookie(w, &http.Cookie{
		Name: sessionCookie, Value: token, Path: "/", Expires: expires,
		HttpOnly: true, Secure: s.cfg.CookieSecure, SameSite: http.SameSiteLaxMode,
	})
	writeJSON(w, http.StatusOK, loginResponse{Token: token, ExpiresAt: expires, User: user})
	return nil
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request) error {
	token := bearerToken(r)
	if token == "" {
		if c, err := r.Cookie(sessionCookie); err == nil {
			token = c.Value
		}
	}
	if err := s.store.DeleteToken(r.Context(), auth.HashToken(token)); err != nil {
		return err
	}
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: "", Path: "/", MaxAge: -1,
		HttpOnly: true, Secure: s.cfg.CookieSecure, SameSite: http.SameSiteLaxMode})
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (s *Server) me(w http.ResponseWriter, r *http.Request) error {
	writeJSON(w, http.StatusOK, userFrom(r.Context()))
	return nil
}

// ---- users & tokens ----

type createUserRequest struct {
	Email    string     `json:"email"`
	Password string     `json:"password"`
	Role     store.Role `json:"role"`
}

var emailRe = regexp.MustCompile(`^[^@\s]+@[^@\s]+$`)

func (s *Server) createUser(w http.ResponseWriter, r *http.Request) error {
	var req createUserRequest
	if err := readJSON(w, r, &req); err != nil {
		return err
	}
	if req.Role == "" {
		req.Role = store.RoleMember
	}
	if !req.Role.Valid() {
		return errBadRequest("role must be admin or member")
	}
	if !emailRe.MatchString(req.Email) {
		return errBadRequest("invalid email")
	}
	hash, err := auth.HashPassword(req.Password)
	if errors.Is(err, auth.ErrPasswordLength) {
		return errBadRequest(err.Error())
	} else if err != nil {
		return err
	}
	user, err := s.store.CreateUser(r.Context(), req.Email, hash, req.Role)
	if errors.Is(err, store.ErrConflict) {
		return errConflict("a user with this email already exists")
	} else if err != nil {
		return err
	}
	writeJSON(w, http.StatusCreated, user)
	return nil
}

func (s *Server) listUsers(w http.ResponseWriter, r *http.Request) error {
	users, err := s.store.ListUsers(r.Context())
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, users)
	return nil
}

type createTokenRequest struct {
	Name string `json:"name"`
}

// createAPIToken issues a non-expiring token for analyzers/CI. It is shown once.
func (s *Server) createAPIToken(w http.ResponseWriter, r *http.Request) error {
	var req createTokenRequest
	if err := readJSON(w, r, &req); err != nil {
		return err
	}
	if req.Name == "" {
		return errBadRequest("name is required")
	}
	token, hash, err := auth.NewToken()
	if err != nil {
		return err
	}
	if err := s.store.CreateToken(r.Context(), hash, userFrom(r.Context()).ID, store.TokenAPI, req.Name, nil); err != nil {
		return err
	}
	writeJSON(w, http.StatusCreated, map[string]string{"name": req.Name, "token": token})
	return nil
}

// ---- repos ----

var repoNameRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$`)

type createRepoRequest struct {
	Name          string `json:"name"`
	URL           string `json:"url"`
	DefaultBranch string `json:"defaultBranch"`
	GitProfile    string `json:"gitProfile"`
}

func (s *Server) createRepo(w http.ResponseWriter, r *http.Request) error {
	var req createRepoRequest
	if err := readJSON(w, r, &req); err != nil {
		return err
	}
	if !repoNameRe.MatchString(req.Name) {
		return errBadRequest("name must be 1-100 chars of letters, digits, '.', '_' or '-'")
	}
	if err := checkGitURL(req.URL); err != nil {
		return err
	}
	if err := s.checkGitProfile(req.GitProfile); err != nil {
		return err
	}
	repo, err := s.store.CreateRepo(r.Context(), req.Name, req.URL, req.DefaultBranch, req.GitProfile)
	if errors.Is(err, store.ErrConflict) {
		return errConflict("a repo with this name already exists")
	} else if err != nil {
		return err
	}
	writeJSON(w, http.StatusCreated, s.withAnalysis(*repo))
	return nil
}

type updateRepoRequest struct {
	URL           *string `json:"url"`
	DefaultBranch *string `json:"defaultBranch"`
	GitProfile    *string `json:"gitProfile"` // "" clears it
}

func (s *Server) updateRepo(w http.ResponseWriter, r *http.Request) error {
	repo, err := s.repoFromPath(r)
	if err != nil {
		return err
	}
	var req updateRepoRequest
	if err := readJSON(w, r, &req); err != nil {
		return err
	}
	url, branch, profile := repo.URL, repo.DefaultBranch, repo.GitProfile
	if req.GitProfile != nil {
		profile = strings.TrimSpace(*req.GitProfile)
		if err := s.checkGitProfile(profile); err != nil {
			return err
		}
	}
	if req.URL != nil {
		url = strings.TrimSpace(*req.URL)
		if err := checkGitURL(url); err != nil {
			return err
		}
	}
	if req.DefaultBranch != nil {
		branch = strings.TrimSpace(*req.DefaultBranch)
		if branch == "" || strings.ContainsAny(branch, " \t\r\n") || strings.HasPrefix(branch, "-") {
			return errBadRequest("invalid default branch")
		}
	}
	repo, err = s.store.UpdateRepo(r.Context(), repo.ID, url, branch, profile)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, s.withAnalysis(*repo))
	return nil
}

// checkGitProfile accepts "" (no profile) or the name of a profile on this server.
func (s *Server) checkGitProfile(name string) error {
	if name == "" {
		return nil
	}
	if _, err := s.profiles.Get(name); errors.Is(err, gitprofiles.ErrNotFound) {
		return errBadRequest(fmt.Sprintf("no git profile %q on this server", name))
	} else if err != nil {
		return err
	}
	return nil
}

// ---- git profiles ----

func (s *Server) listGitProfiles(w http.ResponseWriter, r *http.Request) error {
	ps, err := s.profiles.List()
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, ps)
	return nil
}

type createGitProfileRequest struct {
	Name     string `json:"name"`
	UserName string `json:"userName"`
	Email    string `json:"email"`
	// GenerateKey makes a new SSH key; otherwise KeyPath names an existing key in the SSH dir.
	GenerateKey bool   `json:"generateKey"`
	KeyPath     string `json:"keyPath"`
}

// createGitProfile adds a profile to the server's profiles file; the response carries the
// public key to register with the git host. Private keys are never returned.
func (s *Server) createGitProfile(w http.ResponseWriter, r *http.Request) error {
	var req createGitProfileRequest
	if err := readJSON(w, r, &req); err != nil {
		return err
	}
	p, err := s.profiles.Add(r.Context(), gitprofiles.Profile{
		Name: req.Name, UserName: req.UserName, Email: req.Email, KeyPath: req.KeyPath,
	}, req.GenerateKey)
	var inv *gitprofiles.Invalid
	switch {
	case errors.As(err, &inv):
		return errBadRequest(inv.Msg)
	case errors.Is(err, gitprofiles.ErrExists):
		return errConflict(err.Error())
	case err != nil:
		return err
	}
	s.log.Info("git profile added", "name", p.Name, "key", p.KeyPath, "generated", req.GenerateKey)
	writeJSON(w, http.StatusCreated, p)
	return nil
}

// testGitProfile logs in to GitHub (or ?host=) with the profile's key and reports the account.
func (s *Server) testGitProfile(w http.ResponseWriter, r *http.Request) error {
	host := r.URL.Query().Get("host")
	if host != "" && !regexp.MustCompile(`^[A-Za-z0-9.-]+$`).MatchString(host) {
		return errBadRequest("invalid host")
	}
	account, message, err := s.profiles.Test(r.Context(), r.PathValue("name"), host)
	if errors.Is(err, gitprofiles.ErrNotFound) {
		return errNotFound("no such git profile")
	} else if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": account != "", "account": account, "message": message})
	return nil
}

// checkGitURL rejects values git would read as an option or that span lines; anything
// else `git clone` accepts is allowed, including local paths on the server.
func checkGitURL(u string) error {
	if strings.HasPrefix(u, "-") || strings.ContainsAny(u, " \t\r\n") || len(u) > 2000 {
		return errBadRequest("invalid git URL")
	}
	return nil
}

// repoResponse is a repo plus its latest server-side analysis since the server started.
type repoResponse struct {
	store.Repo
	Analysis *analysis.Job `json:"analysis,omitempty"`
}

func (s *Server) withAnalysis(repo store.Repo) repoResponse {
	res := repoResponse{Repo: repo}
	if j, ok := s.analysis.Get(repo.ID, false); ok {
		res.Analysis = &j
	}
	return res
}

func (s *Server) listRepos(w http.ResponseWriter, r *http.Request) error {
	repos, err := s.store.ListRepos(r.Context())
	if err != nil {
		return err
	}
	jobs := s.analysis.Jobs()
	out := make([]repoResponse, len(repos))
	for i, repo := range repos {
		out[i] = repoResponse{Repo: repo}
		if j, ok := jobs[repo.ID]; ok {
			out[i].Analysis = &j
		}
	}
	writeJSON(w, http.StatusOK, out)
	return nil
}

func (s *Server) repoFromPath(r *http.Request) (*store.Repo, error) {
	repo, err := s.store.RepoByName(r.Context(), r.PathValue("repo"))
	if errors.Is(err, store.ErrNotFound) {
		return nil, errNotFound("repo not found")
	}
	return repo, err
}

func (s *Server) getRepo(w http.ResponseWriter, r *http.Request) error {
	repo, err := s.repoFromPath(r)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, s.withAnalysis(*repo))
	return nil
}

// ---- server-side analysis ----

// startAnalysis clones the repo's URL and runs the analyzers in the background.
// Poll GET .../analysis for progress.
func (s *Server) startAnalysis(w http.ResponseWriter, r *http.Request) error {
	repo, err := s.repoFromPath(r)
	if err != nil {
		return err
	}
	job, err := s.analysis.Start(*repo)
	switch {
	case errors.Is(err, analysis.ErrNoURL):
		return errBadRequest("this repo has no git URL; set one first")
	case errors.Is(err, analysis.ErrBusy):
		return errConflict(err.Error())
	case err != nil:
		return err
	}
	writeJSON(w, http.StatusAccepted, job)
	return nil
}

func (s *Server) getAnalysis(w http.ResponseWriter, r *http.Request) error {
	repo, err := s.repoFromPath(r)
	if err != nil {
		return err
	}
	job, ok := s.analysis.Get(repo.ID, true)
	if !ok {
		return errNotFound("no analysis has run for this repo since the server started")
	}
	writeJSON(w, http.StatusOK, job)
	return nil
}

func (s *Server) cancelAnalysis(w http.ResponseWriter, r *http.Request) error {
	repo, err := s.repoFromPath(r)
	if err != nil {
		return err
	}
	if !s.analysis.Cancel(repo.ID) {
		return errNotFound("no analysis is running for this repo")
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

// ---- snapshots ----

func (s *Server) uploadSnapshot(w http.ResponseWriter, r *http.Request) error {
	repo, err := s.repoFromPath(r)
	if err != nil {
		return err
	}
	doc, err := ir.Decode(http.MaxBytesReader(w, r.Body, s.cfg.MaxUploadBytes))
	if err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			return err
		}
		return errBadRequest(err.Error())
	}
	if err := doc.Validate(); err != nil {
		var ve *ir.ValidationError
		if errors.As(err, &ve) {
			return errUnprocessable(ve.Error(), ve)
		}
		return err
	}
	if doc.Source.Repo != repo.Name {
		return errUnprocessable(fmt.Sprintf("source.repo %q does not match repo %q", doc.Source.Repo, repo.Name), nil)
	}
	snap, err := s.store.SaveSnapshot(r.Context(), repo.ID, doc)
	if err != nil {
		return err
	}
	s.log.Info("snapshot stored", "repo", repo.Name, "commit", snap.Commit, "analyzer", snap.Analyzer,
		"nodes", snap.NodeCount, "edges", snap.EdgeCount)
	writeJSON(w, http.StatusCreated, snap)
	return nil
}

func (s *Server) listSnapshots(w http.ResponseWriter, r *http.Request) error {
	repo, err := s.repoFromPath(r)
	if err != nil {
		return err
	}
	snaps, err := s.store.ListSnapshots(r.Context(), repo.ID)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, snaps)
	return nil
}

var uuidRe = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

func (s *Server) snapshotFromPath(r *http.Request) (*store.Snapshot, error) {
	id := r.PathValue("id")
	if !uuidRe.MatchString(id) {
		return nil, errNotFound("snapshot not found")
	}
	snap, err := s.store.SnapshotByID(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		return nil, errNotFound("snapshot not found")
	}
	return snap, err
}

func (s *Server) getSnapshot(w http.ResponseWriter, r *http.Request) error {
	snap, err := s.snapshotFromPath(r)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, snap)
	return nil
}

// getSnapshotGraph returns nodes and edges; ?kind=class&kind=method filters node kinds.
func (s *Server) getSnapshotGraph(w http.ResponseWriter, r *http.Request) error {
	snap, err := s.snapshotFromPath(r)
	if err != nil {
		return err
	}
	g, err := s.store.SnapshotGraph(r.Context(), snap.ID, r.URL.Query()["kind"])
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, g)
	return nil
}
