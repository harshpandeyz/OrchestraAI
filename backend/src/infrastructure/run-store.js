'use strict';

// Authoritative run-persistence adapter. ONE decision point for durable
// run state in production:
//
//   kind 'postgres' — PostgresDatastore is the source of truth. Every read
//                     goes to Postgres; every write goes to Postgres. A
//                     Postgres failure throws (reads) or returns { ok:false }
//                     (writes) — it NEVER silently serves file data instead.
//   kind 'file'     — explicit dev/test adapter (FileStore, atomic JSON
//                     with quarantine semantics). Selected only when no
//                     DATABASE_URL is configured (or DATASTORE_PROVIDER=file).
//
// Corruption is never "empty data": postgres errors are operational failures
// (fail closed); file corruption keeps FileStore's quarantine behavior.

function datastoreUnavailable(cause, op) {
  const err = new Error(`durable datastore unavailable during ${op}: ${String((cause && cause.message) || cause).slice(0, 160)}`);
  err.code = 'datastore_unavailable';
  return err;
}

class RunStore {
  constructor({ datastore, fileStore = null, logger = null } = {}) {
    if (!datastore) throw new Error('RunStore requires a datastore { kind, store, pg }');
    this.datastore = datastore;
    this.file = fileStore || datastore.store || null;
    this.log = logger;
  }

  get kind() { return this.datastore.kind; }

  get pg() { return this.datastore.pg || null; }

  _warn(op, error) {
    try {
      if (this.log && typeof this.log.warn === 'function') {
        this.log.warn(`run-store ${op} failed`, { kind: this.kind, error: String((error && error.message) || error).slice(0, 200) });
      }
    } catch {}
  }

  // --- Run index ---
  async loadRunIndex(query = {}) {
    const opts = (typeof query === 'number') ? { limit: query } : (query || {});
    if (this.kind === 'postgres') {
      try {
        return await this.pg.loadRunIndex(opts);
      } catch (e) {
        throw datastoreUnavailable(e, 'loadRunIndex');
      }
    }
    let list = this.file.loadRunIndex();
    // File adapter keeps the whole (per-tenant bounded) index in memory; apply
    // the same tenant/project filter the postgres query applies so callers get
    // one behavior across backends.
    if (opts.orgId || opts.projectId) {
      const orgId = String(opts.orgId || '');
      const projectId = String(opts.projectId || '');
      list = list.filter((r) => {
        if (!r) return false;
        if (projectId) return r.projectId === projectId;
        if (orgId) return r.orgId === orgId || (r.ownership && r.ownership.orgId === orgId);
        return true;
      });
    }
    return list;
  }

  async saveRunIndex(list) {
    if (this.kind === 'postgres') {
      try {
        return await this.pg.saveRunIndex(list);
      } catch (e) {
        const r = { ok: false, error: String((e && e.message) || e).slice(0, 200) };
        this._warn('saveRunIndex', e);
        return r;
      }
    }
    return this.file.saveRunIndex(list);
  }

  async upsertRunSummary(summary) {
    if (this.kind === 'postgres') {
      try {
        return await this.pg.upsertRunSummary(summary);
      } catch (e) {
        const r = { ok: false, error: String((e && e.message) || e).slice(0, 200) };
        this._warn('upsertRunSummary', e);
        return r;
      }
    }
    return this.file.upsertRunSummary(summary);
  }

  // --- Events ---
  async loadEvents(runId, limit = 500) {
    if (this.kind === 'postgres') {
      try {
        return await this.pg.loadEvents(runId, limit);
      } catch (e) {
        throw datastoreUnavailable(e, 'loadEvents');
      }
    }
    return this.file.loadEvents(runId);
  }

  async saveEvents(runId, events) {
    if (this.kind === 'postgres') {
      try {
        return await this.pg.saveEvents(runId, events);
      } catch (e) {
        const r = { ok: false, error: String((e && e.message) || e).slice(0, 200) };
        this._warn('saveEvents', e);
        return r;
      }
    }
    return this.file.saveEvents(runId, events);
  }

