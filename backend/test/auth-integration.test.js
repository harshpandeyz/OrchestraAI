'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-auth-api-'));
process.env.NODE_ENV = 'production';
process.env.RUNTIME_MODE = 'demo';
process.env.RUNTIME_DATA_DIR = dataDir;
process.env.DATA_ENCRYPTION_KEY = 'a'.repeat(64);
process.env.DISCOVERY_ENABLED = 'false';
process.env.LOG_LEVEL = 'error';

const { server, shutdown } = require('../server');

function request(base, method, pathname, body, cookie = '') {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(`${base}${pathname}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}), ...(cookie ? { Cookie: cookie } : {}) },
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

async function main() {
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const anonymousRuns = await request(base, 'GET', '/api/runs');
    assert.strictEqual(anonymousRuns.status, 401, 'production run listing must require auth');
    const anonymousProviders = await request(base, 'GET', '/api/providers');
    assert.strictEqual(anonymousProviders.status, 401, 'provider metadata must require auth in production');
    const anonymousModels = await request(base, 'GET', '/api/models');
    assert.strictEqual(anonymousModels.status, 401, 'model catalog must require auth in production');
    const anonymousTools = await request(base, 'GET', '/api/tools');
    assert.strictEqual(anonymousTools.status, 401, 'tool catalog must require auth in production');

    const alice = await request(base, 'POST', '/api/auth/signup', { email: 'alice@api.test', password: 'alice secure password 123', name: 'Alice' });
    assert.strictEqual(alice.status, 201);
    assert.ok(alice.cookie.includes('oa_session='));
    const aliceProjects = await request(base, 'GET', '/api/projects', null, alice.cookie);
    assert.strictEqual(aliceProjects.status, 200);
    const projectId = aliceProjects.json.projects[0].id;
    const created = await request(base, 'POST', '/api/runs', { title: 'Alice private run', taskMode: 'general', projectId }, alice.cookie);
    assert.strictEqual(created.status, 201);

    const bob = await request(base, 'POST', '/api/auth/signup', { email: 'bob@api.test', password: 'bob secure password 123', name: 'Bob' });
    assert.strictEqual(bob.status, 201);
    const crossTenant = await request(base, 'GET', `/api/runs/${created.json.run.id}`, null, bob.cookie);
    assert.strictEqual(crossTenant.status, 403, 'run detail must not cross tenant boundary');
    const crossProject = await request(base, 'GET', `/api/projects/${projectId}`, null, bob.cookie);
    assert.strictEqual(crossProject.status, 404, 'project detail must not cross tenant boundary');
    console.log('✓ production auth, sessions, and tenant isolation');
  } finally {
    await shutdown('auth-test');
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
