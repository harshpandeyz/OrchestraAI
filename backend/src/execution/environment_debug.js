'use strict';

// Session 3 — Environment inspection, project detection, safe commands,
// network fetch with SSRF guards, artifacts, and secret redaction.
//
// Safety rules:
// - Never dump full environment variables; only a curated non-secret subset.
// - No secrets in outputs, artifacts, or events (redaction layer).
// - No shell: child processes spawn via execFile with argv arrays only.
//   execFile() is a command restriction, NOT a sandbox: local execution is
//   for safe development/test operations only. Production execution of
//   customer/untrusted code must go through the isolated executor
//   (see ./isolated-executor.js) and fails closed without one.
// - Customer-code children receive a sanitized minimal environment (see
//   ./sandbox-env.js), never the application process environment wholesale.
// - Network: URL validation, private-range/SSRF blocking, size/time limits,
//   safe redirect handling, no credential leakage.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { NetworkMode } = require('./execution-policy');
const { resolveWorkspaceRoot, sandboxPath } = require('./changesets');

// --- Secret redaction (persisted action history must never hold raw secrets) ---

const SECRET_KEY_RE = /(api[_-]?key|secret|token|password|passwd|bearer|authorization|private[_-]?key|client[_-]?secret)/i;
const URL_CREDS_RE = /(\b[a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+)(:([^/\s@]*))?@/gi;

function redactSecrets(value, depth = 0) {
  if (depth > 6) return '[REDACTED]';
  if (typeof value === 'string') {
    let out = value.replace(URL_CREDS_RE, '$1[REDACTED]@');
    out = out.replace(/(Bearer\s+)[^\s"']+/gi, '$1[REDACTED]');
    // Long hex/base64-looking tokens often are keys; redact obvious ones.
    out = out.replace(/\b(sk-[A-Za-z0-9_-]{8,}|xox[bpas]-[A-Za-z0-9-]{6,}|gh[pousr]_[A-Za-z0-9]{10,})\b/g, '[REDACTED]');
    return out.slice(0, 8000);
  }
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => redactSecrets(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value).slice(0, 100)) {
      out[k] = SECRET_KEY_RE.test(k) ? '[REDACTED]' : redactSecrets(v, depth + 1);
    }
    return out;
  }
  return value;
}

function summarizeInputs(params) {
  const redacted = redactSecrets(params || {});
  const text = JSON.stringify(redacted);
  return text.length > 1000 ? `${text.slice(0, 1000)}…(truncated)` : text;
}

// --- Environment profile ---

const SAFE_ENV_KEYS = ['PATH', 'NODE_ENV', 'CI', 'TERM', 'LANG', 'SHELL'];

async function commandExists(bin) {
  return new Promise((resolve) => {
    execFile(bin, ['--version'], { timeout: 5000, windowsHide: true }, (err) => resolve(!err));
  });
}

async function detectProject(workspace) {
  const ws = resolveWorkspaceRoot(workspace);
  const exists = async (rel) => {
    try { await fs.promises.access(path.join(ws, rel)); return true; } catch { return false; }
  };
  const projectTypes = [];
  const detectedCommands = [];
  let packageManager = null;
  const languages = [];
  const frameworks = [];
  let testCommand = null;
  let buildCommand = null;

  if (await exists('package.json')) {
    projectTypes.push('node');
    languages.push('javascript');
    let pkg = {};
    try { pkg = JSON.parse(await fs.promises.readFile(path.join(ws, 'package.json'), 'utf8')); } catch {}
    if (await exists('pnpm-lock.yaml')) packageManager = 'pnpm';
    else if (await exists('yarn.lock')) packageManager = 'yarn';
    else if (await exists('package-lock.json')) packageManager = 'npm';
    else packageManager = 'npm';
    const scripts = (pkg && pkg.scripts) || {};
    if (scripts.test) testCommand = packageManager === 'npm' ? 'npm test' : `${packageManager} test`;
    else testCommand = null;
    if (scripts.build) buildCommand = packageManager === 'npm' ? 'npm run build' : `${packageManager} run build`;
    if (scripts.lint) detectedCommands.push(packageManager === 'npm' ? 'npm run lint' : `${packageManager} run lint`);
    if (testCommand) detectedCommands.unshift(testCommand);
    if (buildCommand) detectedCommands.push(buildCommand);
    const deps = { ...((pkg && pkg.dependencies) || {}), ...((pkg && pkg.devDependencies) || {}) };
    if (deps.react || deps.next) frameworks.push('react');
    if (deps.vue) frameworks.push('vue');
    if (deps.express || deps.fastify || deps.koa) frameworks.push('node-server');
  }
  if (await exists('pyproject.toml') || await exists('requirements.txt') || await exists('setup.py')) {
    projectTypes.push('python');
    languages.push('python');
    packageManager = packageManager || 'pip';
    testCommand = testCommand || 'pytest';
    detectedCommands.push('pytest');
  }
  if (await exists('Cargo.toml')) {
    projectTypes.push('rust'); languages.push('rust');
    testCommand = testCommand || 'cargo test';
    detectedCommands.push('cargo test');
  }
  if (await exists('go.mod')) {
    projectTypes.push('go'); languages.push('go');
    testCommand = testCommand || 'go test ./...';
    detectedCommands.push('go test ./...');
  }
  if (await exists('pom.xml')) { projectTypes.push('java-maven'); languages.push('java'); }
  if (await exists('build.gradle') || await exists('build.gradle.kts')) { projectTypes.push('java-gradle'); languages.push('java'); }
  if (await exists('Dockerfile')) projectTypes.push('docker');
  if (await exists('docker-compose.yml') || await exists('docker-compose.yaml')) projectTypes.push('docker-compose');

  let git = { present: false, branch: null, clean: null };
  try {
    await fs.promises.access(path.join(ws, '.git'));
    git.present = true;
  } catch { /* no .git */ }

  return { projectTypes, packageManager, languages, frameworks, testCommand, buildCommand, detectedCommands, git };
}

async function environmentProfile(workspace) {
  const runtimes = [];
  for (const bin of ['node', 'npm', 'python3', 'go', 'cargo', 'git']) {
    // Sequential is fine (6 quick probes); each is timeout-guarded.
    // eslint-disable-next-line no-await-in-loop
    const ok = await commandExists(bin);
    if (ok) runtimes.push({ name: bin, available: true });
  }
  const project = await detectProject(workspace);
  const safeEnv = {};
  for (const k of SAFE_ENV_KEYS) {
    if (process.env[k] !== undefined) safeEnv[k] = String(process.env[k]).slice(0, 500);
  }
  return {
    os: os.platform(),
    architecture: os.arch(),
    nodeVersion: process.version,
    runtimes,
    packageManager: project.packageManager,
    languages: project.languages,
    frameworks: project.frameworks,
    projectType: project.projectTypes,
    git: project.git,
    detectedCommands: project.detectedCommands,
    testCommand: project.testCommand,
    buildCommand: project.buildCommand,
    env: safeEnv, // curated subset only — never full process.env
  };
}

// --- Safe command execution (allowlisted development commands only) ---

function parseTestCommandString(raw, workspace) {
  // Accepts the TOOL_RUN_TESTS_CMD-style string or a detected command, and
  // converts it to an argv array WITHOUT a shell. Model input beyond `suite`
  // selection is never interpolated.
  const parts = String(raw || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) throw Object.assign(new Error('empty command'), { code: 'bad_params' });
  const [bin, ...rest] = parts;
  const allowBins = new Set(['node', 'npm', 'pytest', 'python', 'cargo', 'go']);
  if (!allowBins.has(bin)) throw Object.assign(new Error(`command not allowlisted: ${bin}`), { code: 'denied' });
  // Every argument is validated: no shell metacharacters (defense in depth —
  // execFile never invokes a shell, but flags/args still reach the child),
  // no env assignments, no path escape, bounded count/length.
  validateCommandArgs(bin, rest, workspace);
  if (bin === 'node') {
    // node must target a file inside the workspace (flag position already
    // rejected by validateCommandArgs above).
    if (!rest[0]) throw Object.assign(new Error('node requires a file argument'), { code: 'bad_params' });
    const ws = resolveWorkspaceRoot(workspace);
    const rel = String(rest[0]).replace(/^\/+/, '');
    const abs = path.resolve(ws, rel);
    if (abs !== ws && !abs.startsWith(ws + path.sep)) {
      throw Object.assign(new Error('node target escapes workspace'), { code: 'denied' });
    }
    return { cmd: 'node', args: [abs, ...rest.slice(1)] };
  }
  return { cmd: bin, args: rest };
}

// Argument allowlist hardening for allowlisted development commands.
// Without this, `python -c <code>`, `node -e <code>`, or `--rootdir=/etc`
// style escapes turn a "run tests" tool into arbitrary execution / file
// disclosure outside the workspace.
//
// Agent 3: the strict rules live in ./command-guard.js (shared with the
// isolated worker). This function keeps its signature and delegates, so all
// existing callers gain the strengthened checks (command substitution,
// blocked interpreters, env-override tricks, workspace-redirecting flags).
function validateCommandArgs(bin, args, workspace) {
  require('./command-guard').validateArgv([bin, ...(args || [])], workspace);
}

function runAllowlisted(argv, { cwd, timeoutMs = 30000, maxBytes = 64 * 1024, signal = null } = {}) {
  return new Promise((resolve, reject) => {
    // Local restricted executor: a command restriction, NOT a sandbox. The
    // result always carries isolated:false + executor:'local-restricted' so
    // no caller can mistake this for isolated execution. The child receives
    // a sanitized minimal environment — never the application process env
    // wholesale (see ./sandbox-env.js).
    let sandboxEnv;
    try {
      sandboxEnv = require('./sandbox-env').buildSandboxEnv();
    } catch {
      sandboxEnv = { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', TERM: 'dumb' };
    }
    const child = execFile(argv[0], argv.slice(1), {
      cwd: resolveWorkspaceRoot(cwd),
      timeout: Math.min(timeoutMs, 180000),
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      env: sandboxEnv,
    }, (error, stdout, stderr) => {
      const cap = (s, n) => {
        const str = String(s || '');
        const truncated = Buffer.byteLength(str, 'utf8') > n;
        return { text: truncated ? Buffer.from(str, 'utf8').slice(-n).toString('utf8') : str, truncated };
      };
      const out = cap(stdout, maxBytes);
      const err = cap(stderr, Math.floor(maxBytes / 2));
      if (error) {
        const timedOut = error.killed && (error.signal === 'SIGTERM' || /timed out/i.test(error.message));
        return reject(Object.assign(
          new Error(timedOut ? `command timed out after ${timeoutMs}ms` : `command failed (exit ${error.code ?? '?'}))`),
          { code: timedOut ? 'timeout' : 'command_failure', details: { exitCode: error.code ?? null, stdout: out.text, stderr: err.text } }
        ));
      }
      resolve({
        command: argv.join(' '),
        cwd: resolveWorkspaceRoot(cwd),
        exitCode: 0,
        durationMs: 0, // filled by caller
        stdout: out.text,
        stderr: err.text,
        timedOut: false,
        timed_out: false,
        truncated: out.truncated || err.truncated,
        // Explicit executor boundary: this path is NEVER isolated.
        isolated: false,
        executor: 'local-restricted',
      });
    });
    if (signal) {
      if (signal.aborted) { try { child.kill('SIGKILL'); } catch {} }
      else signal.addEventListener('abort', () => { try { child.kill('SIGKILL'); } catch {} }, { once: true });
    }
  });
}

// --- Network fetch with DNS-aware SSRF guards ---
//
// String checks alone cannot stop SSRF: a hostname that looks public can
// resolve to a private address (DNS rebinding / malicious DNS). Every
// outbound connection therefore passes three independent gates:
//   1. URL shape (scheme, credentials, literal-IP / hostname blocklists,
//      policy mode + allowlist) — synchronous, fail-fast.
//   2. DNS resolution of the hostname: EVERY resolved address must be
//      public. One private address => the whole target is rejected.
//   3. Per-redirect-hop re-validation: each Location target repeats gates
//      1+2 with the CURRENT hop's scheme (no scheme-downgrade bypass, no
//      redirect-to-private bypass).
//
// Residual platform limitation (documented, not silent): Node's http/https
// stack re-resolves the hostname at connect time, so a hostile resolver
// that answers differently between validation and connection (TOCTOU) can
// only be mitigated, not eliminated, at this layer — by validating all
// returned addresses, refusing to follow redirects blindly, and keeping
// timeouts/byte limits tight. Run egress behind a firewall allowlist for
// hostile-DNS threat models.

const dns = require('dns');
const net = require('net');

// Injectable resolver for tests: setDnsResolver(async (hostname) => [{address, family}, ...]).
let dnsResolverOverride = null;
function setDnsResolver(fn) {
  dnsResolverOverride = typeof fn === 'function' ? fn : null;
}
async function lookupAll(hostname) {
  if (dnsResolverOverride) return dnsResolverOverride(hostname);
  return dns.promises.lookup(hostname, { all: true });
}

function ipv4ToInt(ip) {
  const parts = String(ip).split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = (n * 256 + v) >>> 0;
  }
  return n >>> 0;
}
function ipv4InCidr(ip, base, bits) {
  const a = ipv4ToInt(ip);
  const b = ipv4ToInt(base);
  if (a === null || b === null) return false;
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : ((0xffffffff << (32 - bits)) >>> 0);
  return ((a & mask) >>> 0) === ((b & mask) >>> 0);
}

// Blocked IPv4 ranges: loopback, RFC1918, link-local, multicast,
// unspecified, broadcast, reserved, CGNAT, TEST-NET documentation, plus the
// cloud metadata address (covered by link-local but listed explicitly).
const BLOCKED_V4 = [
  ['127.0.0.0', 8, 'loopback'], ['10.0.0.0', 8, 'rfc1918'], ['172.16.0.0', 12, 'rfc1918'],
  ['192.168.0.0', 16, 'rfc1918'], ['169.254.0.0', 16, 'link-local'], ['224.0.0.0', 4, 'multicast'],
  ['0.0.0.0', 8, 'unspecified'], ['255.255.255.255', 32, 'broadcast'], ['240.0.0.0', 4, 'reserved'],
  ['100.64.0.0', 10, 'shared-cgnat'], ['192.0.2.0', 24, 'documentation'], ['198.51.100.0', 24, 'documentation'],
  ['203.0.113.0', 24, 'documentation'], ['192.88.99.0', 24, 'reserved-relay'],
];

function ipv6ToBigInt(ip) {
  let s = String(ip).toLowerCase();
  // Strip scope id (fe80::1%eth0) and brackets.
  s = s.split('%')[0];
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  // Embedded IPv4 (e.g. ::ffff:1.2.3.4).
  let embeddedV4 = null;
  const v4match = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4match) {
    const n = ipv4ToInt(v4match[1]);
    if (n === null) return null;
    embeddedV4 = n;
    s = s.slice(0, s.length - v4match[1].length);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const parseGroup = (g) => g.split(':').filter((x) => x.length > 0);
  let groups;
  if (halves.length === 2) {
    const left = halves[0] ? parseGroup(halves[0]) : [];
    const right = halves[1] ? parseGroup(halves[1]) : [];
    const missing = 8 - (left.length + right.length) - (embeddedV4 !== null ? 2 : 0);
    if (missing < 0) return null;
    groups = [...left, ...new Array(missing).fill('0'), ...right];
  } else {
    groups = parseGroup(s);
  }
  if (embeddedV4 !== null) {
    if (groups.length !== 6) return null;
    groups = [...groups, ((embeddedV4 >>> 16) & 0xffff).toString(16), (embeddedV4 & 0xffff).toString(16)];
  }
  if (groups.length !== 8) return null;
  let out = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    out = (out << 16n) + BigInt(parseInt(g, 16));
  }
  return out;
}
function ipv6InCidr(ipInt, base, bits) {
  const b = ipv6ToBigInt(base);
  if (ipInt === null || b === null) return false;
  if (bits === 0) return true;
  const shift = 128n - BigInt(bits);
  return (ipInt >> shift) === (b >> shift);
}

