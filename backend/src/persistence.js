'use strict';

// File persistence: run summaries, per-run event logs, latest snapshot,
// evaluation records, idempotency records.
//
// Durable across restarts: COMPLETED / FAILED / CANCELLED summaries, event
// logs, snapshots, evaluations, idempotency. NOT durable: in-flight execution
// — a restart marks previously-active runs interrupted (server.js), because
// resuming mid-step is an explicit non-goal.
//
// Reliability properties:
//   - writes are atomic (tmp file + fsync + rename); NEVER truncate JSON at an
//     arbitrary byte boundary. Oversized payloads are pruned structurally
//     (drop oldest entries) or rejected safely — always valid JSON or no write.
//   - the data directory is (re)created on every write, not just construction
//   - corrupted files are quarantined to *.corrupt-<ts> and reported, never
//     crash the process and never silently poison reads
//   - event retention is bounded (500/run); run index bounded per tenant
//     (newest 1000 per owning org — never a global cap that evicts another
//     tenant's history)
//   - every write returns { ok, error?, pruned? } so callers can log instead of
//     silently swallowing failures
//
// Layout under RUNTIME_DATA_DIR:
//   runs.json             — [RunSummary...] (active + terminal history)
//   <runId>.events.json   — event envelopes (bounded)
//   <runId>.snapshot.json — last snapshot
//   evals.json            — [Evaluation...] (bounded)
//   idempotency.json      — [IdempotencyRecord...] (bounded, Session 3 primitive)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_EVENTS_PER_RUN = 500;
const MAX_RUN_INDEX = 200;
const MAX_EVALS = 200;
const MAX_IDEMPOTENCY = 1000;
const MAX_BYTES = 5_000_000;

// Retention is scoped to the ownership boundary, never a global cap. The run
// index keeps the newest `MAX_RUN_INDEX_PER_TENANT` summaries PER tenant, so
// one tenant's activity can never evict another tenant's history (a global
// "keep newest 200" cap used to do exactly that). The legacy MAX_RUN_INDEX
// export is retained for backwards compatibility only.
const MAX_RUN_INDEX_PER_TENANT = 1000;

function runTenantKey(run) {
  const orgId = (run && (run.orgId || (run.ownership && run.ownership.orgId))) || '';
  return String(orgId).slice(0, 128);
}

// Keep the newest `cap` entries of each tenant, preserving the original global
// ordering of the survivors. Unscoped/legacy records share one '' bucket.
function retainPerTenant(runs, cap) {
  const buckets = new Map();
  for (const r of runs) {
    const k = runTenantKey(r);
    const arr = buckets.get(k);
    if (arr) arr.push(r);
    else buckets.set(k, [r]);
  }
  const keep = new Set();
  for (const entries of buckets.values()) {
    for (const r of entries.slice(Math.max(0, entries.length - cap))) keep.add(r);
  }
  return runs.filter((r) => keep.has(r));
}

// Retention defaults: per-run files invisible to both live state and the
// persisted index (i.e. no longer retryable/inspectable via the API) become
// eligible for garbage collection after a grace period. Active runs and
// indexed runs are NEVER touched.
const RETENTION_GRACE_MS = 24 * 60 * 60 * 1000;
const TMP_MAX_AGE_MS = 60 * 60 * 1000;
const MAX_CORRUPT_KEPT = 20;

// Per-collection caps for intelligence.json compaction. Unknown arrays fall
// back to GENERIC_ARRAY_CAP. Caps apply to the persisted document only;
// live stores keep their own (usually tighter) bounds.
const INTELLIGENCE_CAPS = {
  outcomeEvals: 200,
  routingHistory: 300,
  history: 300,
  benchmarks: 500,
  entries: 500,
  observations: 500,
  evaluations: 200,
  cache: 500,
  versions: 100,
};
const GENERIC_ARRAY_CAP = 500;

