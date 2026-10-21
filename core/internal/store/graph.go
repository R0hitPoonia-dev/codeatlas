package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"codeatlas/core/internal/graph"
	"codeatlas/core/ir"
)

type Repo struct {
	ID            string    `json:"id"`
	Name          string    `json:"name"`
	URL           string    `json:"url,omitempty"`
	DefaultBranch string    `json:"defaultBranch"`
	CreatedAt     time.Time `json:"createdAt"`
	// Latest uploaded snapshot, if any.
	LastCommit string     `json:"lastCommit,omitempty"`
	AnalyzedAt *time.Time `json:"analyzedAt,omitempty"`
	// GitProfile names the git profile whose SSH key clones the repo ("" = server default).
	GitProfile string `json:"gitProfile,omitempty"`
}

const repoSelect = `SELECT r.id, r.name, coalesce(r.url, ''), r.default_branch, r.created_at,
	coalesce(s.commit_sha, ''), s.created_at, coalesce(r.git_profile, '')
	FROM repos r LEFT JOIN LATERAL (
		SELECT commit_sha, created_at FROM snapshots WHERE repo_id = r.id ORDER BY created_at DESC LIMIT 1
	) s ON true`

// repoReturning matches repoSelect's columns for INSERT/UPDATE ... RETURNING.
const repoReturning = `id, name, coalesce(url, ''), default_branch, created_at,
	coalesce((SELECT commit_sha FROM snapshots WHERE repo_id = repos.id ORDER BY created_at DESC LIMIT 1), ''),
	(SELECT max(created_at) FROM snapshots WHERE repo_id = repos.id), coalesce(git_profile, '')`

func scanRepo(row interface{ Scan(...any) error }) (*Repo, error) {
	var r Repo
	if err := row.Scan(&r.ID, &r.Name, &r.URL, &r.DefaultBranch, &r.CreatedAt, &r.LastCommit, &r.AnalyzedAt, &r.GitProfile); err != nil {
		return nil, notFound(err)
	}
	return &r, nil
}

func (s *Store) CreateRepo(ctx context.Context, name, url, defaultBranch, gitProfile string) (*Repo, error) {
	if defaultBranch == "" {
		defaultBranch = "main"
	}
	r, err := scanRepo(s.pool.QueryRow(ctx,
		"INSERT INTO repos (name, url, default_branch, git_profile) VALUES ($1, NULLIF($2, ''), $3, NULLIF($4, '')) RETURNING "+repoReturning,
		name, url, defaultBranch, gitProfile))
	if isUniqueViolation(err) {
		return nil, ErrConflict
	}
	return r, err
}

// UpdateRepo sets the repo's git URL and git profile (empty clears them) and default branch.
func (s *Store) UpdateRepo(ctx context.Context, id, url, defaultBranch, gitProfile string) (*Repo, error) {
	return scanRepo(s.pool.QueryRow(ctx,
		"UPDATE repos SET url = NULLIF($2, ''), default_branch = $3, git_profile = NULLIF($4, '') WHERE id = $1 RETURNING "+repoReturning,
		id, url, defaultBranch, gitProfile))
}

func (s *Store) RepoByName(ctx context.Context, name string) (*Repo, error) {
	return scanRepo(s.pool.QueryRow(ctx, repoSelect+" WHERE r.name = $1", name))
}

func (s *Store) ListRepos(ctx context.Context) ([]Repo, error) {
	rows, err := s.pool.Query(ctx, repoSelect+" ORDER BY r.name")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	repos := []Repo{}
	for rows.Next() {
		r, err := scanRepo(rows)
		if err != nil {
			return nil, err
		}
		repos = append(repos, *r)
	}
	return repos, rows.Err()
}

type Snapshot struct {
	ID              string     `json:"id"`
	RepoID          string     `json:"repoId"`
	Commit          string     `json:"commit"`
	Branch          string     `json:"branch,omitempty"`
	Analyzer        string     `json:"analyzer"`
	AnalyzerVersion string     `json:"analyzerVersion"`
	IRVersion       string     `json:"irVersion"`
	GeneratedAt     *time.Time `json:"generatedAt,omitempty"`
	CreatedAt       time.Time  `json:"createdAt"`
	NodeCount       int        `json:"nodeCount"`
	EdgeCount       int        `json:"edgeCount"`
}

