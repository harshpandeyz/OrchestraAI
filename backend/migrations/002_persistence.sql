-- 002_persistence.sql — OrchestraAI production relational schema, part 2.
--
-- Run with: psql "$DATABASE_URL" -f backend/migrations/002_persistence.sql
-- (or let the container entrypoint apply backend/migrations/*.sql in order).
-- Migrations are additive and idempotent (IF NOT EXISTS). Encryption at rest
-- for provider credentials is handled by CredentialStore (ciphertext only);
-- this schema never stores plaintext secrets.
--
-- Covers the production-critical persistence paths beyond run summaries,
-- events, snapshots and idempotency (001_init.sql):
--   organizations, evaluations, intelligence docs, billing lines, audit log.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Organizations/workspaces: tenant root for users/projects/runs.
CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Stored run-outcome evaluations (EvaluationStore dump entries).
CREATE TABLE IF NOT EXISTS evaluations (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  evaluation_key TEXT,
  run_id TEXT,
  evidence JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Existing installations may have created evaluations before keyed appends
-- were introduced. Backfill a stable key, then make future appends atomic.
ALTER TABLE evaluations ADD COLUMN IF NOT EXISTS evaluation_key TEXT;
UPDATE evaluations
SET evaluation_key = COALESCE(evaluation_key, 'id:' || (evidence->>'id'), 'hash:' || md5(evidence::text))
WHERE evaluation_key IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_evaluations_key ON evaluations (evaluation_key);
CREATE INDEX IF NOT EXISTS idx_evaluations_run ON evaluations (run_id);
CREATE INDEX IF NOT EXISTS idx_evaluations_created ON evaluations (created_at);

-- Intelligence documents (learning store dumps), keyed by scope.
-- The 'global' row mirrors intelligence.json from the file adapter.
CREATE TABLE IF NOT EXISTS intelligence_docs (
  key TEXT PRIMARY KEY,
  doc JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Canonical per-run billing lines (platform-fee accounting input).
CREATE TABLE IF NOT EXISTS billing_records (
  run_id TEXT PRIMARY KEY,
  line JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Append-only audit log for security-relevant operations
-- (auth, provider connect, approvals, destructive tool use, retries).
CREATE TABLE IF NOT EXISTS audit_log (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor TEXT,
  action TEXT NOT NULL,
  run_id TEXT,
  project_id TEXT,
  org_id TEXT,
  detail JSONB
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log (ts);
CREATE INDEX IF NOT EXISTS idx_audit_run ON audit_log (run_id);
CREATE INDEX IF NOT EXISTS idx_audit_org ON audit_log (org_id);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log (action);

INSERT INTO schema_migrations (version) VALUES ('002_persistence')
ON CONFLICT (version) DO NOTHING;