// Blocked IPv6 ranges: loopback, unspecified, link-local, unique-local,
// multicast, documentation, IPv4-mapped (checked against the INNER address
// too), 6to4/teredo transition (embed public v4 only after inner check).
const BLOCKED_V6 = [
  ['::1', 128, 'loopback'], ['::', 128, 'unspecified'], ['fe80::', 10, 'link-local'],
  ['fc00::', 7, 'unique-local'], ['ff00::', 8, 'multicast'], ['2001:db8::', 32, 'documentation'],
  ['::ffff:0:0', 96, 'ipv4-mapped'], ['2002::', 16, '6to4-transition'], ['2001::', 32, 'teredo-transition'],
  ['64:ff9b::', 96, 'translation'], ['100::', 64, 'discard'],
];

// Returns null when public, otherwise a short reason string.
function blockedIpReason(ip) {
  const family = net.isIP(ip);
  if (family === 4) {
    for (const [base, bits, reason] of BLOCKED_V4) {
      if (ipv4InCidr(ip, base, bits)) return reason;
    }
    return null;
  }
  if (family === 6) {
    const n = ipv6ToBigInt(ip);
    if (n === null) return 'malformed-ip';
    for (const [base, bits, reason] of BLOCKED_V6) {
      if (ipv6InCidr(n, base, bits)) {
        // IPv4-mapped: also judge the embedded address on its own merits.
        if (reason === 'ipv4-mapped') {
          const inner = `${(n >> 24n) & 255n}.${(n >> 16n) & 255n}.${(n >> 8n) & 255n}.${n & 255n}`;
          const innerReason = blockedIpReason(inner);
          return innerReason ? `ipv4-mapped-${innerReason}` : 'ipv4-mapped';
        }
        return reason;
      }
    }
    return null;
  }
  return 'not-an-ip';
}