const snapshotCols = `id, repo_id, commit_sha, coalesce(branch, ''), analyzer, analyzer_version,
	ir_version, generated_at, created_at, node_count, edge_count`

func scanSnapshot(row interface{ Scan(...any) error }) (*Snapshot, error) {
	var s Snapshot
	err := row.Scan(&s.ID, &s.RepoID, &s.Commit, &s.Branch, &s.Analyzer, &s.AnalyzerVersion,
		&s.IRVersion, &s.GeneratedAt, &s.CreatedAt, &s.NodeCount, &s.EdgeCount)
	if err != nil {
		return nil, notFound(err)
	}
	return &s, nil
}

// SaveSnapshot stores a validated IR document for repoID, replacing any earlier
// snapshot of the same commit from the same analyzer. Nodes and edges are bulk-copied.
func (s *Store) SaveSnapshot(ctx context.Context, repoID string, doc *ir.Document) (*Snapshot, error) {
	var snap *Snapshot
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		src := doc.Source
		if _, err := tx.Exec(ctx,
			"DELETE FROM snapshots WHERE repo_id = $1 AND commit_sha = $2 AND analyzer = $3",
			repoID, src.Commit, src.Analyzer.Name); err != nil {
			return err
		}
		config, err := jsonOrNil(doc.Config, len(doc.Config))
		if err != nil {
			return err
		}
		snap, err = scanSnapshot(tx.QueryRow(ctx, `
			INSERT INTO snapshots (repo_id, commit_sha, branch, analyzer, analyzer_version, ir_version,
				generated_at, node_count, edge_count, config)
			VALUES ($1, $2, NULLIF($3, ''), $4, $5, $6, $7, $8, $9, $10)
			RETURNING `+snapshotCols,
			repoID, src.Commit, src.Branch, src.Analyzer.Name, src.Analyzer.Version, doc.IRVersion,
			src.GeneratedAt, len(doc.Nodes), len(doc.Edges), config))
		if err != nil {
			return err
		}

		_, err = tx.CopyFrom(ctx, pgx.Identifier{"nodes"},
			[]string{"snapshot_id", "id", "kind", "name", "qualified_name", "parent_id", "language",
				"file", "start_line", "end_line", "otel", "attrs"},
			pgx.CopyFromSlice(len(doc.Nodes), func(i int) ([]any, error) {
				n := doc.Nodes[i]
				var file *string
				var start, end *int
				if n.Location != nil {
					file, start, end = &n.Location.File, n.Location.StartLine, n.Location.EndLine
				}
				otel, err := jsonOrNil(n.OTel, len(n.OTel))
				if err != nil {
					return nil, err
				}
				attrs, err := jsonOrNil(n.Attrs, len(n.Attrs))
				if err != nil {
					return nil, err
				}
				return []any{snap.ID, n.ID, string(n.Kind), n.Name, nullStr(n.QualifiedName),
					nullStr(n.Parent), nullStr(n.Language), file, start, end, otel, attrs}, nil
			}))
		if err != nil {
			return fmt.Errorf("copy nodes: %w", err)
		}

		_, err = tx.CopyFrom(ctx, pgx.Identifier{"edges"},
			[]string{"snapshot_id", "seq", "source", "target", "kind", "locations", "attrs"},
			pgx.CopyFromSlice(len(doc.Edges), func(i int) ([]any, error) {
				e := doc.Edges[i]
				locs, err := jsonOrNil(e.Locations, len(e.Locations))
				if err != nil {
					return nil, err
				}
				attrs, err := jsonOrNil(e.Attrs, len(e.Attrs))
				if err != nil {
					return nil, err
				}
				return []any{snap.ID, i, e.Source, e.Target, string(e.Kind), locs, attrs}, nil
			}))
		if err != nil {
			return fmt.Errorf("copy edges: %w", err)
		}
		return nil
	})
	return snap, err
}

