CREATE TABLE users (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email         text NOT NULL UNIQUE,          -- stored lower-cased
    password_hash text NOT NULL,
    role          text NOT NULL CHECK (role IN ('admin', 'member')),
    created_at    timestamptz NOT NULL DEFAULT now()
);

-- Login sessions and long-lived API tokens (for analyzers / CI). Only the SHA-256 is stored.
CREATE TABLE tokens (
    token_hash   text PRIMARY KEY,
    user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    kind         text NOT NULL CHECK (kind IN ('session', 'api')),
    name         text,
    created_at   timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz,
    last_used_at timestamptz
);
CREATE INDEX tokens_user ON tokens (user_id);

CREATE TABLE repos (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name           text NOT NULL UNIQUE,
    url            text,
    default_branch text NOT NULL DEFAULT 'main',
    created_at     timestamptz NOT NULL DEFAULT now()
);

-- One analyzer run over one repo at one commit. Re-uploading the same
-- (repo, commit, analyzer) replaces the previous snapshot.
CREATE TABLE snapshots (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    repo_id          uuid NOT NULL REFERENCES repos (id) ON DELETE CASCADE,
    commit_sha       text NOT NULL,
    branch           text,
    analyzer         text NOT NULL,
    analyzer_version text NOT NULL,
    ir_version       text NOT NULL,
    generated_at     timestamptz,
    created_at       timestamptz NOT NULL DEFAULT now(),
    node_count       integer NOT NULL,
    edge_count       integer NOT NULL,
    UNIQUE (repo_id, commit_sha, analyzer)
);
CREATE INDEX snapshots_repo_created ON snapshots (repo_id, created_at DESC);

CREATE TABLE nodes (
    snapshot_id    uuid NOT NULL REFERENCES snapshots (id) ON DELETE CASCADE,
    id             text NOT NULL,
    kind           text NOT NULL,
    name           text NOT NULL,
    qualified_name text,
    parent_id      text,
    language       text,
    file           text,
    start_line     integer,
    end_line       integer,
    otel           jsonb,
    attrs          jsonb,
    PRIMARY KEY (snapshot_id, id)
);
CREATE INDEX nodes_kind ON nodes (snapshot_id, kind);
CREATE INDEX nodes_parent ON nodes (snapshot_id, parent_id);
-- Span -> node correlation (P3) looks nodes up by their OTel attributes.
CREATE INDEX nodes_otel ON nodes USING gin (otel jsonb_path_ops);

CREATE TABLE edges (
    snapshot_id uuid NOT NULL REFERENCES snapshots (id) ON DELETE CASCADE,
    seq         integer NOT NULL,                -- position in the uploaded document
    source      text NOT NULL,
    target      text NOT NULL,
    kind        text NOT NULL,
    locations   jsonb,
    attrs       jsonb,
    PRIMARY KEY (snapshot_id, seq)
);
CREATE INDEX edges_source ON edges (snapshot_id, source);
CREATE INDEX edges_target ON edges (snapshot_id, target);
