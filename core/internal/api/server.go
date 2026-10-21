// Package api is the CodeAtlas HTTP API.
package api

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"codeatlas/core/internal/analysis"
	"codeatlas/core/internal/auth"
	"codeatlas/core/internal/config"
	"codeatlas/core/internal/gitprofiles"
	"codeatlas/core/internal/store"
)

const sessionCookie = "codeatlas_session"

// Pinger is satisfied by the ClickHouse client; nil disables the readiness check.
type Pinger interface {
	Ping(ctx context.Context) error
}

type Server struct {
	cfg        config.Config
	store      *store.Store
	clickhouse Pinger
	log        *slog.Logger
	analysis   *analysis.Runner
	profiles   *gitprofiles.Store
}

func New(cfg config.Config, st *store.Store, ch Pinger, log *slog.Logger) *Server {
	profiles := gitprofiles.New(cfg.Analysis.GitProfiles, cfg.Analysis.SSHDir)
	return &Server{cfg: cfg, store: st, clickhouse: ch, log: log, profiles: profiles,
		analysis: analysis.NewRunner(cfg.Analysis, st, profiles, log)}
}

// Close cancels running analyses and waits for them to stop.
func (s *Server) Close() { s.analysis.Close() }

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	handle := func(pattern string, h handlerFunc, mw ...func(handlerFunc) handlerFunc) {
		for i := len(mw) - 1; i >= 0; i-- {
			h = mw[i](h)
		}
		mux.Handle(pattern, s.wrap(h))
	}
	authed, admin := s.requireUser, s.requireAdmin

	handle("GET /healthz", s.healthz)
	handle("GET /readyz", s.readyz)

	handle("POST /api/v1/auth/login", s.login)
	handle("POST /api/v1/auth/logout", s.logout, authed)
	handle("GET /api/v1/me", s.me, authed)

	handle("GET /api/v1/users", s.listUsers, authed, admin)
	handle("POST /api/v1/users", s.createUser, authed, admin)
	handle("POST /api/v1/tokens", s.createAPIToken, authed)

	handle("GET /api/v1/git-profiles", s.listGitProfiles, authed, admin)
	handle("POST /api/v1/git-profiles", s.createGitProfile, authed, admin)
	handle("POST /api/v1/git-profiles/{name}/test", s.testGitProfile, authed, admin)

	handle("GET /api/v1/repos", s.listRepos, authed)
	handle("POST /api/v1/repos", s.createRepo, authed, admin)
	handle("GET /api/v1/repos/{repo}", s.getRepo, authed)
	handle("PATCH /api/v1/repos/{repo}", s.updateRepo, authed, admin)
	handle("GET /api/v1/repos/{repo}/analysis", s.getAnalysis, authed)
	handle("POST /api/v1/repos/{repo}/analysis", s.startAnalysis, authed, admin)
	handle("DELETE /api/v1/repos/{repo}/analysis", s.cancelAnalysis, authed, admin)
	handle("GET /api/v1/repos/{repo}/snapshots", s.listSnapshots, authed)
	handle("POST /api/v1/repos/{repo}/snapshots", s.uploadSnapshot, authed)
	handle("GET /api/v1/repos/{repo}/commits", s.listCommits, authed)
	handle("GET /api/v1/repos/{repo}/graph", s.getRepoGraph, authed)
	handle("GET /api/v1/repos/{repo}/groups", s.getGroups, authed)
	handle("PUT /api/v1/repos/{repo}/groups", s.putGroups, authed, admin)
	handle("GET /api/v1/snapshots/{id}", s.getSnapshot, authed)
	handle("GET /api/v1/snapshots/{id}/graph", s.getSnapshotGraph, authed)

	mux.Handle("/api/", s.wrap(func(w http.ResponseWriter, r *http.Request) error {
		return errNotFound("no such endpoint")
	}))
	if s.cfg.WebDir != "" {
		mux.Handle("/", spaHandler(s.cfg.WebDir))
	}
	return s.logRequests(mux)
}

// ---- handler plumbing ----

type handlerFunc func(w http.ResponseWriter, r *http.Request) error

type apiError struct {
	Status  int    `json:"-"`
	Code    string `json:"code"`
	Message string `json:"message"`
	Details any    `json:"details,omitempty"`
}

func (e *apiError) Error() string { return e.Message }

func errBadRequest(msg string) *apiError {
	return &apiError{http.StatusBadRequest, "bad_request", msg, nil}
}
func errNotFound(msg string) *apiError { return &apiError{http.StatusNotFound, "not_found", msg, nil} }
func errConflict(msg string) *apiError { return &apiError{http.StatusConflict, "conflict", msg, nil} }
func errUnauthorized() *apiError {
	return &apiError{http.StatusUnauthorized, "unauthorized", "authentication required", nil}
}
func errForbidden() *apiError {
	return &apiError{http.StatusForbidden, "forbidden", "admin role required", nil}
}
func errUnprocessable(msg string, details any) *apiError {
	return &apiError{http.StatusUnprocessableEntity, "invalid", msg, details}
}