// Count entries above caps (0 = already compact). Used to decide whether a
// prune pass made progress, so the bounded-serialize loop terminates.
function intelligenceOverflow(doc, caps = INTELLIGENCE_CAPS) {
  if (!doc || typeof doc !== 'object') return 0;
  const capFor = (key) => (Number.isFinite(caps[key]) ? caps[key] : GENERIC_ARRAY_CAP);
  let excess = 0;
  const walkKeyed = (node) => {
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if (Array.isArray(v)) {
        excess += Math.max(0, v.length - capFor(k));
        for (const item of v) walkKeyed(item);
      } else if (v && typeof v === 'object') walkKeyed(v);
    }
  };
  walkKeyed(doc);
  return excess;
}

// Structurally compact an intelligence document so it cannot grow into a
// monolithic file that threatens startup or write reliability. Keeps newest
// entries (history is append-ordered), never slices JSON strings.
function pruneIntelligenceDoc(doc, caps = INTELLIGENCE_CAPS) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return doc;
  const out = Array.isArray(doc) ? [...doc] : { ...doc };
  const capFor = (key) => (Number.isFinite(caps[key]) ? caps[key] : GENERIC_ARRAY_CAP);
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if (Array.isArray(v)) {
        const cap = capFor(k);
        if (v.length > cap) node[k] = v.slice(-cap);
        // Recurse into kept entries (bounded count now).
        for (const item of node[k]) walk(item);
      } else if (v && typeof v === 'object') {
        walk(v);
      }
    }
  };
  walk(out);
  return out;
}

class FileStore {
  constructor(dir, options = {}) {
    this.dir = dir;
    this.log = options.logger || null;
    this.maxBytes = options.maxBytes || MAX_BYTES;
    this.ensureDir();
  }

