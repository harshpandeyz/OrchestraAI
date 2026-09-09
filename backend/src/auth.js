'use strict';

// Session 1 — backend security foundation: authentication, authorization,
// resource ownership.
//
// Design (practical for this single-process product, no external IdP):
//   - Bearer-token auth. Tokens are configured via env, never hardcoded.
//   - Roles: viewer (read-only) < operator (run lifecycle) < admin (providers,
//     runtime settings, all runs).
//   - Resource ownership: runs record ownerId/orgId. Non-admins can only
//     access runs in their tenant. Runs without ownership metadata are
//     quarantined from authenticated users; global admins may migrate them.
//   - Development mode: when AUTH_ENABLED is omitted outside production, every
//     request gets a synthetic dev principal so local development works with
//     zero config. Production always enables the closed auth path.
//
// Secrets never appear in logs, errors, snapshots, or events — only presence
// metadata leaves the backend (see credential-store.js).

const crypto = require('crypto');

const ROLES = ['viewer', 'operator', 'admin'];
const ROLE_RANK = { viewer: 1, operator: 2, admin: 3 };

// The browser session credential is an HttpOnly cookie. This name and the
// Set-Cookie builders below are the single authority for session transport:
// caller-set cookies (server.js) and reader (authenticate) share them so the
// attribute posture (HttpOnly/SameSite/Secure) can never drift between routes.
const SESSION_COOKIE_NAME = 'oa_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days (matches TenantStore)

// Read the opaque session token from a request's Cookie header. Returns '' when
// absent. Never throws: a malformed cookie simply auths as unauthenticated.
function readSessionCookie(headers = {}) {
  const raw = String(headers.cookie || headers.Cookie || '');
  const part = raw.split(';').map((v) => v.trim()).find((v) => v.startsWith(`${SESSION_COOKIE_NAME}=`));
  if (!part) return '';
  try {
    return decodeURIComponent(part.slice(SESSION_COOKIE_NAME.length + 1));
  } catch {
    return '';
  }
}

