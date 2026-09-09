#!/usr/bin/env node
// Container entrypoint: migrate, then exec the API server.
//
//   1. File layout migration (deploy/scripts/migrate.js): initializes and
//      verifies RUNTIME_DATA_DIR, quarantines corruption, requires
//      DATA_ENCRYPTION_KEY in production. Exits non-zero on misconfiguration.
//   2. Postgres migrations (backend/migrations/*.sql) when the postgres
//      datastore is selected (DATASTORE_PROVIDER=postgres, or auto with
//      DATABASE_URL): applies pending migrations in filename order using the
//      schema_migrations table. Idempotent (IF NOT EXISTS + version insert
//      ON CONFLICT DO NOTHING inside the SQL files). Any failure is fatal —
//      the server NEVER boots against an unmigrated database.
//   3. Spawns `node backend/server.js` with stdio inherited (PID 1 signal
//      handling stays with node; SIGTERM/SIGINT drain via server.js).
'use strict';

const { spawnSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const APP_ROOT = '/app';
const MIGRATIONS_DIR = path.join(APP_ROOT, 'backend', 'migrations');

function datastoreKind() {
  const explicit = String(process.env.DATASTORE_PROVIDER || 'auto').toLowerCase();
  if (explicit === 'postgres') return 'postgres';
  if (explicit === 'file') return 'file';
  return process.env.DATABASE_URL ? 'postgres' : 'file';
}

function step(name, file, args = []) {
  const r = spawnSync(process.execPath, [file, ...args], { stdio: 'inherit' });
  if (r.error || r.status !== 0) {
    console.error(`entrypoint: ${name} failed (exit ${r.status}); refusing to start`);
    process.exit(r.status || 1);
  }
}

// 1. File layout (also enforces DATA_ENCRYPTION_KEY in production).
step('file migration', path.join(APP_ROOT, 'deploy', 'scripts', 'migrate.js'));

// 2. Postgres schema migrations when postgres is authoritative.
if (datastoreKind() === 'postgres') {
  const url = process.env.DATABASE_URL || '';
  if (!url) {
    console.error('entrypoint: postgres datastore selected but DATABASE_URL is empty; refusing to start');
    process.exit(1);
  }
  let files;
  try {
    files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  } catch (e) {
    console.error(`entrypoint: cannot list migrations in ${MIGRATIONS_DIR}: ${e.message}`);
    process.exit(1);
  }
  if (!files.length) {
    console.error(`entrypoint: no migrations found in ${MIGRATIONS_DIR}; refusing to start without schema`);
    process.exit(1);
  }
  let pg;
  try {
    // eslint-disable-next-line global-require
    pg = require('/app/node_modules/pg');
  } catch (e) {
    console.error('entrypoint: postgres selected but the "pg" module is not installed; refusing to start');
    process.exit(1);
  }
  (async () => {
    const client = new pg.Client({ connectionString: url });
    try {
      await client.connect();
    } catch (e) {
      console.error(`entrypoint: cannot reach Postgres: ${String((e && e.message) || e).slice(0, 200)}; refusing to start`);
      process.exit(1);
    }
    try {
      for (const f of files) {
        const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
        await client.query(sql);
        console.info(`entrypoint: applied migration ${f}`);
      }
    } catch (e) {
      console.error(`entrypoint: migration failed: ${String((e && e.message) || e).slice(0, 300)}; refusing to start`);
      process.exit(1);
    } finally {
      try { await client.end(); } catch {}
    }
    boot();
  })().catch((e) => {
    console.error(`entrypoint: migration failed: ${String((e && e.message) || e).slice(0, 200)}; refusing to start`);
    process.exit(1);
  });
} else {
  boot();
}

// 3. Start the server as the container's foreground process. Signals are
//    forwarded to the child so SIGTERM/SIGINT reach server.js's graceful
//    shutdown (drain in-flight runs, flush durable state, close SSE/Redis/Postgres).
function boot() {
  const child = spawn(process.execPath, [path.join(APP_ROOT, 'backend', 'server.js')], { stdio: 'inherit' });
  // Forward termination signals to the server process. Without this the
  // entrypoint (PID 1) absorbs SIGTERM and the server never drains, so Docker
  // would SIGKILL the container after the stop grace period.
  const forward = (sig) => () => { try { child.kill(sig); } catch {} };
  process.on('SIGTERM', forward('SIGTERM'));
  process.on('SIGINT', forward('SIGINT'));
  child.on('exit', (code, signal) => {
    if (signal) process.exit(128 + (signal === 'SIGTERM' ? 15 : signal === 'SIGINT' ? 2 : 1));
    process.exit(code === null ? 1 : code);
  });
}