func (s *Server) wrap(h handlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if p := recover(); p != nil {
				s.log.Error("panic", "path", r.URL.Path, "panic", p)
				writeJSON(w, http.StatusInternalServerError, &apiError{Code: "internal", Message: "internal error"})
			}
		}()
		err := h(w, r)
		if err == nil {
			return
		}
		var ae *apiError
		switch {
		case errors.As(err, &ae):
		case errors.Is(err, store.ErrNotFound):
			ae = errNotFound("not found")
		case errors.Is(err, store.ErrConflict):
			ae = errConflict("already exists")
		default:
			var mbe *http.MaxBytesError
			if errors.As(err, &mbe) {
				ae = &apiError{Status: http.StatusRequestEntityTooLarge, Code: "too_large", Message: "request body too large"}
			} else {
				s.log.Error("request failed", "method", r.Method, "path", r.URL.Path, "err", err)
				ae = &apiError{Status: http.StatusInternalServerError, Code: "internal", Message: "internal error"}
			}
		}
		writeJSON(w, ae.Status, ae)
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

// readJSON decodes a small JSON request body strictly.
func readJSON(w http.ResponseWriter, r *http.Request, v any) error {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return errBadRequest("invalid JSON body: " + err.Error())
	}
	return nil
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

func (s *Server) logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		if r.URL.Path == "/healthz" || r.URL.Path == "/readyz" {
			return
		}
		s.log.Info("http", "method", r.Method, "path", r.URL.Path, "status", rec.status,
			"duration_ms", time.Since(start).Milliseconds())
	})
}

// ---- authentication ----

type ctxKey struct{}

func userFrom(ctx context.Context) *store.User {
	u, _ := ctx.Value(ctxKey{}).(*store.User)
	return u
}

// requireUser accepts "Authorization: Bearer <token>" (API clients) or the session
// cookie (web UI). Cookie-authenticated writes must be JSON, which browsers can't
// send cross-site without a CORS preflight; that is our CSRF protection.
func (s *Server) requireUser(next handlerFunc) handlerFunc {
	return func(w http.ResponseWriter, r *http.Request) error {
		token, fromCookie := bearerToken(r), false
		if token == "" {
			if c, err := r.Cookie(sessionCookie); err == nil {
				token, fromCookie = c.Value, true
			}
		}
		if token == "" {
			return errUnauthorized()
		}
		user, _, err := s.store.UserByToken(r.Context(), auth.HashToken(token))
		if errors.Is(err, store.ErrNotFound) {
			return errUnauthorized()
		} else if err != nil {
			return err
		}
		if fromCookie && !isSafeMethod(r.Method) && !isJSON(r) {
			return &apiError{Status: http.StatusUnsupportedMediaType, Code: "unsupported_media_type",
				Message: "Content-Type must be application/json"}
		}
		return next(w, r.WithContext(context.WithValue(r.Context(), ctxKey{}, user)))
	}
}

func (s *Server) requireAdmin(next handlerFunc) handlerFunc {
	return func(w http.ResponseWriter, r *http.Request) error {
		if u := userFrom(r.Context()); u == nil || u.Role != store.RoleAdmin {
			return errForbidden()
		}
		return next(w, r)
	}
}

func bearerToken(r *http.Request) string {
	h := r.Header.Get("Authorization")
	if len(h) > 7 && strings.EqualFold(h[:7], "bearer ") {
		return strings.TrimSpace(h[7:])
	}
	return ""
}

func isSafeMethod(m string) bool {
	return m == http.MethodGet || m == http.MethodHead || m == http.MethodOptions
}

func isJSON(r *http.Request) bool {
	mt, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	return err == nil && mt == "application/json"
}

// ---- health ----

func (s *Server) healthz(w http.ResponseWriter, r *http.Request) error {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	return nil
}

func (s *Server) readyz(w http.ResponseWriter, r *http.Request) error {
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	checks := map[string]string{"postgres": "ok"}
	ok := true
	if err := s.store.Ping(ctx); err != nil {
		checks["postgres"], ok = err.Error(), false
	}
	if s.clickhouse != nil {
		checks["clickhouse"] = "ok"
		if err := s.clickhouse.Ping(ctx); err != nil {
			checks["clickhouse"], ok = err.Error(), false
		}
	}
	status := http.StatusOK
	if !ok {
		status = http.StatusServiceUnavailable
	}
	writeJSON(w, status, map[string]any{"ready": ok, "checks": checks})
	return nil
}

// ---- static web UI ----

// spaHandler serves files from dir and falls back to index.html for client-side routes.
func spaHandler(dir string) http.Handler {
	fileServer := http.FileServer(http.Dir(dir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := filepath.Join(dir, filepath.Clean("/"+r.URL.Path))
		if st, err := os.Stat(p); err != nil || st.IsDir() {
			http.ServeFile(w, r, filepath.Join(dir, "index.html"))
			return
		}
		fileServer.ServeHTTP(w, r)
	})
}