func (s *Store) ListSnapshots(ctx context.Context, repoID string) ([]Snapshot, error) {
	rows, err := s.pool.Query(ctx,
		"SELECT "+snapshotCols+" FROM snapshots WHERE repo_id = $1 ORDER BY created_at DESC", repoID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	snaps := []Snapshot{}
	for rows.Next() {
		sn, err := scanSnapshot(rows)
		if err != nil {
			return nil, err
		}
		snaps = append(snaps, *sn)
	}
	return snaps, rows.Err()
}

func (s *Store) SnapshotByID(ctx context.Context, id string) (*Snapshot, error) {
	return scanSnapshot(s.pool.QueryRow(ctx, "SELECT "+snapshotCols+" FROM snapshots WHERE id = $1::uuid", id))
}

// Graph is the stored nodes and edges of one snapshot, in IR shape.
type Graph = graph.Graph

// Commit summarises the snapshots uploaded for one commit of a repo.
type Commit struct {
	Commit     string    `json:"commit"`
	Branch     string    `json:"branch,omitempty"`
	Analyzers  []string  `json:"analyzers"`
	UploadedAt time.Time `json:"uploadedAt"`
}

// ListCommits returns the repo's analysed commits, most recent upload first.
func (s *Store) ListCommits(ctx context.Context, repoID string) ([]Commit, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT commit_sha, coalesce(max(branch), ''), array_agg(analyzer ORDER BY analyzer), max(created_at)
		FROM snapshots WHERE repo_id = $1
		GROUP BY commit_sha ORDER BY max(created_at) DESC`, repoID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	commits := []Commit{}
	for rows.Next() {
		var c Commit
		if err := rows.Scan(&c.Commit, &c.Branch, &c.Analyzers, &c.UploadedAt); err != nil {
			return nil, err
		}
		commits = append(commits, c)
	}
	return commits, rows.Err()
}

// CommitSnapshots returns every analyzer's snapshot for commit: code analyzers first
// (alphabetically), infra last, so that when nodes merge, locations in source code win
// over those in specs/manifests. An empty commit means the most recently uploaded one.
// ErrNotFound if none.
func (s *Store) CommitSnapshots(ctx context.Context, repoID, commit string) ([]Snapshot, error) {
	if commit == "" {
		err := s.pool.QueryRow(ctx,
			"SELECT commit_sha FROM snapshots WHERE repo_id = $1 ORDER BY created_at DESC LIMIT 1", repoID).Scan(&commit)
		if err != nil {
			return nil, notFound(err)
		}
	}
	rows, err := s.pool.Query(ctx,
		"SELECT "+snapshotCols+" FROM snapshots WHERE repo_id = $1 AND commit_sha = $2 ORDER BY analyzer = 'infra', analyzer", repoID, commit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var snaps []Snapshot
	for rows.Next() {
		sn, err := scanSnapshot(rows)
		if err != nil {
			return nil, err
		}
		snaps = append(snaps, *sn)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(snaps) == 0 {
		return nil, ErrNotFound
	}
	return snaps, nil
}

// CommitConfig returns the repo settings (.codeatlas.yml) uploaded with commit, or nil.
func (s *Store) CommitConfig(ctx context.Context, repoID, commit string) (map[string]any, error) {
	var raw []byte
	err := s.pool.QueryRow(ctx, `SELECT config FROM snapshots
		WHERE repo_id = $1 AND commit_sha = $2 AND config IS NOT NULL LIMIT 1`, repoID, commit).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	} else if err != nil {
		return nil, err
	}
	var cfg map[string]any
	return cfg, unmarshalIfSet(raw, &cfg)
}

// GroupOverrides are a repo's diagram grouping edits: group id -> new label (groups given
// the same label merge), graph node id -> the group it was moved to, and the names given to
// the detail levels of the all-layers view (default level name -> name).
type GroupOverrides struct {
	Rename map[string]string `json:"rename"`
	Assign map[string]string `json:"assign"`
	Levels map[string]string `json:"levels"`
}

func (s *Store) GroupOverrides(ctx context.Context, repoID string) (*GroupOverrides, error) {
	var raw []byte
	if err := s.pool.QueryRow(ctx, "SELECT group_overrides FROM repos WHERE id = $1", repoID).Scan(&raw); err != nil {
		return nil, notFound(err)
	}
	o := &GroupOverrides{}
	if err := unmarshalIfSet(raw, o); err != nil {
		return nil, err
	}
	if o.Rename == nil {
		o.Rename = map[string]string{}
	}
	if o.Assign == nil {
		o.Assign = map[string]string{}
	}
	if o.Levels == nil {
		o.Levels = map[string]string{}
	}
	return o, nil
}

func (s *Store) SetGroupOverrides(ctx context.Context, repoID string, o *GroupOverrides) error {
	b, err := json.Marshal(o)
	if err != nil {
		return err
	}
	tag, err := s.pool.Exec(ctx, "UPDATE repos SET group_overrides = $2 WHERE id = $1", repoID, b)
	if err == nil && tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return err
}

// SnapshotGraph returns a snapshot's graph. If kinds is non-empty, only nodes of those
// kinds are returned, along with the edges between them.
func (s *Store) SnapshotGraph(ctx context.Context, snapshotID string, kinds []string) (*Graph, error) {
	filter := len(kinds) > 0
	rows, err := s.pool.Query(ctx, `
		SELECT id, kind, name, coalesce(qualified_name, ''), coalesce(parent_id, ''), coalesce(language, ''),
			file, start_line, end_line, otel, attrs
		FROM nodes WHERE snapshot_id = $1::uuid AND (NOT $2 OR kind = ANY($3))
		ORDER BY id`, snapshotID, filter, kinds)
	if err != nil {
		return nil, err
	}
	g := &Graph{Nodes: []ir.Node{}, Edges: []ir.Edge{}}
	ids := map[string]bool{}
	for rows.Next() {
		var n ir.Node
		var file *string
		var start, end *int
		var otel, attrs []byte
		if err := rows.Scan(&n.ID, &n.Kind, &n.Name, &n.QualifiedName, &n.Parent, &n.Language,
			&file, &start, &end, &otel, &attrs); err != nil {
			rows.Close()
			return nil, err
		}
		if file != nil {
			n.Location = &ir.Location{File: *file, StartLine: start, EndLine: end}
		}
		if err := unmarshalIfSet(otel, &n.OTel); err != nil {
			rows.Close()
			return nil, err
		}
		if err := unmarshalIfSet(attrs, &n.Attrs); err != nil {
			rows.Close()
			return nil, err
		}
		ids[n.ID] = true
		g.Nodes = append(g.Nodes, n)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	rows, err = s.pool.Query(ctx, `
		SELECT source, target, kind, locations, attrs
		FROM edges WHERE snapshot_id = $1::uuid ORDER BY seq`, snapshotID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var e ir.Edge
		var locs, attrs []byte
		if err := rows.Scan(&e.Source, &e.Target, &e.Kind, &locs, &attrs); err != nil {
			return nil, err
		}
		if filter && !(ids[e.Source] && ids[e.Target]) {
			continue
		}
		if err := unmarshalIfSet(locs, &e.Locations); err != nil {
			return nil, err
		}
		if err := unmarshalIfSet(attrs, &e.Attrs); err != nil {
			return nil, err
		}
		g.Edges = append(g.Edges, e)
	}
	return g, rows.Err()
}

func unmarshalIfSet(b []byte, v any) error {
	if len(b) == 0 {
		return nil
	}
	if err := json.Unmarshal(b, v); err != nil {
		return fmt.Errorf("decode stored json: %w", err)
	}
	return nil
}

func nullStr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// jsonOrNil marshals v, or returns SQL NULL when it is empty.
func jsonOrNil(v any, n int) (any, error) {
	if n == 0 {
		return nil, nil
	}
	b, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	return json.RawMessage(b), nil
}