const BLOCKED_HOSTNAMES = new Set([
  'localhost', 'metadata.google.internal', 'metadata.google',
  'instance-data', 'instance-data-compute',
]);
const BLOCKED_SUFFIXES = ['.local', '.internal', '.lan', '.localhost', '.localdomain', '.invalid', '.test'];
// Cloud metadata hostnames that must never be fetched even via CNAME.
const METADATA_HOST_RES = [/^metadata\./i, /^instance-data/i, /^169\.254\.169\.254$/];

// Reject hostnames containing '..' sequences (prevents DNS rebinding via
// percent-encoded or otherwise obfuscated double-dot patterns).
const DOUBLE_DOT_RE = /\.\./;

function normalizeHostname(raw) {
  // WHATWG URLs keep brackets on IPv6 literals (hostname === '[::1]').
  return String(raw || '').toLowerCase().replace(/\.$/, '').replace(/^\[(.*)\]$/, '$1');
}

function blockedHostnameReason(host) {
  if (!host) return 'empty-host';
  const h = normalizeHostname(host);
  if (!h) return 'empty-host';
  if (host.includes('..') || h.includes('..')) return 'double-dot-hostname';
  if (BLOCKED_HOSTNAMES.has(h)) return 'blocked-hostname';
  for (const sfx of BLOCKED_SUFFIXES) {
    if (h === sfx.slice(1) || h.endsWith(sfx)) return 'private-suffix';
  }
  for (const re of METADATA_HOST_RES) {
    if (re.test(h)) return 'metadata-host';
  }
  return null;
}

