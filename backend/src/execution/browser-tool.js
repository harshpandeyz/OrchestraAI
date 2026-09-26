'use strict';

// OrchestraAI — Browser/computer-use tool v1 (Session 12).
//
// Honest scope: `browser_snapshot` (read-only page snapshot) and
// `browser_navigate` (snapshot after navigation) share one implementation.
// There is no hidden full-desktop control: v1 fetches the target through the
// existing DNS-aware SSRF-guarded path (environment.fetchUrlGuarded) and
// returns a bounded, redacted snapshot (title / headings / links / text).
// Interactive Playwright-driven sessions remain operator-controlled via the
// existing e2e Playwright installation; when Playwright is resolvable the
// sandbox worker prefers it as the snapshot engine, otherwise the guarded
// fetch engine is used. The `engine` field always says which one ran.
//
// Routing (all enforced, none advisory):
//   - execution-policy: disabled-by-default tools need explicit
//     policy.allowedTools opt-in; networkAccess must not be DISABLED;
//     HIGH risk (browser_navigate) always needs approval.
//   - command-guard: N/A for URLs (no shell), but URL strings are still
//     rejected when they contain shell metacharacters that could escape logs.
//   - SSRF: DEMO mock never touches the network; LIVE goes through
//     parseAndGuardUrl (shape + allowlist) + resolveAndGuardHost (DNS: every
//     resolved address must be public) + per-hop re-validation, with
//     timeout/size caps and secret redaction.
//
// DEMO mode: deterministic mock session, zero network. Any `demo:` URL (or
// `about:demo`, or a host ending in `.demo.local`) returns a canned snapshot
// derived deterministically from the URL — same URL, same snapshot.

const crypto = require('crypto');
const { redactSecrets } = require('./environment');

const DEMO_HOSTS_SUFFIX = '.demo.local';
const MAX_URL_LEN = 2000;
const SHELL_META_RE = /[;`$(){}!#~\n\r\0]/;

function isDemoUrl(raw) {
  const s = String(raw || '').trim();
  if (/^demo:/i.test(s)) return true;
  if (/^about:demo/i.test(s)) return true;
  try {
    const u = new URL(s);
    if (u.hostname.toLowerCase().endsWith(DEMO_HOSTS_SUFFIX)) return true;
  } catch { /* not a URL — handled below */ }
  return false;
}

function demoSnapshot(rawUrl) {
  const s = String(rawUrl);
  const h = crypto.createHash('sha256').update(s).digest('hex').slice(0, 8);
  const title = `Demo page ${h}`;
  return {
    url: s,
    status: 200,
    title,
    headings: ['Demo snapshot', `Section ${h.slice(0, 4)}`],
    links: [{ href: 'demo:next', text: 'Next demo step' }],
    text: `Deterministic DEMO browser snapshot for ${s}. No network was used; identical URLs always produce identical snapshots.`,
    bytes: 512,
    truncated: false,
    engine: 'mock',
    provenance: 'DEMO',
    mocked: true,
  };
}

function extractSnapshot(url, status, body, engine) {
  const html = String(body || '');
  const title = (/\<title[^>]*\>([^<]{1,200})\<\/title\>/i.exec(html) || [])[1]?.trim() || null;
  const headings = [];
  const hre = /\<h[1-3][^>]*\>([^<]{1,200})\<\/h[1-3]\>/gi;
  let m;
  while ((m = hre.exec(html)) && headings.length < 10) headings.push(m[1].trim());
  const links = [];
  const lre = /\<a[^>]+href\s*=\s*["']([^"']{1,500})["'][^>]*\>([^<]{0,120})\<\/a\>/gi;
  while ((m = lre.exec(html)) && links.length < 20) links.push({ href: m[1].slice(0, 500), text: (m[2] || '').trim().slice(0, 120) });
  const text = html.replace(/\<script[\s\S]*?\<\/script\>/gi, ' ').replace(/\<style[\s\S]*?\<\/style\>/gi, ' ')
    .replace(/\<[^>]+\>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 4000);
  return {
    url, status, title, headings, links,
    text: redactSecrets(text),
    bytes: Buffer.byteLength(html, 'utf8'),
    truncated: html.length > 8000,
    engine,
    provenance: 'OBSERVED',
    mocked: false,
  };
}

async function executeBrowserTool(toolName, params, ctx = {}) {
  const rawUrl = String((params && params.url) || '');
  if (!rawUrl) throw Object.assign(new Error('url is required'), { code: 'bad_params' });
  if (rawUrl.length > MAX_URL_LEN) throw Object.assign(new Error('url exceeds length limit'), { code: 'bad_params' });
  if (SHELL_META_RE.test(rawUrl)) throw Object.assign(new Error('url contains rejected characters'), { code: 'denied' });

  const mode = ctx.mode || process.env.RUNTIME_MODE || 'demo';
  const policy = ctx.policy || { networkAccess: mode === 'demo' ? 'disabled' : 'allowlist', networkAllowlist: [] };

  // DEMO mock session: deterministic, no network, always available.
  if (mode === 'demo' || isDemoUrl(rawUrl)) {
    if (mode !== 'demo' && !isDemoUrl(rawUrl)) {
      // LIVE mode with a non-demo URL falls through to the guarded path.
    } else {
      return demoSnapshot(rawUrl);
    }
  }

  // LIVE path: policy gate first (never bypassed).
  const { isToolAllowedByPolicy } = require('./execution-policy');
  const gate = isToolAllowedByPolicy(policy, toolName, { disabled: true });
  if (!gate.allowed) throw Object.assign(new Error(gate.reason), { code: 'denied' });

  const { fetchUrlGuarded } = require('./environment');
  const maxBytes = Math.min(Number((params && params.maxBytes) || 65536), 262144);
  const timeoutMs = Math.min(Number(ctx.timeoutMs) || 20000, 30000);
  const r = await fetchUrlGuarded(rawUrl, { policy, timeoutMs, maxBytes });
  return extractSnapshot(r.url, r.status, r.body.slice(0, 8000), 'fetch');
}

module.exports = { executeBrowserTool, demoSnapshot, isDemoUrl, extractSnapshot };
