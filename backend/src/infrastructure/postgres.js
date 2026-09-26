'use strict';

// PostgreSQL durable datastore. Zero hard dependency: the `pg` module is
// required lazily so unit tests and demo mode run without it. Production
// with DATASTORE_PROVIDER=postgres (or auto + DATABASE_URL) fails with an
// explicit operational error when `pg` is missing or the database is
// unreachable — it NEVER silently falls back to JSON file storage.
//
// Tables are created by backend/migrations/001_init.sql. All queries are
// parameterized. Provider credentials are stored as CredentialStore
// ciphertext only; this module never encrypts/decrypts or logs secrets.

const crypto = require('crypto');

// Run-index retention is scoped to the ownership boundary (per tenant), never
// a global "keep newest N" cap — a global cap evicts one tenant's history when
// another tenant is busy. The read window is bounded for memory safety, and
// tenant/project filtering happens at the query level (JSONB `orgId`/
// `projectId` on the summary) so no single tenant's listing is truncated by
// another tenant's volume.
const RUN_INDEX_PER_TENANT = 1000;
const RUN_INDEX_READ_LIMIT = 10000;

function evaluationKey(evidence) {
  if (evidence && typeof evidence.id === 'string' && evidence.id) return `id:${evidence.id}`;
  return `hash:${crypto.createHash('sha256').update(JSON.stringify(evidence || null)).digest('hex')}`;
}

function requirePg() {
  try {
    // eslint-disable-next-line global-require, import/no-extraneous-dependencies
    return require('pg');
  } catch (e) {
    const err = new Error(
      'postgres datastore requested but the "pg" module is not installed (npm install pg); refusing to fall back to file storage',
    );
    err.code = 'datastore_unavailable';
    throw err;
  }
}

class PostgresDatastore {
  constructor({ connectionString, ssl = false, poolMax = 10, statementTimeoutMs = 10000, logger = null }) {
    if (!connectionString) {
      const err = new Error('DATABASE_URL is required for the postgres datastore');
      err.code = 'datastore_misconfigured';
      throw err;
    }
    this.connectionString = connectionString;
    this.ssl = ssl;
    this.poolMax = poolMax;
    this.statementTimeoutMs = statementTimeoutMs;
    this.log = logger;
    this._pool = null;
    this.kind = 'postgres';
  }

  _poolOrThrow() {
    if (!this._pool) {
      const { Pool } = requirePg();
      this._pool = new Pool({
        connectionString: this.connectionString,
        max: this.poolMax,
        ssl: this.ssl ? { rejectUnauthorized: true } : undefined,
        statement_timeout: this.statementTimeoutMs,
      });
      this._pool.on('error', (e) => {
        try {
          if (this.log && typeof this.log.warn === 'function') {
            this.log.warn('postgres pool error', { error: String((e && e.message) || e).slice(0, 200) });
          }
        } catch {}
      });
    }
    return this._pool;
  }

  async ping() {
    const pool = this._poolOrThrow();
    const client = await pool.connect();
    try {
      await client.query('SELECT 1');
      return { ok: true };
    } finally {
      client.release();
    }
  }

  async query(text, params = []) {
    const pool = this._poolOrThrow();
    return pool.query(text, params);
  }