  async appendEvents(runId, events) {
    if (this.kind === 'postgres') {
      try {
        return await this.pg.appendEvents(runId, events);
      } catch (e) {
        const r = { ok: false, error: String((e && e.message) || e).slice(0, 200) };
        this._warn('appendEvents', e);
        return r;
      }
    }
    if (this.file && typeof this.file.appendEvents === 'function') return this.file.appendEvents(runId, events);
    return this.file.saveEvents(runId, events);
  }

  // --- Snapshots ---
  async loadSnapshot(runId) {
    if (this.kind === 'postgres') {
      try {
        return await this.pg.loadSnapshot(runId);
      } catch (e) {
        throw datastoreUnavailable(e, 'loadSnapshot');
      }
    }
    return this.file.loadSnapshot(runId);
  }

  async saveSnapshot(runId, snapshot) {
    if (this.kind === 'postgres') {
      try {
        return await this.pg.saveSnapshot(runId, snapshot);
      } catch (e) {
        const r = { ok: false, error: String((e && e.message) || e).slice(0, 200) };
        this._warn('saveSnapshot', e);
        return r;
      }
    }
    return this.file.saveSnapshot(runId, snapshot);
  }

  // --- Evaluations / intelligence / billing ---
  async loadEvals() {
    if (this.kind === 'postgres') {
      try {
        return await this.pg.loadEvals();
      } catch (e) {
        throw datastoreUnavailable(e, 'loadEvals');
      }
    }
    return this.file.loadEvals();
  }

  async saveEvals(list) {
    if (this.kind === 'postgres') {
      try {
        return await this.pg.saveEvals(list);
      } catch (e) {
        const r = { ok: false, error: String((e && e.message) || e).slice(0, 200) };
        this._warn('saveEvals', e);
        return r;
      }
    }
    return this.file.saveEvals(list);
  }

  async appendEvals(list) {
    if (this.kind === 'postgres') {
      try {
        return await this.pg.appendEvals(list);
      } catch (e) {
        const r = { ok: false, error: String((e && e.message) || e).slice(0, 200) };
        this._warn('appendEvals', e);
        return r;
      }
    }
    return this.file.saveEvals(list);
  }

  async loadIntelligence() {
    if (this.kind === 'postgres') {
      try {
        return await this.pg.loadIntelligence('global');
      } catch (e) {
        throw datastoreUnavailable(e, 'loadIntelligence');
      }
    }
    return this.file.loadIntelligence();
  }

  async saveIntelligence(doc) {
    if (this.kind === 'postgres') {
      try {
        return await this.pg.saveIntelligence(doc, 'global');
      } catch (e) {
        const r = { ok: false, error: String((e && e.message) || e).slice(0, 200) };
        this._warn('saveIntelligence', e);
        return r;
      }
    }
    return this.file.saveIntelligence(doc);
  }

  async saveBilling(runId, line) {
    if (this.kind === 'postgres') {
      try {
        return await this.pg.saveBilling(runId, line);
      } catch (e) {
        const r = { ok: false, error: String((e && e.message) || e).slice(0, 200) };
        this._warn('saveBilling', e);
        return r;
      }
    }
    return this.file.saveBilling(runId, line);
  }

  async loadBilling(runId) {
    if (this.kind === 'postgres') {
      try {
        return await this.pg.loadBilling(runId);
      } catch (e) {
        throw datastoreUnavailable(e, 'loadBilling');
      }
    }
    return this.file.loadBilling(runId);
  }

  // --- Audit (postgres only; file mode keeps audit in structured logs) ---
  async audit(entry) {
    if (this.kind === 'postgres' && this.pg) {
      try {
        return await this.pg.audit(entry);
      } catch (e) {
        this._warn('audit', e);
        return { ok: false, error: String((e && e.message) || e).slice(0, 200) };
      }
    }
    return { ok: true, note: 'file mode: audit via structured logs' };
  }

  // --- Retention sweep (physical files only exist in file mode) ---
  sweepRetention(opts) {
    if (this.kind === 'postgres') {
      return { deleted: [], keptActive: 0, keptIndexed: 0, keptFresh: 0, freedBytes: 0, errors: [], note: 'postgres mode: no per-run files to sweep' };
    }
    return this.file.sweepRetention(opts);
  }
}

module.exports = { RunStore };
