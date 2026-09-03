'use strict';

// File persistence: run summaries, per-run event logs, latest snapshot,
// evaluation records.
//
// Durable across restarts: COMPLETED / FAILED / CANCELLED summaries, event
// logs, snapshots, evaluations. NOT durable: in-flight execution — a restart
// marks previously-active runs interrupted (server.js), because resuming
// mid-step is an explicit non-goal.
//
// Reliability properties:
//   - writes are atomic where practical (tmp file + rename)
//   - the data directory is (re)created on every write, not just construction
//   - corrupted files are quarantined to *.corrupt-<ts> and reported, never
//     crash the process and never silently poison reads
//   - event retention is bounded (500/run); run index bounded (200 entries)
//   - every write returns { ok, error? } so callers can log instead of
//     silently swallowing failures
//
// Layout under RUNTIME_DATA_DIR:
//   runs.json             — [RunSummary...] (active + terminal history)
//   <runId>.events.json   — event envelopes (bounded)
//   <runId>.snapshot.json — last snapshot
//   evals.json            — [Evaluation...] (bounded)

const fs = require('fs');
const path = require('path');

const MAX_EVENTS_PER_RUN = 500;
const MAX_RUN_INDEX = 200;
const MAX_EVALS = 200;
const MAX_BYTES = 5_000_000;

class FileStore {
  constructor(dir, options = {}) {
    this.dir = dir;
    this.log = options.logger || null;
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

  _writeJson(name, value) {
    const dirStatus = this.ensureDir();
    if (!dirStatus.ok) return dirStatus;
    let text;
    try {
      text = JSON.stringify(value);
    } catch (e) {
      this._logWarn(`serialize failed: ${name}`, e);
      return { ok: false, error: 'unserializable value' };
    }
    if (text.length > MAX_BYTES) text = text.slice(0, MAX_BYTES);
    const tmp = this._p(`${name}.tmp-${process.pid}`);
    try {
      fs.writeFileSync(tmp, text, 'utf8');
      fs.renameSync(tmp, this._p(name));
      return { ok: true };
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch {}
      this._logWarn(`write failed: ${name}`, e);
      return { ok: false, error: String((e && e.message) || e).slice(0, 200) };
    }
  }

  saveRunIndex(runs) {
    const list = Array.isArray(runs) ? runs.slice(-MAX_RUN_INDEX) : [];
    return this._writeJson('runs.json', list);
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
    return this.saveRunIndex(index.slice(-MAX_RUN_INDEX));
  }

  saveEvents(runId, events) {
    const list = Array.isArray(events) ? events.slice(-MAX_EVENTS_PER_RUN) : [];
    return this._writeJson(`${runId}.events.json`, list);
  }

  loadEvents(runId) {
    const { value } = this._readJson(`${runId}.events.json`, []);
    return Array.isArray(value) ? value : [];
  }

  saveSnapshot(runId, snapshot) {
    if (!snapshot) return { ok: false, error: 'no snapshot' };
    return this._writeJson(`${runId}.snapshot.json`, snapshot);
  }

  loadSnapshot(runId) {
    const { value } = this._readJson(`${runId}.snapshot.json`, null);
    return value && typeof value === 'object' ? value : null;
  }

  saveEvals(evals) {
    const list = Array.isArray(evals) ? evals.slice(-MAX_EVALS) : [];
    return this._writeJson('evals.json', list);
  }

  loadEvals() {
    const { value } = this._readJson('evals.json', []);
    return Array.isArray(value) ? value : [];
  }
}

module.exports = { FileStore, MAX_EVENTS_PER_RUN, MAX_RUN_INDEX, MAX_EVALS };
