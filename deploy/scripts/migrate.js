#!/usr/bin/env node
// OrchestraAI runtime data migration script.
// Ensures the RUNTIME_DATA_DIR has the required structure and
// performs one-time setup without silently mutating schema on every start.
// Usage: node deploy/scripts/migrate.js
// Environment: RUNTIME_DATA_DIR (defaults to backend/.runtime-data)
//              DATA_ENCRYPTION_KEY (required in production)
//              NODE_ENV (defaults to production)
//
// File layout matches backend/src/persistence.js (FileStore):
//   runs.json          — [RunSummary...] (active + terminal history)
//   evals.json         — [Evaluation...]
//   idempotency.json   — [IdempotencyRecord...]
//   intelligence.json  — { ... } learning document
//   users.json / sessions.json / projects.json — tenant store (TenantStore)
//   <runId>.events.json / .snapshot.json / .billing.json — per-run files
//
// Corrupt files are QUARANTINED (*.corrupt-<ts>), never overwritten with
// empty data: corruption must never become "empty data".
'use strict';

const fs = require('fs');
const path = require('path');

const dataDir = process.env.RUNTIME_DATA_DIR || path.join(process.cwd(), 'backend', '.runtime-data');
const encryptionKey = process.env.DATA_ENCRYPTION_KEY;
const nodeEnv = process.env.NODE_ENV || 'production';

 // In production, the encryption key is required before any credential
 // can be stored. In development, it may be omitted (opting into
 // unencrypted credential storage for local testing only).
if (nodeEnv === 'production' && !encryptionKey) {
  console.error('ERROR: DATA_ENCRYPTION_KEY is required in production (32 random bytes as 64 hex chars or base64)');
  process.exit(1);
}

// Ensure data directory exists
if (!fs.existsSync(dataDir)) {
  try {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    console.info('Created runtime data directory:', dataDir);
  } catch (e) {
    console.error('Failed to create runtime data directory:', dataDir, e);
    process.exit(1);
  }
}

function quarantineCorrupt(file) {
  try {
    const dest = `${file}.corrupt-${Date.now()}`;
    fs.renameSync(file, dest);
    console.warn(`Quarantined corrupt file: ${file} -> ${dest} (restore from backup; refusing to start with empty data)`);
  } catch (e) {
    console.error(`Failed to quarantine corrupt file ${file}:`, e);
    process.exit(1);
  }
}

// Required files with their empty-state initial values. Missing files are
// initialized; corrupt files are quarantined (never silently reset).
const required = [
  ['runs.json', []],
  ['evals.json', []],
  ['idempotency.json', []],
  ['intelligence.json', {}],
  ['users.json', []],
  ['sessions.json', []],
  ['projects.json', []],
];

let hasChanges = false;

for (const [name, initial] of required) {
  const itemPath = path.join(dataDir, name);
  if (!fs.existsSync(itemPath)) {
    try {
      fs.writeFileSync(itemPath, JSON.stringify(initial));
      console.info('Initialized missing:', itemPath);
      hasChanges = true;
    } catch (e) {
      console.error(`Failed to initialize ${name}:`, e);
      process.exit(1);
    }
    continue;
  }
  // Verify existing files still parse; quarantine corruption.
  let raw;
  try {
    raw = fs.readFileSync(itemPath, 'utf8');
  } catch (e) {
    console.error(`Failed to read ${name}:`, e);
    process.exit(1);
  }
  if (!raw.trim()) {
    quarantineCorrupt(itemPath);
    continue;
  }
  try {
    JSON.parse(raw);
  } catch {
    quarantineCorrupt(itemPath);
  }
}

// Verify encryption key format (32 bytes = 64 hex chars or 44 base64 chars)
// Only warn in production; in development we trust the admin.
if (nodeEnv === 'production') {
  const keyPattern = /^[0-9a-fA-F]{64}$|^[A-Za-z0-9+/]{44}={0,2}$/;
  if (!keyPattern.test(encryptionKey)) {
    console.warn('WARNING: DATA_ENCRYPTION_KEY does not match expected format (64 hex chars or 44 base64 chars)');
    console.warn('Stored provider credentials may not be recoverable if the data volume is lost.');
  }
}

console.info('Migration complete. Runtime data directory:', dataDir);
console.info('Preserved existing data; no schema mutation performed.');

if (hasChanges) {
  console.info('Changes were written to the runtime data directory.');
  console.info('Ensure this directory is included in your backup procedure.');
}

process.exit(0);
