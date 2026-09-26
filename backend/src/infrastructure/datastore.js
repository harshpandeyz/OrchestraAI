'use strict';

// Production datastore factory. Single decision point for durable state.
//
//   kind 'file'     — explicit dev/test adapter (FileStore, atomic JSON).
//   kind 'postgres' — durable relational state (PostgresDatastore).
//
// Rules:
//   - 'auto' resolves to postgres iff DATABASE_URL is set, else file.
//   - postgres requested without DATABASE_URL (or without `pg`) throws an
//     operational error. It NEVER silently falls back to JSON.
//   - postgres reachable-but-failing at query time surfaces { ok:false }
//     per operation or throws for transactions; callers must surface that
//     to readiness instead of swapping adapters mid-flight.

const { resolvedDatastoreKind } = require('../config');

function createDatastore(config, { fileStore = null, logger = null } = {}) {
  const kind = resolvedDatastoreKind(config);
  if (kind === 'postgres') {
    if (!config.databaseUrl) {
      const err = new Error('postgres datastore selected but DATABASE_URL is empty; refusing to fall back to file storage');
      err.code = 'datastore_misconfigured';
      throw err;
    }
    // Lazy require so demo/test processes without `pg` still boot on file.
    // eslint-disable-next-line global-require
    const { PostgresDatastore } = require('./postgres');
    const pg = new PostgresDatastore({
      connectionString: config.databaseUrl,
      ssl: !!config.dbSsl,
      poolMax: config.dbPoolMax || 10,
      statementTimeoutMs: config.dbStatementTimeoutMs || 10000,
      logger,
    });
    return { kind: 'postgres', store: pg, pg };
  }
  if (!fileStore) {
    const err = new Error('file datastore selected but no FileStore instance was provided');
    err.code = 'datastore_misconfigured';
    throw err;
  }
  return { kind: 'file', store: fileStore, pg: null };
}

module.exports = { createDatastore };
