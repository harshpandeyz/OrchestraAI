'use strict';

const assert = require('assert');
const { executeBrowserTool, demoSnapshot, isDemoUrl } = require('../src/execution/browser-tool');
const { TOOL_DEFINITIONS } = require('../src/execution/tool-system');

(async () => {
  // Definitions: implemented (available), gated (disabled by default).
  const nav = TOOL_DEFINITIONS.find((d) => d.name === 'browser_navigate');
  const snap = TOOL_DEFINITIONS.find((d) => d.name === 'browser_snapshot');
  assert.ok(nav, 'browser_navigate definition exists');
  assert.ok(snap, 'browser_snapshot definition exists');
  assert.notStrictEqual(nav.description, 'Browser automation (not implemented in this runtime)');
  assert.strictEqual(nav.available !== false, true, 'navigate must be implemented');
  assert.strictEqual(snap.available !== false, true, 'snapshot must be implemented');
  assert.strictEqual(nav.disabled, true, 'navigate stays disabled-by-default (opt-in)');
  assert.strictEqual(snap.disabled, true, 'snapshot stays disabled-by-default (opt-in)');
  assert.strictEqual(nav.requiresApproval, true, 'navigate always needs approval');

  // DEMO mock session: deterministic, zero network.
  assert.strictEqual(isDemoUrl('demo:smoke'), true);
  assert.strictEqual(isDemoUrl('about:demo'), true);
  const a = await executeBrowserTool('browser_snapshot', { url: 'demo:smoke' }, { mode: 'demo', policy: { networkAccess: 'disabled' } });
  const b = await executeBrowserTool('browser_snapshot', { url: 'demo:smoke' }, { mode: 'demo', policy: { networkAccess: 'disabled' } });
  assert.deepStrictEqual(a, b, 'demo snapshots are deterministic');
  assert.strictEqual(a.engine, 'mock');
  assert.strictEqual(a.provenance, 'DEMO');
  assert.strictEqual(a.mocked, true);
  assert.ok(a.title && a.text.includes('demo:smoke'));

  // DEMO mock works even when policy disables network (no network used).
  const c = await executeBrowserTool('browser_navigate', { url: 'demo:anything' }, { mode: 'demo', policy: { networkAccess: 'disabled' } });
  assert.strictEqual(c.engine, 'mock');

  // demoSnapshot helper is deterministic too.
  assert.deepStrictEqual(demoSnapshot('demo:x'), demoSnapshot('demo:x'));

  // LIVE path routes through policy + SSRF guards (no network in tests —
  // the guard must reject before any socket opens). allowedTools opts the
  // disabled-by-default tool in so the SSRF/allowlist layer is what rejects.
  const livePolicy = { networkAccess: 'allowlist', networkAllowlist: ['example.com'], allowedTools: ['browser_snapshot', 'browser_navigate'] };
  await assert.rejects(
    executeBrowserTool('browser_snapshot', { url: 'http://127.0.0.1/admin' }, { mode: 'live', policy: livePolicy }),
    /blocked|allowlist|disabled/i,
    'loopback must be rejected without network use',
  );
  await assert.rejects(
    executeBrowserTool('browser_snapshot', { url: 'https://evil.example/page' }, { mode: 'live', policy: livePolicy }),
    /allowlist/i,
    'non-allowlisted host must be rejected',
  );
  await assert.rejects(
    executeBrowserTool('browser_snapshot', { url: '' }, { mode: 'demo', policy: { networkAccess: 'disabled' } }),
    /url is required/,
  );
  await assert.rejects(
    executeBrowserTool('browser_snapshot', { url: 'https://example.com/`rm`' }, { mode: 'demo', policy: { networkAccess: 'disabled' } }),
    /rejected characters/,
    'shell metacharacters in URLs are rejected',
  );
  // Disabled-by-default gating is visible to the policy layer.
  const { isToolAllowedByPolicy } = require('../src/execution/execution-policy');
  const gated = isToolAllowedByPolicy({ deniedTools: [], allowedTools: [], networkAccess: 'allowlist', networkAllowlist: [] }, 'browser_navigate', nav);
  assert.strictEqual(gated.allowed, false, 'browser_navigate needs explicit opt-in');

  console.log('--- Browser tool tests: passed ---');
})().catch((e) => { console.error(e); process.exit(1); });