  // Transaction helper for tenant/project/run metadata + idempotency where
  // required. `fn(client)` runs inside BEGIN/COMMIT; any throw rolls back.
  async withTransaction(fn) {
    const pool = this._poolOrThrow();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch {}
      throw e;
    } finally {
      client.release();
    }
  }

  // --- Run index / event log / snapshot surface (mirrors FileStore) ---
  async loadRunIndex(query = {}) {
    const opts = (typeof query === 'number') ? { limit: query } : (query || {});
    const limit = Math.max(1, Math.min(100000, Number(opts.limit) || RUN_INDEX_READ_LIMIT));
    const orgId = opts.orgId ? String(opts.orgId).slice(0, 128) : null;
    const projectId = opts.projectId ? String(opts.projectId).slice(0, 128) : null;
    let rows;
    if (projectId) {
      rows = (await this.query(
        "SELECT summary FROM run_index WHERE summary->>'projectId' = $1 ORDER BY updated_at DESC NULLS LAST, id DESC LIMIT $2",
        [projectId, limit],
      )).rows;
    } else if (orgId) {
      rows = (await this.query(
        "SELECT summary FROM run_index WHERE summary->>'orgId' = $1 ORDER BY updated_at DESC NULLS LAST, id DESC LIMIT $2",
        [orgId, limit],
      )).rows;
    } else {
      rows = (await this.query(
        'SELECT summary FROM run_index ORDER BY updated_at DESC NULLS LAST, id DESC LIMIT $1',
        [limit],
      )).rows;
    }
    return rows.map((r) => r.summary).filter(Boolean);
  }

  // Bound the run_index table per tenant (newest N per owning org). Legacy
  // ownerless summaries share one '' partition. Never deletes another tenant's
  // records merely because a different tenant is more active.
  async pruneRunIndex(client = null) {
    const exec = (client && typeof client.query === 'function')
      ? (text, params) => client.query(text, params)
      : (text, params) => this.query(text, params);
    await exec(
      `DELETE FROM run_index WHERE id IN (
         SELECT id FROM (
           SELECT id, ROW_NUMBER() OVER (
             PARTITION BY COALESCE(summary->>'orgId','') ORDER BY updated_at DESC NULLS LAST, id DESC
           ) AS rn FROM run_index
         ) ranked WHERE rn > $1
       )`,
      [RUN_INDEX_PER_TENANT],
    );
  }

  async upsertRunSummary(summary) {
    if (!summary || !summary.id) return { ok: false, error: 'summary requires id' };
    try {
      await this.query(
        `INSERT INTO run_index (id, summary, updated_at) VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (id) DO UPDATE SET summary = EXCLUDED.summary, updated_at = NOW()`,
        [summary.id, JSON.stringify(summary)],
      );
      await this.pruneRunIndex();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e).slice(0, 200) };
    }
  }

  async loadEvents(runId, limit = 500) {
    const { rows } = await this.query(
      'SELECT envelope FROM run_events WHERE run_id = $1 ORDER BY seq ASC LIMIT $2',
      [String(runId), limit],
    );
    // Keep replay bounded to the newest window, matching FileStore semantics.
    const list = rows.map((r) => r.envelope).filter(Boolean);
    return list.slice(-limit);
  }

  async saveEvents(runId, events) {
    const list = Array.isArray(events) ? events.slice(-500) : [];
    try {
      await this.withTransaction(async (client) => {
        await client.query('DELETE FROM run_events WHERE run_id = $1', [String(runId)]);
        for (const envelope of list) {
          await client.query(
            'INSERT INTO run_events (run_id, seq, type, envelope) VALUES ($1, $2, $3, $4::jsonb)',
            [String(runId), Number(envelope && envelope.seq) || 0, String((envelope && envelope.type) || 'unknown'), JSON.stringify(envelope)],
          );
        }
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e).slice(0, 200) };
    }
  }

  // Event envelopes are immutable. Append with conflict protection so two API
  // instances persisting their local event-bus views cannot delete each
  // other's events. The bounded trim runs in the same transaction.
  async appendEvents(runId, events) {
    const list = (Array.isArray(events) ? events : [])
      .filter((envelope) => envelope && Number.isFinite(Number(envelope.seq)))
      .slice(-500);
    try {
      await this.withTransaction(async (client) => {
        for (const envelope of list) {
          await client.query(
            `INSERT INTO run_events (run_id, seq, type, envelope)
             VALUES ($1, $2, $3, $4::jsonb)
             ON CONFLICT (run_id, seq) DO NOTHING`,
            [String(runId), Number(envelope.seq), String(envelope.type || 'unknown'), JSON.stringify(envelope)],
          );
        }
        await client.query(
          `DELETE FROM run_events
           WHERE run_id = $1
             AND seq < COALESCE((
               SELECT seq FROM run_events
               WHERE run_id = $1
               ORDER BY seq DESC OFFSET 499 LIMIT 1
             ), -1)`,
          [String(runId)],
        );
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e).slice(0, 200) };
    }
  }

  async loadSnapshot(runId) {
    const { rows } = await this.query('SELECT snapshot FROM run_snapshots WHERE run_id = $1', [String(runId)]);
    return (rows[0] && rows[0].snapshot) || null;
  }

  async saveSnapshot(runId, snapshot) {
    if (!snapshot) return { ok: false, error: 'no snapshot' };
    try {
      await this.query(
        `INSERT INTO run_snapshots (run_id, snapshot, updated_at) VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (run_id) DO UPDATE SET snapshot = EXCLUDED.snapshot, updated_at = NOW()`,
        [String(runId), JSON.stringify(snapshot)],
      );
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e).slice(0, 200) };
    }
  }

  // --- Idempotency (UNIQUE key, cross-instance safe) ---
  async idempotencyBegin(key, meta = {}) {
    try {
      const inserted = await this.query(
        `INSERT INTO idempotency (key, state, run_id, op, result, error, created_at, updated_at)
         VALUES ($1, $2, $3, $4, NULL, NULL, NOW(), NOW()) ON CONFLICT DO NOTHING`,
        [key, meta.state || 'running', meta.runId || null, meta.op || null],
      );
      const { rows } = await this.query('SELECT key, state, run_id AS "runId", op, result, error FROM idempotency WHERE key = $1', [key]);
      const rec = rows[0] || null;
      return { record: rec, fresh: inserted.rowCount === 1 };
    } catch (e) {
      const err = new Error(`idempotency begin failed: ${String((e && e.message) || e).slice(0, 160)}`);
      err.code = 'idempotency_unavailable';
      throw err;
    }
  }

  async idempotencyGet(key) {
    const { rows } = await this.query('SELECT key, state, run_id AS "runId", op, result, error FROM idempotency WHERE key = $1', [key]);
    return rows[0] || null;
  }

  async idempotencyFinish(key, { state, result = null, error = null }) {
    await this.query(
      'UPDATE idempotency SET state = $2, result = $3::jsonb, error = $4, updated_at = NOW() WHERE key = $1',
      [key, state, result === null || result === undefined ? null : JSON.stringify(result), error],
    );
  }

  // --- Full-index replace (mirrors FileStore.saveRunIndex semantics) ---
  async saveRunIndex(list) {
    const arr = Array.isArray(list) ? list : [];
    try {
      await this.withTransaction(async (client) => {
        for (const summary of arr) {
          if (!summary || !summary.id) continue;
          await client.query(
            `INSERT INTO run_index (id, summary, updated_at) VALUES ($1, $2::jsonb, NOW())
             ON CONFLICT (id) DO UPDATE SET summary = EXCLUDED.summary, updated_at = NOW()`,
            [summary.id, JSON.stringify(summary)],
          );
        }
        await this.pruneRunIndex(client);
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e).slice(0, 200) };
    }
  }

  // --- Evaluations (bounded, newest-first read to match file adapter) ---
  async loadEvals(limit = 200) {
    const { rows } = await this.query(
      'SELECT evidence FROM evaluations ORDER BY id DESC LIMIT $1',
      [Math.max(1, Math.min(500, Number(limit) || 200))],
    );
    return rows.map((r) => r.evidence).filter(Boolean).reverse();
  }

  async saveEvals(list) {
    return this.appendEvals(list);
  }

  // Evaluation records are immutable evidence. Keyed appends prevent one
  // instance's periodic flush from deleting records written by another.
  async appendEvals(list) {
    const arr = Array.isArray(list) ? list.slice(-200) : [];
    try {
      await this.withTransaction(async (client) => {
        for (const evidence of arr) {
          await client.query(
            `INSERT INTO evaluations (evaluation_key, run_id, evidence)
             VALUES ($1, $2, $3::jsonb)
             ON CONFLICT (evaluation_key) DO NOTHING`,
            [evaluationKey(evidence), evidence && evidence.runId ? String(evidence.runId) : null, JSON.stringify(evidence)],
          );
        }
        await client.query(
          'DELETE FROM evaluations WHERE id NOT IN (SELECT id FROM evaluations ORDER BY id DESC LIMIT 200)',
        );
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e).slice(0, 200) };
    }
  }

  // --- Intelligence docs (keyed; 'global' mirrors intelligence.json) ---
  async loadIntelligence(key = 'global') {
    const { rows } = await this.query('SELECT doc FROM intelligence_docs WHERE key = $1', [String(key)]);
    return (rows[0] && rows[0].doc) || null;
  }

  async saveIntelligence(doc, key = 'global') {
    if (!doc || typeof doc !== 'object') return { ok: false, error: 'no intelligence doc' };
    try {
      await this.query(
        `INSERT INTO intelligence_docs (key, doc, updated_at) VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (key) DO UPDATE SET doc = EXCLUDED.doc, updated_at = NOW()`,
        [String(key), JSON.stringify(doc)],
      );
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e).slice(0, 200) };
    }
  }

  // --- Billing lines (one canonical line per run) ---
  async saveBilling(runId, line) {
    if (!runId || !line || typeof line !== 'object') return { ok: false, error: 'billing line requires runId and object' };
    try {
      await this.query(
        `INSERT INTO billing_records (run_id, line, updated_at) VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (run_id) DO UPDATE SET line = EXCLUDED.line, updated_at = NOW()`,
        [String(runId), JSON.stringify(line)],
      );
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e).slice(0, 200) };
    }
  }

  async loadBilling(runId) {
    const { rows } = await this.query('SELECT line FROM billing_records WHERE run_id = $1', [String(runId)]);
    return (rows[0] && rows[0].line) || null;
  }

  // --- Audit log (append-only; failures are reported, never thrown into
  // request paths — callers log instead) ---
  async audit({ actor = null, action, runId = null, projectId = null, orgId = null, detail = null } = {}) {
    if (!action) return { ok: false, error: 'action required' };
    try {
      await this.query(
        'INSERT INTO audit_log (actor, action, run_id, project_id, org_id, detail) VALUES ($1, $2, $3, $4, $5, $6::jsonb)',
        [
          actor ? String(actor).slice(0, 200) : null,
          String(action).slice(0, 120),
          runId ? String(runId).slice(0, 200) : null,
          projectId ? String(projectId).slice(0, 200) : null,
          orgId ? String(orgId).slice(0, 200) : null,
          detail === null || detail === undefined ? null : JSON.stringify(detail),
        ],
      );
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e).slice(0, 200) };
    }
  }

  // --- Tenants: users / sessions / projects / organizations ---
  // Password hashes and session hashes only — never plaintext secrets.
  async getUserByEmail(email) {
    const { rows } = await this.query('SELECT id, email, name, password_hash AS "passwordHash", password_salt AS "passwordSalt", org_id AS "orgId", role, created_at AS "createdAt" FROM users WHERE email = $1', [String(email || '').trim().toLowerCase()]);
    return rows[0] || null;
  }

  async getUserById(id) {
    const { rows } = await this.query('SELECT id, email, name, password_hash AS "passwordHash", password_salt AS "passwordSalt", org_id AS "orgId", role, created_at AS "createdAt" FROM users WHERE id = $1', [String(id)]);
    return rows[0] || null;
  }

  async createUser({ id, email, name, passwordHash, passwordSalt, orgId, role = 'admin' }) {
    await this.query(
      'INSERT INTO users (id, email, name, password_hash, password_salt, org_id, role) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [id, email, name, passwordHash, passwordSalt, orgId, role],
    );
  }

  async ensureOrganization({ id, name = '' }) {
    await this.query(
      'INSERT INTO organizations (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
      [String(id), String(name || '').slice(0, 200)],
    );
  }

  async createSession({ hash, userId, expiresAt }) {
    await this.query(
      'INSERT INTO sessions (hash, user_id, expires_at) VALUES ($1, $2, $3)',
      [String(hash), String(userId), expiresAt instanceof Date ? expiresAt : new Date(expiresAt)],
    );
  }

  async getSessionByHash(hash) {
    const { rows } = await this.query('SELECT hash, user_id AS "userId", created_at AS "createdAt", expires_at AS "expiresAt" FROM sessions WHERE hash = $1', [String(hash)]);
    return rows[0] || null;
  }

  async deleteSession(hash) {
    await this.query('DELETE FROM sessions WHERE hash = $1', [String(hash)]);
  }

  async pruneExpiredSessions() {
    await this.query('DELETE FROM sessions WHERE expires_at <= NOW()');
  }

  async listProjects({ orgId = null, ownerId = null, globalAdmin = false } = {}) {
    if (globalAdmin) {
      const { rows } = await this.query('SELECT id, org_id AS "orgId", owner_id AS "ownerId", name, reference_model_id AS "referenceModelId", policy, privacy_mode AS "privacyMode", created_at AS "createdAt", updated_at AS "updatedAt" FROM projects ORDER BY created_at DESC LIMIT 500');
      return rows;
    }
    const { rows } = await this.query(
      'SELECT id, org_id AS "orgId", owner_id AS "ownerId", name, reference_model_id AS "referenceModelId", policy, privacy_mode AS "privacyMode", created_at AS "createdAt", updated_at AS "updatedAt" FROM projects WHERE org_id = $1 OR owner_id = $2 ORDER BY created_at DESC LIMIT 500',
      [orgId, ownerId],
    );
    return rows;
  }

  async createProjectRow(row) {
    await this.query(
      'INSERT INTO projects (id, org_id, owner_id, name, reference_model_id, policy, privacy_mode) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [row.id, row.orgId, row.ownerId, row.name, row.referenceModelId || null, row.policy || 'balanced', row.privacyMode || 'standard'],
    );
  }

  async updateProjectRow(id, patch = {}) {
    const sets = [];
    const params = [];
    const push = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };
    if (patch.name !== undefined) push('name', String(patch.name).slice(0, 100));
    if (patch.referenceModelId !== undefined) push('reference_model_id', patch.referenceModelId ? String(patch.referenceModelId).slice(0, 200) : null);
    if (patch.policy !== undefined) push('policy', patch.policy);
    if (patch.privacyMode !== undefined) push('privacy_mode', patch.privacyMode);
    if (!sets.length) return;
    params.push(String(id));
    await this.query(`UPDATE projects SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${params.length}`, params);
  }

  async close() {
    if (this._pool) {
      try { await this._pool.end(); } catch {}
      this._pool = null;
    }
  }
}

module.exports = { PostgresDatastore };
