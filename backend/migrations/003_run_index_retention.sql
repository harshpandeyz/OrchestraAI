-- 003_run_index_retention.sql — tenant-scoped run-index access + retention.
--
-- The run index is the durable run listing. It is now retained per tenant
-- (newest N per owning org, never a global "keep newest N" cap that would
-- evict one tenant's history when another tenant is busy) and read with
-- tenant/project filtering on the summary JSONB. These indexes cover those
-- access patterns. Additive and idempotent (IF NOT EXISTS).
--
-- Run with: psql "$DATABASE_URL" -f backend/migrations/003_run_index_retention.sql
-- (or let the container entrypoint apply backend/migrations/*.sql in order).

-- Listing / per-tenant retention both order by the summary timestamp.
CREATE INDEX IF NOT EXISTS idx_run_index_updated ON run_index (updated_at DESC NULLS LAST);

-- Tenant-scoped listings (WHERE summary->>'orgId' = $1).
CREATE INDEX IF NOT EXISTS idx_run_index_org ON run_index ((summary->>'orgId'), updated_at DESC NULLS LAST);

-- Project-scoped listings (WHERE summary->>'projectId' = $1).
CREATE INDEX IF NOT EXISTS idx_run_index_project ON run_index ((summary->>'projectId'), updated_at DESC NULLS LAST);

INSERT INTO schema_migrations (version) VALUES ('003_run_index_retention')
ON CONFLICT (version) DO NOTHING;