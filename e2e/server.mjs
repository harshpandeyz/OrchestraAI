// E2E server bootstrap.
//
// Boots the real backend in production demo mode (auth fails closed) on a
// throwaway data directory, serving the freshly-built console from the same
// origin (one port: UI + API). Playwright treats this as its webServer and
// waits on /api/health.
//
// This is intentionally NOT a mock: the browser suite exercises the actual
// product loop and tenant/auth boundaries.

import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.E2E_PORT || 8791);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-e2e-'));

// Always build a fresh console from the CURRENT source. Sessions 1–4 modify
// the frontend in parallel; a stale dist would make browser tests assert
// against an outdated UI. If the build fails (e.g. a transient type error),
// the E2E suite fails truthfully rather than testing stale output.
execSync('npm run build:frontend', { cwd: root, stdio: 'inherit' });

process.env.NODE_ENV = 'production';
process.env.RUNTIME_MODE = 'demo';
process.env.RUNTIME_DATA_DIR = dataDir;
process.env.DATA_ENCRYPTION_KEY = 'a'.repeat(64);
process.env.DISCOVERY_ENABLED = 'false';
process.env.LOG_LEVEL = 'warn';
process.env.FRONTEND_ORIGIN = `http://127.0.0.1:${port}`;
// Test-environment configuration (NOT a product weakening): the browser suite
// intentionally creates dozens of accounts in parallel, so the request
// rate-limit ceiling is raised here. The product default (12 auth/min) is
// unchanged and is exercised by backend tests, not the browser suite.
process.env.LIMIT_AUTH_REQUESTS_PER_MINUTE = '10000';
process.env.LIMIT_REQUESTS_PER_MINUTE = '60000';

const require = createRequire(import.meta.url);
const { server, shutdown } = require(path.join(root, 'backend', 'server.js'));

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, '127.0.0.1', resolve);
});

console.log(`[e2e] backend listening on http://127.0.0.1:${port} (production demo mode, auth fail-closed)`);

let closing = false;
async function stop() {
  if (closing) return;
  closing = true;
  try { await shutdown('e2e'); } catch {}
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  process.exit(0);
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);