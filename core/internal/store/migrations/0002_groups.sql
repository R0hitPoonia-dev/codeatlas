-- Diagram grouping: the repo's own settings travel with each analysis (.codeatlas.yml, set by
-- the infra analyzer), and users' renames / moves are kept per repo across analyses.
ALTER TABLE snapshots ADD COLUMN config jsonb;
ALTER TABLE repos ADD COLUMN group_overrides jsonb NOT NULL DEFAULT '{}'::jsonb;