function parseAndGuardUrl(raw, policy) {
  console.log("[DEBUG] parseAndGuardUrl called with:", raw);
  console.log("[DEBUG] about to new URL");
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    throw Object.assign(new Error('invalid URL'), { code: 'bad_params' });
  }
  if (!['http:', 'https:'].includes(u.protocol)) {
    throw Object.assign(new Error(`protocol not allowed: ${u.protocol}`), { code: 'denied' });
  }
  if (u.username || u.password) {
    throw Object.assign(new Error('URLs with embedded credentials are rejected'), { code: 'denied' });
  }
  const host = normalizeHostname(u.hostname);
  if (!host) throw Object.assign(new Error('URL has no hostname'), { code: 'bad_params' });
  // Literal IPs are judged by range, not by string prefix (catches
  // 0x7f.1, 0177.0.0.1-style obfuscation only insofar as URL parses them;
  // the DNS gate below re-checks whatever the resolver returns).
  if (net.isIP(host)) {
    const reason = blockedIpReason(host);
    if (reason) throw Object.assign(new Error(`blocked IP target (${reason}): ${host}`), { code: 'denied' });
  } else {
    const reason = blockedHostnameReason(host);
    if (reason) throw Object.assign(new Error(`blocked host (${reason}): ${host}`), { code: 'denied' });
  }
  // Path traversal guard: reject '..' sequences in the pathname (e.g.
  // %2e%2e, encoded or literal, that could escape the workspace via
  // directory traversal). This is checked on the decoded pathname.
  const decodedPathname = decodeURIComponent(u.pathname);
  if (decodedPathname.includes('..')) {
    throw Object.assign(new Error('path traversal via ".." in URL pathname'), { code: 'denied' });
  }
  const mode = (policy && policy.networkAccess) || NetworkMode.DISABLED;
  if (mode === NetworkMode.DISABLED) throw Object.assign(new Error('network access disabled by policy'), { code: 'denied' });
  if (mode === NetworkMode.ALLOWLIST) {
    const allow = (policy && policy.networkAllowlist) || [];
    const ok = allow.some((a) => host === normalizeHostname(a) || host.endsWith(`.${normalizeHostname(a)}`));
    if (!ok) throw Object.assign(new Error(`host not in network allowlist: ${host}`), { code: 'denied' });
  }
  return u;
}

