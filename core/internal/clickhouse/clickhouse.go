// Package clickhouse is a minimal client for ClickHouse's HTTP interface.
// P0 only needs readiness checks and database creation; telemetry tables arrive in P2.
package clickhouse

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"codeatlas/core/internal/config"
)

type Client struct {
	cfg  config.ClickHouse
	http *http.Client
}

func New(cfg config.ClickHouse) *Client {
	return &Client{cfg: cfg, http: &http.Client{Timeout: 10 * time.Second}}
}

func (c *Client) Ping(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(c.cfg.URL, "/")+"/ping", nil)
	if err != nil {
		return err
	}
	return c.do(req)
}

var identRe = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// EnsureDatabase creates the configured database if it doesn't exist.
func (c *Client) EnsureDatabase(ctx context.Context) error {
	if !identRe.MatchString(c.cfg.Database) {
		return fmt.Errorf("clickhouse: invalid database name %q", c.cfg.Database)
	}
	return c.exec(ctx, "CREATE DATABASE IF NOT EXISTS "+c.cfg.Database)
}

func (c *Client) exec(ctx context.Context, query string) error {
	u := strings.TrimRight(c.cfg.URL, "/") + "/?" + url.Values{"query": {query}}.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u, nil)
	if err != nil {
		return err
	}
	return c.do(req)
}

func (c *Client) do(req *http.Request) error {
	req.Header.Set("X-ClickHouse-User", c.cfg.User)
	if c.cfg.Password != "" {
		req.Header.Set("X-ClickHouse-Key", c.cfg.Password)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("clickhouse: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("clickhouse: %s: %s", resp.Status, strings.TrimSpace(string(body)))
	}
	io.Copy(io.Discard, resp.Body)
	return nil
}