// Build the Set-Cookie value for a freshly issued session token.
// `secure` enables the Secure attribute (production/live); dev keeps it off so
// plain-HTTP localhost login keeps working. HttpOnly + SameSite=Lax + Path=/
// are always set — JavaScript can never read the credential, and cross-site
// requests never carry it (Lax), which is the CSRF posture the server pairs
// with the Origin check on state-changing requests.
function buildSessionCookie(token, { secure = false } = {}) {
  const attr = `HttpOnly; SameSite=Lax; Path=/${secure ? '; Secure' : ''}`;
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(String(token))}; ${attr}`;
}

// Expire a session cookie (logout invalidation).
function clearSessionCookie() {
  return `${SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

function roleRank(role) {
  return ROLE_RANK[String(role || '').toLowerCase()] || 0;
}

function loadAuthConfig(env = process.env) {
  // A production process never silently starts with an open control plane.
  // Local development remains dev-open when AUTH_ENABLED is omitted.
  const enabled = /^(1|true|yes|on)$/i.test(String(env.AUTH_ENABLED || ''))
    || String(env.NODE_ENV || '').toLowerCase() === 'production';
  return {
    enabled,
    // Admin token (full access). Empty = no admin token configured.
    adminToken: String(env.API_TOKEN || env.AUTH_TOKEN || ''),
    operatorToken: String(env.OPERATOR_TOKEN || ''),
    viewerToken: String(env.READ_TOKEN || env.VIEWER_TOKEN || ''),
    // Comma-separated extra tokens: "id:role:secret" (for tests / multi-user).
    extraTokens: String(env.AUTH_TOKENS || ''),
  };
}

function parseExtraTokens(raw) {
  const out = [];
  for (const part of String(raw || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const [id, role, ...secretParts] = part.split(':');
    const secret = secretParts.join(':');
    if (!id || !secret) continue;
    const r = String(role || 'viewer').toLowerCase();
    if (!ROLES.includes(r)) continue;
    out.push({ id, role: r, secret });
  }
  return out;
}

function principalForToken(authConfig, token) {
  if (!token) return null;
  const t = String(token);
  if (authConfig.adminToken && timingSafeEqual(t, authConfig.adminToken)) {
    return { id: 'admin', role: 'admin', source: 'env' };
  }
  if (authConfig.operatorToken && timingSafeEqual(t, authConfig.operatorToken)) {
    return { id: 'operator', role: 'operator', source: 'env' };
  }
  if (authConfig.viewerToken && timingSafeEqual(t, authConfig.viewerToken)) {
    return { id: 'viewer', role: 'viewer', source: 'env' };
  }
  for (const e of parseExtraTokens(authConfig.extraTokens)) {
    if (timingSafeEqual(t, e.secret)) return { id: e.id, role: e.role, source: 'env-list' };
  }
  return null;
}

function timingSafeEqual(a, b) {
  try {
    const ba = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

function bearerFromHeaders(headers = {}) {
  const raw = headers.authorization || headers.Authorization || '';
  const m = String(raw).match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

// Resolve the principal for a request. In explicitly open development mode
// (auth disabled) returns the synthetic admin dev principal.
//
// Dual sync/async: bearer/env-token paths resolve synchronously; the
// session-cookie path returns a Promise only when the tenant store itself is
// asynchronous (Postgres). `await` works with both — server.js always awaits.
function authenticate(req, authConfig, tenantStore = null) {
  const cfg = authConfig || loadAuthConfig();
  if (!cfg.enabled) return { id: 'dev', role: 'admin', orgId: 'dev-org', source: 'dev-mode' };
  const token = bearerFromHeaders(req.headers || {});
  const configuredPrincipal = principalForToken(cfg, token);
  if (configuredPrincipal) return configuredPrincipal;
  if (tenantStore && typeof tenantStore.userForSession === 'function') {
    const session = readSessionCookie(req.headers);
    if (session) {
      const found = tenantStore.userForSession(session);
      if (found && typeof found.then === 'function') {
        return found.then((user) => (user ? { id: user.id, role: user.role, orgId: user.orgId, source: 'session' } : null));
      }
      if (found) return { id: found.id, role: found.role, orgId: found.orgId, source: 'session' };
    }
  }
  return null;
}

function requireRole(principal, minRole) {
  if (!principal) return false;
  return roleRank(principal.role) >= roleRank(minRole);
}

// Environment tokens are installation operators. Signup/login users may be
// organization admins, but must never receive cross-tenant visibility merely
// because their organization role is also named "admin".
function isGlobalAdmin(principal) {
  return !!principal && principal.role === 'admin' && principal.source !== 'session';
}

// Ownership: non-admins may only touch their own tenant's runs. Ownerless
// legacy records are not public; they are quarantined until migrated.
function canAccessRun(principal, runLike) {
  if (!principal) return false;
  if (isGlobalAdmin(principal)) return true;
  if (!runLike) return false;
  const orgId = runLike.orgId || runLike.ownership?.orgId || null;
  if (orgId && principal.orgId && orgId === principal.orgId) return true;
  const owner = runLike.ownerId || runLike.owner || runLike.ownership?.ownerId || null;
  if (!owner) return false;
  return owner === principal.id;
}

function authModeSummary(authConfig) {
  return {
    enabled: !!authConfig.enabled,
    mode: authConfig.enabled ? 'token' : 'dev-open',
    roles: ROLES,
  };
}

module.exports = {
  ROLES,
  roleRank,
  loadAuthConfig,
  principalForToken,
  bearerFromHeaders,
  authenticate,
  requireRole,
  isGlobalAdmin,
  canAccessRun,
  authModeSummary,
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
  readSessionCookie,
  buildSessionCookie,
  clearSessionCookie,
};
