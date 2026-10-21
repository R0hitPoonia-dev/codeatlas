// Package config loads server configuration from CODEATLAS_* environment variables.
package config

import (
	"fmt"
	"os"
	"strconv"
	"time"
)

type Config struct {
	HTTPAddr       string
	DatabaseURL    string
	WebDir         string // optional: serve the built web UI from here
	SessionTTL     time.Duration
	CookieSecure   bool
	MaxUploadBytes int64

	// Bootstrap admin, created only when the users table is empty.
	AdminEmail    string
	AdminPassword string

	ClickHouse ClickHouse
	Analysis   Analysis
}

// Analysis configures server-side analysis (clone + analyzers) started from the UI.
type Analysis struct {
	Timeout time.Duration // per repo: clone and every analyzer
	// GitToken authenticates HTTPS clones of private repos on GitHost (e.g. a GitHub
	// token). When set, git's own credential helpers are bypassed. Without it, git uses
	// whatever credentials the server's user has.
	GitToken string
	GitHost  string
	// Git profiles the UI can pick per repo (same file as the terminal helper) and the
	// directory their SSH keys live in. Defaults: ~/.git-profiles and ~/.ssh.
	GitProfiles string
	SSHDir      string
}

type ClickHouse struct {
	URL      string // HTTP interface, e.g. http://localhost:8123
	User     string
	Password string
	Database string
}

func Load() (Config, error) {
	c := Config{
		HTTPAddr:      env("CODEATLAS_HTTP_ADDR", ":8080"),
		DatabaseURL:   os.Getenv("CODEATLAS_DATABASE_URL"),
		WebDir:        os.Getenv("CODEATLAS_WEB_DIR"),
		AdminEmail:    os.Getenv("CODEATLAS_ADMIN_EMAIL"),
		AdminPassword: os.Getenv("CODEATLAS_ADMIN_PASSWORD"),
		ClickHouse: ClickHouse{
			URL:      env("CODEATLAS_CLICKHOUSE_URL", "http://localhost:8123"),
			User:     env("CODEATLAS_CLICKHOUSE_USER", "default"),
			Password: os.Getenv("CODEATLAS_CLICKHOUSE_PASSWORD"),
			Database: env("CODEATLAS_CLICKHOUSE_DATABASE", "codeatlas"),
		},
		Analysis: Analysis{
			GitToken:    os.Getenv("CODEATLAS_GIT_TOKEN"),
			GitHost:     env("CODEATLAS_GIT_TOKEN_HOST", "github.com"),
			GitProfiles: os.Getenv("CODEATLAS_GIT_PROFILES"),
			SSHDir:      os.Getenv("CODEATLAS_SSH_DIR"),
		},
	}
	if c.DatabaseURL == "" {
		return c, fmt.Errorf("CODEATLAS_DATABASE_URL is required")
	}

	var err error
	if c.SessionTTL, err = time.ParseDuration(env("CODEATLAS_SESSION_TTL", "24h")); err != nil {
		return c, fmt.Errorf("CODEATLAS_SESSION_TTL: %w", err)
	}
	if c.CookieSecure, err = strconv.ParseBool(env("CODEATLAS_COOKIE_SECURE", "false")); err != nil {
		return c, fmt.Errorf("CODEATLAS_COOKIE_SECURE: %w", err)
	}
	if c.MaxUploadBytes, err = strconv.ParseInt(env("CODEATLAS_MAX_UPLOAD_BYTES", strconv.Itoa(512<<20)), 10, 64); err != nil {
		return c, fmt.Errorf("CODEATLAS_MAX_UPLOAD_BYTES: %w", err)
	}
	if c.Analysis.Timeout, err = time.ParseDuration(env("CODEATLAS_ANALYSIS_TIMEOUT", "30m")); err != nil {
		return c, fmt.Errorf("CODEATLAS_ANALYSIS_TIMEOUT: %w", err)
	}
	if (c.AdminEmail == "") != (c.AdminPassword == "") {
		return c, fmt.Errorf("set both CODEATLAS_ADMIN_EMAIL and CODEATLAS_ADMIN_PASSWORD, or neither")
	}
	return c, nil
}

func env(key, def string) string {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		return v
	}
	return def
}