// Gate 2 — DNS: resolve the hostname and require EVERY address to be
// public. A hostname that looks public but resolves (even partly) to a
// private/link-local/loopback address is rejected. Literal IPs are
// re-checked here so one code path judges all addresses.
async function resolveAndGuardHost(hostname) {
  const host = normalizeHostname(hostname);
  if (net.isIP(host)) {
    const reason = blockedIpReason(host);
    if (reason) throw Object.assign(new Error(`blocked IP target (${reason}): ${host}`), { code: 'denied' });
    return [host];
  }
  let records;
  try {
    records = await lookupAll(host);
  } catch (e) {
    // Fail closed: an unresolvable host cannot be proven public.
    throw Object.assign(new Error(`DNS resolution failed for ${host}: cannot verify target is public`), { code: 'denied' });
  }
  if (!Array.isArray(records) || !records.length) {
    throw Object.assign(new Error(`no DNS records for ${host}`), { code: 'denied' });
  }
  for (const r of records) {
    const addr = r && (r.address || r);
    const reason = blockedIpReason(String(addr));
    if (reason) {
      throw Object.assign(new Error(`hostname ${host} resolves to blocked address ${addr} (${reason})`), { code: 'denied' });
    }
  }
  return records.map((r) => r && (r.address || r));
}

