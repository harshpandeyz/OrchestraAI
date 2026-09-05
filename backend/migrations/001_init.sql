-- 001_init.sql — OrchestraAI production relational schema (PostgreSQL).
--
-- Run with: psql "$DATABASE_URL" -f backend/migrations/001_init.sql
-- Migrations are additive and idempotent (IF NOT EXISTS). Encryption at
-- rest for provider credentials is handled by CredentialStore (ciphertext
-- only reaches the database); this schema never stores plaintext secrets.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  org_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_users_org ON users (org_id);

CREATE TABLE IF NOT EXISTS sessions (
  hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT 'Untitled project',
  reference_model_id TEXT,
  policy TEXT NOT NULL DEFAULT 'balanced',
  privacy_mode TEXT NOT NULL DEFAULT 'standard',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_projects_org ON projects (org_id);
CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects (owner_id);

-- Run metadata: one row per run summary (terminal history + active index).
CREATE TABLE IF NOT EXISTS run_index (
  id TEXT PRIMARY KEY,
  summary JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Durable per-run event log for multi-instance SSE replay.
CREATE TABLE IF NOT EXISTS run_events (
  run_id TEXT NOT NULL,
  seq BIGINT NOT NULL,
  type TEXT NOT NULL DEFAULT 'unknown',
  envelope JSONB NOT NULL,
  PRIMARY KEY (run_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_run_events_run ON run_events (run_id);

CREATE TABLE IF NOT EXISTS run_snapshots (
  run_id TEXT PRIMARY KEY,
  snapshot JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Cross-instance idempotency: UNIQUE key enforces exactly-once reservation
-- across backend instances (paid/durable side effects must use this, never
-- a process-local Map, in production).
CREATE TABLE IF NOT EXISTS idempotency (
  key TEXT PRIMARY KEY,
  state TEXT NOT NULL DEFAULT 'running',
  run_id TEXT,
  op TEXT,
  result JSONB,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_idempotency_run ON idempotency (run_id);

INSERT INTO schema_migrations (version) VALUES ('001_init')
ON CONFLICT (version) DO NOTHING;
