'use strict';

// HTTP security headers + CORS origin policy.
//
// Pure and unit-testable: every function takes its decision inputs explicitly
// and never reads process.env. server.js binds these to the process config and
// re-exports them so the existing test surface (corsHeaders, resolveCorsOrigin)
// is unchanged.

// CORS: configured frontend origin(s) only in production. Loopback origins
// stay usable for local development outside live mode. Unknown origins get no
// ACAO header (browser blocks); non-browser clients (no Origin) are unaffected.
function resolveCorsOrigin(origin, opts = {}) {
  if (!origin) return {};
  const configured = String(opts.frontendOrigin || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (configured.includes(origin)) {
    return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
  }
  if (!opts.isLive && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
  }
  return {};
}

// Defense-in-depth security headers. `secure` enables HSTS (production/live).
// The CSP is deliberately locked to self + the documented dev origins; it must
// never be relaxed with `unsafe-eval` or wildcards to make frontend features
// "just work".
function securityHeaders({ secure = false } = {}) {
  const headers = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Content-Security-Policy': "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' http://localhost:5173 http://127.0.0.1:5173",
  };
  if (secure) {
    headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  }
  return headers;
}

module.exports = { resolveCorsOrigin, securityHeaders };