function schemeAllowedForPolicy(protocol, policy) {
  // https-only under restricted policies; plain http only when networking
  // is explicitly ENABLED for the run. Evaluated per redirect hop.
  if (protocol === 'https:') return true;
  return (policy && policy.networkAccess) === NetworkMode.ENABLED;
}

function fetchUrlGuarded(rawUrl, { policy, timeoutMs = 15000, maxBytes = 256 * 1024, maxRedirects = 3 } = {}) {
  return (async () => {
    const startUrl = parseAndGuardUrl(rawUrl, policy);
    if (!schemeAllowedForPolicy(startUrl.protocol, policy)) {
      throw Object.assign(new Error('only https URLs are allowed under restricted network policy'), { code: 'denied' });
    }
    await resolveAndGuardHost(startUrl.hostname);
    return await fetchHop(startUrl, { policy, timeoutMs, maxBytes, maxRedirects, redirects: 0 });
  })();
}

// One validated hop. The transport (http/https) is chosen from the CURRENT
// hop's URL — never inherited from the original request — and every hop is
// independently shape-checked, scheme-checked, and DNS-checked.
function fetchHop(target, { policy, timeoutMs, maxBytes, maxRedirects, redirects }) {
  return new Promise((resolve, reject) => {
    let guarded;
    try {
      guarded = parseAndGuardUrl(target.toString(), policy);
      if (!schemeAllowedForPolicy(guarded.protocol, policy)) {
        throw Object.assign(new Error('redirect to non-https URL is not allowed under restricted network policy'), { code: 'denied' });
      }
    } catch (e) { reject(e); return; }
    resolveAndGuardHost(guarded.hostname).then(() => {
      const timer = setTimeout(() => {
        reject(Object.assign(new Error(`fetch timed out after ${Math.min(timeoutMs, 30000)}ms`), { code: 'timeout' }));
      }, Math.min(timeoutMs, 30000));
      // Deliberately NOT unref'd: this timer is the timeout guarantee. It is
      // always cleared when the hop settles.
      doRequest(guarded, { timeoutMs }).then(({ statusCode, headers, stream, req }) => {
        const done = (fn) => { clearTimeout(timer); fn(); };
        if ([301, 302, 303, 307, 308].includes(statusCode) && headers && headers.location) {
          if (redirects >= maxRedirects) {
            try { stream.resume(); } catch {}
            done(() => reject(Object.assign(new Error('too many redirects'), { code: 'redirect_limit' })));
            return;
          }
          try { stream.resume(); } catch {}
          let next;
          try {
            next = new URL(headers.location, guarded);
          } catch (e) { done(() => reject(e)); return; }
          clearTimeout(timer);
          fetchHop(next, { policy, timeoutMs, maxBytes, maxRedirects, redirects: redirects + 1 }).then(resolve, reject);
          return;
        }
        consumeBounded(stream, maxBytes).then(
          ({ body, bytes }) => done(() => resolve({ url: guarded.toString(), status: statusCode, body, truncated: false, bytes })),
          (e) => done(() => reject(e)),
        );
      }, (e) => {
        clearTimeout(timer);
        reject(Object.assign(new Error(`fetch failed: ${e.message}`), {
          code: /timed out/i.test(e.message) ? 'timeout' : 'fetch_failure',
        }));
      });
    }, reject);
  });
}

// Bounded body consumption shared by the real and injected transports.
function consumeBounded(stream, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let oversized = false;
    const failOversized = () => reject(Object.assign(new Error(`response exceeds ${maxBytes} byte limit`), { code: 'oversized' }));
    stream.on('data', (c) => {
      bytes += c.length;
      if (bytes > maxBytes) {
        // Stop paying for the rest of an oversized body.
        oversized = true;
        try { stream.destroy(); } catch {}
      } else chunks.push(c);
    });
    stream.on('end', () => {
      if (oversized) { failOversized(); return; }
      resolve({ body: Buffer.concat(chunks).toString('utf8'), bytes });
    });
    // A destroyed oversized stream surfaces 'aborted'/'error' instead of
    // 'end' on some Node versions: report the same deterministic code.
    stream.on('aborted', () => { if (oversized) failOversized(); });
    stream.on('error', (e) => {
      if (oversized) failOversized();
      else reject(Object.assign(new Error(`fetch failed: ${e.message}`), { code: 'fetch_failure' }));
    });
  });
}

// Test seam: setFetchTransport(async (url, { timeoutMs }) =>
// { statusCode, headers, stream, req? }). Production always uses the real
// HTTP/HTTPS stack; the guard logic above runs identically either way.
let fetchTransportOverride = null;
function setFetchTransport(fn) {
  fetchTransportOverride = typeof fn === 'function' ? fn : null;
}
function doRequest(guarded, { timeoutMs }) {
  if (fetchTransportOverride) {
    return Promise.resolve().then(() => fetchTransportOverride(guarded, { timeoutMs }));
  }
  return new Promise((resolve, reject) => {
    const lib = guarded.protocol === 'https:' ? require('https') : require('http');
    const req = lib.get(guarded, { timeout: Math.min(timeoutMs, 30000) }, (res) => {
      resolve({ statusCode: res.statusCode, headers: res.headers || {}, stream: res, req });
    });
    req.on('timeout', () => { req.destroy(new Error('fetch timed out')); });
    req.on('error', reject);
  });
}

// --- Artifacts (references, never huge blobs in events) ---

let artifactSeq = 0;

class ArtifactStore {
  constructor() {
    this.items = new Map(); // id -> artifact metadata (+ small inline content)
  }

  put({ runId, type, name, mimeType, content, filePath, maxInline = 64 * 1024 }) {
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content ?? ''), 'utf8');
    const id = `art-${Date.now().toString(36)}-${(artifactSeq++).toString(36)}`;
    const hash = crypto.createHash('sha256').update(buf).digest('hex');
    const record = {
      id,
      runId: runId || null,
      type: type || 'log',
      name: String(name || id).slice(0, 200),
      path: filePath || null,
      mimeType: mimeType || 'text/plain',
      size: buf.length,
      hash,
      createdAt: new Date().toISOString(),
      // Small artifacts inline; large ones stay referenced by id/hash.
      inline: buf.length <= maxInline ? buf.toString('utf8').slice(0, maxInline) : null,
      reference: { artifactId: id, type: type || 'log', size: buf.length, hash },
    };
    this.items.set(id, record);
    if (this.items.size > 500) {
      const first = this.items.keys().next().value;
      this.items.delete(first);
    }
    return { ...record };
  }

  get(id) {
    const r = this.items.get(id);
    return r ? { ...r } : null;
  }

  reference(id) {
    const r = this.items.get(id);
    return r ? { ...r.reference } : null;
  }

  listForRun(runId) {
    return [...this.items.values()].filter((a) => a.runId === runId).map((a) => ({ ...a, inline: undefined }));
  }

  clearRun(runId) {
    for (const [id, r] of this.items.entries()) {
      if (r.runId === runId) this.items.delete(id);
    }
  }
}

module.exports = {
  redactSecrets,
  summarizeInputs,
  detectProject,
  environmentProfile,
  parseTestCommandString,
  validateCommandArgs,
  runAllowlisted,
  parseAndGuardUrl,
  resolveAndGuardHost,
  blockedIpReason,
  blockedHostnameReason,
  setDnsResolver,
  setFetchTransport,
  fetchUrlGuarded,
  ArtifactStore,
};
