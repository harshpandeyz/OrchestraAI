'use strict';

// Session-cookie security regression suite.
//
// Guards the production session model:
//   - the credential is an HttpOnly/SameSite cookie (JavaScript cannot read it)
//   - login issues a cookie and /me authenticates via it
//   - logout invalidates the session server-side
//   - expired sessions fail closed
//   - cross-tenant run access fails
//   - cross-origin state changes fail the CSRF origin check
//
// Run: node backend/test/auth-session-security.test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-session-sec-'));
process.env.NODE_ENV = 'production';
process.env.RUNTIME_MODE = 'demo';
process.env.RUNTIME_DATA_DIR = dataDir;
process.env.DATA_ENCRYPTION_KEY = 'a'.repeat(64);
process.env.FRONTEND_ORIGIN = 'https://console.example.com';
process.env.DISCOVERY_ENABLED = 'false';
process.env.LOG_LEVEL = 'error';

const auth = require('../src/auth');
const { TenantStore } = require('../src/tenant-store');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`✗ ${name}: ${e && e.message}`);
    failed++;
  }
}

async function main() {
  // ---- Pure helpers: cookie posture + reading (no server needed) ----
  await test('session cookie is HttpOnly/SameSite and Secure in production', () => {
    const c = auth.buildSessionCookie('abc123', { secure: true });
    assert.ok(c.startsWith('oa_session=abc123; '), `cookie name/value: ${c}`);
    assert.ok(c.includes('HttpOnly'), 'HttpOnly attribute required');
    assert.ok(c.includes('SameSite=Lax'), 'SameSite=Lax required');
    assert.ok(c.includes('Path=/'), 'Path=/ required');
    assert.ok(c.includes('Secure'), 'Secure required when secure=true');
    // No bearer token is produced: the credential lives only in the cookie.
    assert.ok(!/Bearer/i.test(c));
  });

  await test('session cookie is NOT Secure in development (plain-HTTP localhost)', () => {
    const c = auth.buildSessionCookie('abc123', { secure: false });
    assert.ok(!c.includes('Secure'), 'dev cookie must not force Secure over http');
    assert.ok(c.includes('HttpOnly'), 'HttpOnly still required in dev');
  });

  await test('readSessionCookie decodes the opaque token invariantly', () => {
    assert.strictEqual(auth.readSessionCookie({ cookie: 'a=1; oa_session=opaque%2Btoken; b=2' }), 'opaque+token');
    assert.strictEqual(auth.readSessionCookie({}), '');
    assert.strictEqual(auth.readSessionCookie({ cookie: 'other=1' }), '');
  });

  await test('clearSessionCookie expires the cookie (logout invalidation)', () => {
    const c = auth.clearSessionCookie();
    assert.ok(c.startsWith('oa_session=;'), `clear value: ${c}`);
    assert.ok(c.includes('Max-Age=0'), 'Max-Age=0 required so the browser drops it');
    assert.ok(c.includes('HttpOnly'), 'HttpOnly required');
  });

  // ---- TenantStore: expired sessions fail closed ----
  await test('expired sessions fail closed (userForSession returns null)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-expire-'));
    const store = new TenantStore(dir);
    store.signup({ email: 'e@exp.test', password: 'a strong password 123' });
    const { token } = store.login({ email: 'e@exp.test', password: 'a strong password 123' });
    assert.ok(store.userForSession(token), 'fresh session resolves');
    // Force expiry server-side (simulates an old session record).
    const rec = store.sessions.find((s) => s.userId === store.users[0].id);
    rec.expiresAt = new Date(Date.now() - 1000).toISOString();
    store.persist(store.sessionsFile, store.sessions);
    assert.strictEqual(store.userForSession(token), null, 'expired session must not authenticate');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ---- Integration over the live server ----
  const { server, shutdown } = require('../server');
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  function request(method, pathname, body, { cookie = '', origin = '' } = {}) {
    return new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : null;
      const req = http.request(`${base}${pathname}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
          ...(origin ? { Origin: origin } : {}),
        },
      }, (res) => {
        let text = '';
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => { let json = null; try { json = text ? JSON.parse(text) : null; } catch {} resolve({ status: res.statusCode, json, cookie: res.headers['set-cookie']?.[0] || '' }); });
      });
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  }

  try {
    await test('login issues an HttpOnly cookie and /me authenticates via it', async () => {
      const res = await request('POST', '/api/auth/signup', { email: 's@sec.test', password: 'a secure password 123', name: 'S' });
      assert.strictEqual(res.status, 201, JSON.stringify(res.json));
      assert.ok(res.cookie.includes('oa_session='), `signup must set the session cookie: ${res.cookie}`);
      assert.ok(res.cookie.includes('HttpOnly'), 'HttpOnly required');
      assert.ok(res.cookie.includes('SameSite=Lax'), 'SameSite=Lax required');
      const me = await request('GET', '/api/auth/me', null, { cookie: res.cookie });
      assert.strictEqual(me.status, 200);
      assert.strictEqual(me.json.authenticated, true, 'cookie authenticates /me');
      assert.ok(me.json.principal && !/token|password|secret/i.test(JSON.stringify(me.json.principal)), 'principal must not echo any credential');
    });

    await test('logout invalidates the session server-side', async () => {
      const login = await request('POST', '/api/auth/login', { email: 's@sec.test', password: 'a secure password 123' });
      assert.strictEqual(login.status, 200);
      const cookie = login.cookie;
      const before = await request('GET', '/api/auth/me', null, { cookie });
      assert.strictEqual(before.json.authenticated, true);
      const logout = await request('POST', '/api/auth/logout', null, { cookie });
      assert.strictEqual(logout.status, 200);
      // Even replaying the revoked token must not authenticate.
      const after = await request('GET', '/api/auth/me', null, { cookie });
      assert.strictEqual(after.json.authenticated, false, 'revoked session must not authenticate');
    });

    await test('unauthenticated production requests fail (bearer absent)', async () => {
      const res = await request('GET', '/api/runs');
      assert.strictEqual(res.status, 401, 'must be 401 without any credential');
    });

    await test('cross-tenant run access fails', async () => {
      const a = await request('POST', '/api/auth/signup', { email: 'a@sec.test', password: 'a secure password 123', name: 'A' });
      const proj = await request('GET', '/api/projects', null, { cookie: a.cookie });
      const pid = proj.json.projects[0].id;
      const run = await request('POST', '/api/runs', { title: 'A run', taskMode: 'general', projectId: pid }, { cookie: a.cookie });
      const b = await request('POST', '/api/auth/signup', { email: 'b@sec.test', password: 'b secure password 123', name: 'B' });
      const cross = await request('GET', `/api/runs/${run.json.run.id}`, null, { cookie: b.cookie });
      assert.strictEqual(cross.status, 403, 'tenant B must not read tenant A run');
    });

    await test('cross-origin state change with a session cookie is rejected (CSRF)', async () => {
      const login = await request('POST', '/api/auth/login', { email: 'a@sec.test', password: 'a secure password 123' });
      const evil = await request(
        'POST',
        '/api/runs',
        { title: 'csrf', taskMode: 'general' },
        { cookie: login.cookie, origin: 'https://evil.example' },
      );
      assert.strictEqual(evil.status, 403, 'disallowed origin must fail the origin check');
      assert.strictEqual(evil.json.code, 'csrf_origin_denied');
    });
  } finally {
    await shutdown('session-security-test');
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  console.log(`\n--- Auth session security results: ${passed} passed, ${failed} failed ---`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });