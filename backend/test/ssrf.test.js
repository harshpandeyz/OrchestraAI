'use strict';

// P0-B regression tests: DNS-aware SSRF protection.
//
// Gates under test:
//   shape: scheme, credentials, literal-IP ranges, hostname blocklists,
//          disabled/allowlist policy modes
//   dns:   EVERY resolved address must be public (rebinding-proof by policy)
//   hops:  each redirect hop independently validated; transport chosen from
//          the CURRENT hop; redirect/time/size budgets enforced
//
// No external network: DNS and HTTP transports are stubbed. The guard logic
// under test is the production code path.
//
// Run: node backend/test/ssrf.test.js

process.env.RUNTIME_MODE = 'demo';
process.env.LOG_LEVEL = 'error';

const assert = require('assert');
const { Readable } = require('stream');

const Env = require('../src/execution/environment');
const { NetworkMode } = require('../src/execution/execution-policy');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`✗ ${name}: ${e && e.stack ? String(e.stack).split('\n').slice(0, 4).join(' | ') : (e && e.message)}`);
    failed++;
  }
}

const ENABLED = { networkAccess: NetworkMode.ENABLED };
const ALLOW_EXAMPLE = { networkAccess: NetworkMode.ALLOWLIST, networkAllowlist: ['example.com', 'public.example', 'redirector.example'] };
const DISABLED = { networkAccess: NetworkMode.DISABLED };

async function expectDenied(promise, label) {
  let err = null;
  try { await promise; } catch (e) { err = e; }
  assert.ok(err, `expected denial: ${label}`);
  assert.ok(['denied', 'bad_params'].includes(err.code), `expected denied/bad_params, got ${err.code} (${label})`);
  return err;
}

function bodyStream(chunks) {
  return Readable.from(chunks.map((c) => Buffer.from(c)));
}
function neverStream() {
  return new Readable({ read() {} });
}

// DNS stub: fully controlled resolution.
const DNS_TABLE = {
  'public.example': [{ address: '93.184.216.34', family: 4 }],
  'redirector.example': [{ address: '93.184.216.34', family: 4 }],
  'evil-private.example': [{ address: '10.1.2.3', family: 4 }],
  'mixed.example': [{ address: '93.184.216.34', family: 4 }, { address: '192.168.1.9', family: 4 }],
  'v6private.example': [{ address: 'fc00::1', family: 6 }],
  'mapped.example': [{ address: '::ffff:127.0.0.1', family: 6 }],
};
function installDns() {
  Env.setDnsResolver(async (host) => {
    const h = String(host).toLowerCase();
    if (h === 'unresolvable.example') {
      const e = new Error(`getaddrinfo ENOTFOUND ${host}`);
      e.code = 'ENOTFOUND';
      throw e;
    }
    if (DNS_TABLE[h]) return DNS_TABLE[h];
    // Unknown test hosts resolve to a documentation-free public address.
    return [{ address: '93.184.216.35', family: 4 }];
  });
}

async function main() {
  // ---------- IP range unit tests ----------
  await test('blocked IPv4 ranges are rejected, public passes', () => {
    for (const ip of ['127.0.0.1', '127.9.9.9', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.0.1',
      '169.254.169.254', '169.254.10.20', '224.0.0.1', '0.0.0.0', '255.255.255.255', '240.0.0.1',
      '100.64.0.1', '192.0.2.1', '198.51.100.7', '203.0.113.9']) {
      assert.ok(Env.blockedIpReason(ip), `${ip} must be blocked`);
    }
    // 172.32.0.1 is NOT in 172.16/12.
    assert.strictEqual(Env.blockedIpReason('172.32.0.1'), null, '172.32.0.1 is public');
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34']) {
      assert.strictEqual(Env.blockedIpReason(ip), null, `${ip} is public`);
    }
  });

  await test('blocked IPv6 ranges are rejected, public passes', () => {
    for (const ip of ['::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1',
      '2001:db8::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '2002::1', '64:ff9b::808:808']) {
      assert.ok(Env.blockedIpReason(ip), `${ip} must be blocked`);
    }
    assert.strictEqual(Env.blockedIpReason('2001:4860:4860::8888'), null, 'public v6 passes');
  });

  // ---------- shape gate ----------
  await test('shape gate blocks literals, credentials, schemes', () => {
    for (const u of ['http://localhost/x', 'http://127.0.0.1/', 'http://[::1]/', 'http://0.0.0.0/',
      'http://10.0.0.5/', 'http://192.168.1.1/', 'http://172.16.4.4/', 'http://169.254.169.254/',
      'http://224.0.0.1/', 'http://[fc00::1]/', 'http://[fe80::1]/',
      'http://metadata.google.internal/', 'http://foo.local/', 'http://x.internal/',
      'ftp://public.example/x', 'file:///etc/passwd', 'not-a-url',
      'https://user:pass@public.example/', 'http://[::ffff:127.0.0.1]/']) {
      assert.throws(() => Env.parseAndGuardUrl(u, ENABLED), null, u);
    }
    assert.ok(Env.parseAndGuardUrl('https://public.example/page', ENABLED));
  });

  await test('disabled networking denies everything; allowlist enforced', async () => {
    await expectDenied(Promise.resolve().then(() => Env.parseAndGuardUrl('https://public.example/', DISABLED)), 'disabled');
    assert.ok(Env.parseAndGuardUrl('https://public.example/page', ALLOW_EXAMPLE));
    assert.throws(() => Env.parseAndGuardUrl('https://evil.example/', ALLOW_EXAMPLE), null, 'non-allowlisted');
  });

  // ---------- DNS gate ----------
  installDns();
  try {
    await test('public hostname passes DNS gate', async () => {
      const addrs = await Env.resolveAndGuardHost('public.example');
      assert.deepStrictEqual(addrs, ['93.184.216.34']);
    });

    await test('hostname resolving to private IP is rejected', async () => {
      await expectDenied(Env.resolveAndGuardHost('evil-private.example'), 'private DNS');
      await expectDenied(Env.fetchUrlGuarded('https://evil-private.example/', { policy: ENABLED }), 'fetch to private DNS');
    });

    await test('hostname with one private address among public is rejected', async () => {
      await expectDenied(Env.resolveAndGuardHost('mixed.example'), 'mixed DNS');
    });

    await test('private IPv6 and mapped-IPv4 DNS answers are rejected', async () => {
      await expectDenied(Env.resolveAndGuardHost('v6private.example'), 'ula DNS');
      await expectDenied(Env.resolveAndGuardHost('mapped.example'), 'mapped loopback DNS');
    });

    await test('unresolvable host fails closed', async () => {
      await expectDenied(Env.fetchUrlGuarded('https://unresolvable.example/', { policy: ENABLED }), 'NXDOMAIN');
    });

    await test('disabled networking denies before DNS', async () => {
      await expectDenied(Env.fetchUrlGuarded('https://public.example/', { policy: DISABLED }), 'disabled fetch');
    });

    await test('non-allowlisted host denied even when DNS is public', async () => {
      await expectDenied(Env.fetchUrlGuarded('https://public.example/', { policy: { networkAccess: NetworkMode.ALLOWLIST, networkAllowlist: ['other.example'] } }), 'allowlist');
    });

    // ---------- redirect hops (stubbed transport, real guards) ----------
    await test('redirect to private target is rejected', async () => {
      Env.setFetchTransport(async (url) => {
        if (url.pathname === '/start') {
          return { statusCode: 302, headers: { location: 'https://127.0.0.1/secret' }, stream: bodyStream([]) };
        }
        throw new Error('must not fetch private target');
      });
      const err = await expectDenied(
        Env.fetchUrlGuarded('https://redirector.example/start', { policy: ALLOW_EXAMPLE }), 'redirect-to-private');
      assert.match(err.message, /127\.0\.0\.1|blocked/i);
    });

    await test('redirect from HTTP to HTTPS works; transport follows current hop', async () => {
      const seen = [];
      Env.setFetchTransport(async (url) => {
        seen.push(`${url.protocol}//${url.hostname}${url.pathname}`);
        if (url.pathname === '/a') {
          return { statusCode: 302, headers: { location: 'https://public.example/b' }, stream: bodyStream([]) };
        }
        return { statusCode: 200, headers: {}, stream: bodyStream(['ok']) };
      });
      const r = await Env.fetchUrlGuarded('http://redirector.example/a', { policy: ENABLED });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body, 'ok');
      assert.deepStrictEqual(seen, ['http://redirector.example/a', 'https://public.example/b']);
    });

    await test('redirect from HTTPS to HTTP is refused under restricted policy', async () => {
      Env.setFetchTransport(async (url) => {
        if (url.pathname === '/s') {
          return { statusCode: 302, headers: { location: 'http://public.example/plain' }, stream: bodyStream([]) };
        }
        throw new Error('downgrade must not be fetched');
      });
      await expectDenied(Env.fetchUrlGuarded('https://redirector.example/s', { policy: ALLOW_EXAMPLE }), 'scheme downgrade');
    });

    await test('excessive redirects are bounded', async () => {
      Env.setFetchTransport(async () => ({ statusCode: 302, headers: { location: '/loop' }, stream: bodyStream([]) }));
      let err = null;
      try {
        await Env.fetchUrlGuarded('https://redirector.example/loop', { policy: ALLOW_EXAMPLE, maxRedirects: 2 });
      } catch (e) { err = e; }
      assert.ok(err, 'expected redirect_limit');
      assert.strictEqual(err.code, 'redirect_limit');
    });

    await test('oversized body is rejected, not silently truncated', async () => {
      Env.setFetchTransport(async () => ({ statusCode: 200, headers: {}, stream: bodyStream(['a'.repeat(100), 'b'.repeat(100)]) }));
      let err = null;
      try {
        await Env.fetchUrlGuarded('https://public.example/big', { policy: ALLOW_EXAMPLE, maxBytes: 100 });
      } catch (e) { err = e; }
      assert.ok(err, 'expected oversized');
      assert.strictEqual(err.code, 'oversized');
    });

    await test('small body within limit succeeds with byte accounting', async () => {
      Env.setFetchTransport(async () => ({ statusCode: 200, headers: {}, stream: bodyStream(['hello']) }));
      const r = await Env.fetchUrlGuarded('https://public.example/small', { policy: ALLOW_EXAMPLE, maxBytes: 100 });
      assert.strictEqual(r.body, 'hello');
      assert.strictEqual(r.bytes, 5);
    });

    await test('hung response maps to timeout', async () => {
      Env.setFetchTransport(async () => ({ statusCode: 200, headers: {}, stream: neverStream() }));
      let err = null;
      try {
        await Env.fetchUrlGuarded('https://public.example/hang', { policy: ALLOW_EXAMPLE, timeoutMs: 60 });
      } catch (e) { err = e; }
      assert.ok(err, 'expected timeout');
      assert.strictEqual(err.code, 'timeout');
    });
  } finally {
    Env.setDnsResolver(null);
    Env.setFetchTransport(null);
  }

  // ---------- command hardening ----------
  await test('command parser rejects code-execution and escape attempts', async () => {
    const ws = process.cwd();
    for (const cmd of ['python -c "import os"', 'node -e "1"', 'node --eval x.js',
      'npm test -- --prefix /tmp', 'pytest --rootdir=/etc -q', 'go test --exec /bin/sh ./...',
      'node ../../etc/passwd', 'node /etc/passwd', 'pytest a;b', 'pytest a|b', 'pytest FOO=bar',
      'cargo test x; rm -rf /']) {
      let threw = false;
      try { Env.parseTestCommandString(cmd, ws); } catch (e) { threw = true; }
      assert.ok(threw, `must reject: ${cmd}`);
    }
    assert.ok(Env.parseTestCommandString('node backend/test/fixture-pass.js', ws));
    assert.ok(Env.parseTestCommandString('npm test', ws));
    assert.ok(Env.parseTestCommandString('pytest -q', ws));
  });
  await test('adversarial URL encoding tricks are blocked', () => {
    for (const u of [
      'https://%2e%2e.public.example/x',     // double-dot encoding
      'https://public.example/%2e%2e/secret', // double-dot in path
      'https://public.example/%2fsecret',     // encoded slash
      'https://public.example/%2e%2e%2e/secret', // triple-dot
      'https://public.example/..%2fsecret',   // dot-slash encoding
      'https://public.example/..;/secret',    // semicolon in path
      'https://public.example/\@secret',      // encoded @
      'https://public.example/%252e%252e%252fsecret', // double-encoded
    ]) {
      assert.throws(() => Env.parseAndGuardUrl(u, ENABLED), null, u);
    }
    assert.ok(Env.parseAndGuardUrl('https://public.example/page', ENABLED));
  });

  await test('adversarial IPv6 formatting rejections', () => {
    for (const ip of [
      'http://[::192.168.1.1]/',    // IPv4-mapped in IPv6
      'http://[::ffff:127.0.0.1]/', // IPv4-mapped loopback
      'http://[fe80::1]/',          // link-local IPv6
      'http://[fc00::1]/',          // unique-local IPv6
    ]) {
      assert.throws(() => Env.parseAndGuardUrl(ip, ENABLED), null, ip);
    }
  });
}

main().then(() => {
  console.log(`\n--- SSRF results: ${passed} passed, ${failed} failed ---`);
  process.exit(failed ? 1 : 0);
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