  ensureDir() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      return { ok: true };
    } catch (e) {
      this._logWarn('data dir create failed', e);
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  _logWarn(msg, e) {
    try {
      if (this.log && typeof this.log.warn === 'function') {
        this.log.warn(msg, { error: String((e && e.message) || e).slice(0, 200) });
      }
    } catch {}
  }

  _p(name) {
    // Run IDs are validated upstream; basename confinement is defense in depth.
    return path.join(this.dir, path.basename(name));
  }

  _readJson(name, fallback) {
    let raw;
    try {
      raw = fs.readFileSync(this._p(name), 'utf8');
    } catch (e) {
      if (e && e.code !== 'ENOENT') this._logWarn(`read failed: ${name}`, e);
      return { value: fallback, ok: e && e.code === 'ENOENT' ? true : false, error: e && e.code === 'ENOENT' ? null : String((e && e.message) || e) };
    }
    if (!raw.trim()) return { value: fallback, ok: false, error: `empty: ${name}` };
    try {
      return { value: JSON.parse(raw), ok: true };
    } catch (e) {
      // Quarantine the corrupt file so the next read starts clean.
      try {
        fs.renameSync(this._p(name), this._p(`${name}.corrupt-${Date.now()}`));
      } catch {}
      this._logWarn(`corrupt file quarantined: ${name}`, e);
      return { value: fallback, ok: false, error: `corrupt: ${name}` };
    }
  }

  // Serialize structurally: if the payload exceeds maxBytes, prune by dropping
  // oldest array entries (never slice the JSON string). Returns
  // { text, pruned } or { error } when it cannot fit even minimally.
  _serializePrunable(name, value, prune) {
    let current = value;
    let pruned = 0;
    for (let attempt = 0; attempt < 6; attempt++) {
      let text;
      try {
        text = JSON.stringify(current);
      } catch (e) {
        this._logWarn(`serialize failed: ${name}`, e);
        return { error: 'unserializable value' };
      }
      if (text.length <= this.maxBytes) return { text, pruned };
      // Too large: ask the pruner for a smaller value.
      if (typeof prune !== 'function') break;
      const next = prune(current, attempt);
      if (!next || next === current) break;
      pruned++;
      current = next;
    }
    // Final attempt: report safely without writing malformed JSON.
    try {
      const text = JSON.stringify(current);
      if (text.length <= this.maxBytes) return { text, pruned };
    } catch {}
    return { error: `too_large: ${name} exceeds ${this.maxBytes} bytes even after pruning` };
  }

  _writeJson(name, value, prune) {
    const dirStatus = this.ensureDir();
    if (!dirStatus.ok) return dirStatus;
    const ser = this._serializePrunable(name, value, prune);
    if (ser.error) {
      this._logWarn(`write rejected (not truncated): ${name}`, new Error(ser.error));
      return { ok: false, error: ser.error };
    }
    const tmp = this._p(`${name}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
    try {
      fs.writeFileSync(tmp, ser.text, 'utf8');
      // Flush file content before atomic rename where the platform allows it.
      try {
        const fd = fs.openSync(tmp, 'r');
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      } catch {}
      fs.renameSync(tmp, this._p(name));
      return { ok: true, ...(ser.pruned ? { pruned: ser.pruned } : {}) };
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch {}
      this._logWarn(`write failed: ${name}`, e);
      return { ok: false, error: String((e && e.message) || e).slice(0, 200) };
    }
  }

  saveRunIndex(runs) {
    const list = Array.isArray(runs) ? runs : [];
    const retained = retainPerTenant(list, MAX_RUN_INDEX_PER_TENANT);
    return this._writeJson('runs.json', retained, (cur, attempt) => {
      if (!Array.isArray(cur) || cur.length <= 10) return null;
      return cur.slice(-Math.max(10, Math.floor(cur.length / 2)));
    });
  }

  loadRunIndex() {
    const { value } = this._readJson('runs.json', []);
    return Array.isArray(value) ? value : [];
  }

  // Insert-or-replace a single summary so terminal states survive restarts
  // even when the periodic full-index write races a shutdown.
  upsertRunSummary(summary) {
    if (!summary || !summary.id) return { ok: false, error: 'summary requires id' };
    const index = this.loadRunIndex().filter((r) => r && r.id !== summary.id);
    index.push(summary);
    return this.saveRunIndex(index);
  }

  saveEvents(runId, events) {
    const list = Array.isArray(events) ? events.slice(-MAX_EVENTS_PER_RUN) : [];
    return this._writeJson(`${runId}.events.json`, list, (cur) => {
      if (!Array.isArray(cur) || cur.length <= 10) return null;
      return cur.slice(-Math.max(10, Math.floor(cur.length / 2)));
    });
  }

  // Merge newly observed immutable envelopes instead of replacing the whole
  // run log. This keeps the adapter's behavior aligned with Postgres when a
  // persistence tick races another in-process writer.
  appendEvents(runId, events) {
    const merged = new Map();
    for (const event of this.loadEvents(runId)) {
      if (event && Number.isFinite(event.seq)) merged.set(event.seq, event);
    }
    for (const event of Array.isArray(events) ? events : []) {
      if (event && Number.isFinite(event.seq) && !merged.has(event.seq)) merged.set(event.seq, event);
    }
    return this.saveEvents(runId, Array.from(merged.values()).sort((a, b) => a.seq - b.seq).slice(-MAX_EVENTS_PER_RUN));
  }

  loadEvents(runId) {
    const { value } = this._readJson(`${runId}.events.json`, []);
    return Array.isArray(value) ? value : [];
  }

  saveSnapshot(runId, snapshot) {
    if (!snapshot) return { ok: false, error: 'no snapshot' };
    // Snapshots prune oldest trace/series/messages structurally when huge.
    return this._writeJson(`${runId}.snapshot.json`, snapshot, (cur) => {
      if (!cur || typeof cur !== 'object') return null;
      const next = { ...cur };
      let shrunk = false;
      for (const k of ['trace', 'series', 'messages', 'decisions', 'changes']) {
        if (Array.isArray(next[k]) && next[k].length > 20) {
          next[k] = next[k].slice(-Math.floor(next[k].length / 2));
          shrunk = true;
        }
      }
      if (next.context && Array.isArray(next.context.items) && next.context.items.length > 50) {
        next.context = { ...next.context, items: next.context.items.slice(-50) };
        shrunk = true;
      }
      return shrunk ? next : null;
    });
  }

  loadSnapshot(runId) {
    const { value } = this._readJson(`${runId}.snapshot.json`, null);
    return value && typeof value === 'object' ? value : null;
  }

  saveEvals(evals) {
    const list = Array.isArray(evals) ? evals.slice(-MAX_EVALS) : [];
    return this._writeJson('evals.json', list, (cur) => {
      if (!Array.isArray(cur) || cur.length <= 10) return null;
      return cur.slice(-Math.max(10, Math.floor(cur.length / 2)));
    });
  }

  loadEvals() {
    const { value } = this._readJson('evals.json', []);
    return Array.isArray(value) ? value : [];
  }

  saveIdempotency(records) {
    const list = Array.isArray(records) ? records.slice(-MAX_IDEMPOTENCY) : [];
    return this._writeJson('idempotency.json', list, (cur) => {
      if (!Array.isArray(cur) || cur.length <= 10) return null;
      return cur.slice(-Math.max(10, Math.floor(cur.length / 2)));
    });
  }

  loadIdempotency() {
    const { value } = this._readJson('idempotency.json', []);
    return Array.isArray(value) ? value : [];
  }

  // Session 2 intelligence persistence (additive): the IntelligenceStore dump
  // (model/task performance, routing history, benchmarks, semantic cache,
  // outcome evaluations, feedback). Same atomic-write + quarantine semantics.
  // The document is compacted structurally (newest entries kept) so the file
  // cannot grow without bound across restarts.
  saveIntelligence(doc) {
    if (!doc || typeof doc !== 'object') return { ok: false, error: 'no intelligence doc' };
    const halved = Object.fromEntries(
      Object.entries(INTELLIGENCE_CAPS).map(([k, v]) => [k, Math.max(10, Math.floor(v / 2))]),
    );
    return this._writeJson('intelligence.json', pruneIntelligenceDoc(doc), (cur) => {
      if (!cur || typeof cur !== 'object') return null;
      if (intelligenceOverflow(cur, halved) <= 0) return null;
      return pruneIntelligenceDoc(cur, halved);
    });
  }

  loadIntelligence() {
    const { value } = this._readJson('intelligence.json', null);
    return value && typeof value === 'object' ? value : null;
  }

  saveBilling(runId, line) {
    if (!runId || !line || typeof line !== 'object') return { ok: false, error: 'billing line requires runId and object' };
    return this._writeJson(`${runId}.billing.json`, line);
  }

  loadBilling(runId) {
    const { value } = this._readJson(`${runId}.billing.json`, null);
    return value && typeof value === 'object' ? value : null;
  }

  // Retention garbage collection for per-run physical files.
  //
  // The logical index (runs.json) is bounded, but per-run files
  // (<id>.events.json / .snapshot.json / .billing.json) otherwise grow
  // forever. A file is eligible ONLY when its run is neither active nor
  // present in the retained index (i.e. no longer retryable/inspectable via
  // the API) AND older than graceMs. Stale tmp files and surplus quarantined
  // corrupt files are also collected. Never throws; returns an observable
  // report { deleted, keptActive, keptIndexed, keptFresh, freedBytes, errors }.
  sweepRetention({ activeIds = [], indexIds = null, graceMs = RETENTION_GRACE_MS, dryRun = false } = {}) {
    const report = { deleted: [], keptActive: 0, keptIndexed: 0, keptFresh: 0, freedBytes: 0, errors: [] };
    let names;
    try {
      names = fs.readdirSync(this.dir);
    } catch (e) {
      report.errors.push(`list failed: ${String((e && e.message) || e).slice(0, 120)}`);
      return report;
    }
    const active = new Set(activeIds);
    let indexed = null;
    if (Array.isArray(indexIds)) {
      indexed = new Set(indexIds);
    } else {
      try {
        indexed = new Set(this.loadRunIndex().map((r) => r && r.id).filter(Boolean));
      } catch { indexed = new Set(); }
    }
    const nowMs = Date.now();
    const statAge = (full) => {
      try { return nowMs - fs.statSync(full).mtimeMs; } catch { return 0; }
    };
    const remove = (full, name) => {
      let size = 0;
      try { size = fs.statSync(full).size; } catch {}
      if (dryRun) { report.deleted.push(name); report.freedBytes += size; return; }
      try {
        fs.unlinkSync(full);
        report.deleted.push(name);
        report.freedBytes += size;
      } catch (e) {
        report.errors.push(`${name}: ${String((e && e.message) || e).slice(0, 120)}`);
      }
    };

    const perRunRe = /^(.+)\.(events|snapshot|billing)\.json$/;
    for (const name of names) {
      const full = this._p(name);
      // Stale temp files from interrupted atomic writes.
      if (name.includes('.tmp-')) {
        if (statAge(full) > TMP_MAX_AGE_MS) remove(full, name);
        continue;
      }
      const m = perRunRe.exec(name);
      if (!m) continue;
      const id = m[1];
      if (active.has(id)) { report.keptActive++; continue; }
      if (indexed.has(id)) { report.keptIndexed++; continue; }
      if (statAge(full) < graceMs) { report.keptFresh++; continue; }
      remove(full, name);
    }
    // Cap quarantined corrupt files (keep newest, delete oldest surplus).
    try {
      const corrupt = names
        .filter((n) => n.includes('.corrupt-'))
        .map((n) => ({ n, full: this._p(n), age: statAge(this._p(n)) }))
        .sort((a, b) => b.age - a.age);
      for (const c of corrupt.slice(MAX_CORRUPT_KEPT)) remove(c.full, c.n);
    } catch (e) {
      report.errors.push(`corrupt cap failed: ${String((e && e.message) || e).slice(0, 120)}`);
    }
    return report;
  }
}

module.exports = {
  FileStore,
  MAX_EVENTS_PER_RUN, MAX_RUN_INDEX, MAX_EVALS, MAX_IDEMPOTENCY, MAX_BYTES,
  MAX_RUN_INDEX_PER_TENANT, retainPerTenant,
  RETENTION_GRACE_MS, TMP_MAX_AGE_MS, MAX_CORRUPT_KEPT,
  INTELLIGENCE_CAPS, GENERIC_ARRAY_CAP,
  pruneIntelligenceDoc, intelligenceOverflow,
  // Production datastore boundary (Agent 1). FileStore is the explicit
  // development/test adapter (single-process atomic JSON). Production
  // multi-instance deployments must use the postgres adapter via
  // infrastructure/datastore.js + backend/migrations/*.sql. This guard
  // makes a postgres->file downgrade a loud operational error instead of a
  // silent fallback: call after resolving the datastore kind.
  assertNoSilentFallback,
  isFileAdapter,
};

// True when the resolved datastore is the file adapter (dev/test).
function isFileAdapter(kind) {
  return String(kind || 'file').toLowerCase() !== 'postgres';
}

// Throws code 'datastore_fallback' when a DATABASE_URL was configured but
// the resolved kind is still file (wiring bug). Never auto-swaps adapters.
function assertNoSilentFallback(config, resolvedKind) {
  const kind = String(resolvedKind || 'file').toLowerCase();
  const urlConfigured = !!(config && config.databaseUrl);
  if (urlConfigured && kind !== 'postgres') {
    const err = new Error('DATABASE_URL is configured but the resolved datastore is file; refusing to silently bypass Postgres');
    err.code = 'datastore_fallback';
    throw err;
  }
  return true;
}
