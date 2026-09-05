'use strict';

// Small single-process tenant/auth store for V1. It is deliberately boring:
// JSON files with atomic replacement, scrypt password hashes, and hashed
// opaque sessions. Provider secrets stay in CredentialStore and never enter
// this store or the browser.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function hash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, JSON.stringify(value), 'utf8');
  fs.renameSync(tmp, file);
}

class TenantStore {
  constructor(dir) {
    this.dir = dir;
    this.usersFile = path.join(dir, 'users.json');
    this.sessionsFile = path.join(dir, 'sessions.json');
    this.projectsFile = path.join(dir, 'projects.json');
    // Optional PostgresDatastore for durable multi-instance tenancy. When
    // set (server.js wires it for DATASTORE_PROVIDER=postgres), all reads
    // and writes below go to Postgres — the source of truth. The file
    // adapter remains the explicit dev/test authority otherwise. Methods are
    // async throughout so both backends share one call shape.
    this.remote = null;
    // Corrupted storage is an OPERATIONAL error, never an empty tenant set.
    // A missing file (fresh install) reads as []; a corrupt file is
    // quarantined and throws code 'tenant_store_corrupt' so the operator
    // restores from backup instead of silently losing tenants/sessions.
    this.users = this.readStrict(this.usersFile, 'users');
    this.sessions = this.readStrict(this.sessionsFile, 'sessions');
    this.projects = this.readStrict(this.projectsFile, 'projects');
    this.corrupted = false;
  }

  readStrict(file, label) {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (e) {
      if (e && e.code === 'ENOENT') return [];
      const err = new Error(`tenant store unreadable (${label}): ${String((e && e.message) || e).slice(0, 160)}`);
      err.code = 'tenant_store_unavailable';
      throw err;
    }
    if (!raw.trim()) {
      quarantineCorrupt(file);
      const err = new Error(`tenant store corrupt (${label}): empty file; quarantined, refusing to start with an empty tenant set`);
      err.code = 'tenant_store_corrupt';
      err.corruptFile = file;
      throw err;
    }
    try {
      const value = JSON.parse(raw);
      if (!Array.isArray(value)) throw new Error('expected JSON array');
      return value;
    } catch (e) {
      quarantineCorrupt(file);
      const err = new Error(`tenant store corrupt (${label}): quarantined to *.corrupt-*; restore from backup, refusing to start with an empty tenant set`);
      err.code = 'tenant_store_corrupt';
      err.corruptFile = file;
      err.cause = String((e && e.message) || e).slice(0, 160);
      throw err;
    }
  }

  read(file) {
    // Backwards-compatible helper: missing -> [], corrupt -> throws.
    return this.readStrict(file, path.basename(file));
  }

  persist(file, value) {
    try { atomicWrite(file, Array.isArray(value) ? value : []); return true; } catch { return false; }
  }

  // Dual sync/async: the file adapter (dev/test, no `remote`) returns values
  // synchronously so existing sync callers keep working; with a Postgres
  // `remote` the same methods return Promises. `await` works with both —
  // server.js always awaits.
  signup({ email, password, name } = {}) {
    const normalized = String(email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(normalized)) throw Object.assign(new Error('valid email required'), { code: 'bad_request' });
    if (typeof password !== 'string' || password.length < 12 || password.length > 256) {
      throw Object.assign(new Error('password must be 12 to 256 characters'), { code: 'bad_request' });
    }
    const displayName = String(name || normalized.split('@')[0]).slice(0, 80);
    const buildUser = (salt, passwordHash) => ({
      id: `usr-${crypto.randomBytes(8).toString('hex')}`,
      email: normalized,
      name: displayName,
      passwordHash, passwordSalt: salt,
      orgId: `org-${crypto.randomBytes(8).toString('hex')}`,
      role: 'admin',
      createdAt: new Date().toISOString(),
    });
    if (this.remote) {
      return this.remote.getUserByEmail(normalized).then((existing) => {
        if (existing) throw Object.assign(new Error('email already registered'), { code: 'conflict' });
        const salt = crypto.randomBytes(16).toString('hex');
        const user = buildUser(salt, crypto.scryptSync(password, salt, 64).toString('hex'));
        return this.remote.ensureOrganization({ id: user.orgId, name: `${displayName}'s organization`.slice(0, 200) })
          .then(() => this.remote.createUser(user))
          .then(() => this.createProject(this.publicUser(user), { name: 'My first project' }))
          .then((project) => ({ user: this.publicUser(user), project }));
      });
    }
    if (this.users.some((u) => u.email === normalized)) throw Object.assign(new Error('email already registered'), { code: 'conflict' });
    const salt = crypto.randomBytes(16).toString('hex');
    const user = buildUser(salt, crypto.scryptSync(password, salt, 64).toString('hex'));
    this.users.push(user);
    this.persist(this.usersFile, this.users);
    const project = this.createProject(this.publicUser(user), { name: 'My first project' });
    return { user: this.publicUser(user), project };
  }

  publicUser(user) {
    if (!user) return null;
    return { id: user.id, email: user.email, name: user.name, orgId: user.orgId || user.org_id || null, role: user.role, createdAt: user.createdAt || user.created_at || null };
  }

  findUser(email) {
    const normalized = String(email || '').trim().toLowerCase();
    if (this.remote) {
      return this.remote.getUserByEmail(normalized).then((row) => (row ? toLocalUser(row) : null));
    }
    return this.users.find((u) => u.email === normalized) || null;
  }

  login({ email, password } = {}) {
    const found = this.findUser(email);
    if (found && typeof found.then === 'function') {
      return found.then((user) => this._finishLogin(user, password));
    }
    return this._finishLogin(found, password);
  }

  _finishLogin(user, password) {
    if (!user || typeof password !== 'string') throw Object.assign(new Error('invalid email or password'), { code: 'unauthenticated' });
    const candidate = crypto.scryptSync(password, user.passwordSalt, 64).toString('hex');
    if (!safeEqual(candidate, user.passwordHash)) throw Object.assign(new Error('invalid email or password'), { code: 'unauthenticated' });
    const raw = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30);
    if (this.remote) {
      return this.remote.createSession({ hash: hash(raw), userId: user.id, expiresAt })
        .then(() => this.remote.pruneExpiredSessions().catch(() => {}))
        .then(() => ({ token: raw, user: this.publicUser(user) }));
    }
    this.sessions.push({ hash: hash(raw), userId: user.id, createdAt: new Date().toISOString(), expiresAt: expiresAt.toISOString() });
    this.persist(this.sessionsFile, this.sessions);
    return { token: raw, user: this.publicUser(user) };
  }

  userForSession(token) {
    if (!token) return null;
    if (this.remote) {
      return this.remote.pruneExpiredSessions().catch(() => {})
        .then(() => this.remote.getSessionByHash(hash(token)))
        .then((session) => {
          if (!session || new Date(session.expiresAt).getTime() <= Date.now()) return null;
          return this.remote.getUserById(session.userId);
        })
        .then((row) => (row ? this.publicUser(toLocalUser(row)) : null));
    }
    const now = Date.now();
    const before = this.sessions.length;
    this.sessions = this.sessions.filter((s) => s && new Date(s.expiresAt).getTime() > now);
    if (this.sessions.length !== before) this.persist(this.sessionsFile, this.sessions);
    const session = this.sessions.find((s) => safeEqual(s.hash, hash(token)) && new Date(s.expiresAt).getTime() > now);
    if (!session) return null;
    const user = this.users.find((u) => u.id === session.userId);
    return user ? this.publicUser(user) : null;
  }

  revoke(token) {
    if (this.remote) {
      return this.remote.deleteSession(hash(token)).catch(() => {});
    }
    const before = this.sessions.length;
    this.sessions = this.sessions.filter((s) => !safeEqual(s.hash, hash(token)));
    if (this.sessions.length !== before) this.persist(this.sessionsFile, this.sessions);
  }

  createProject(user, { name, referenceModelId, policy, privacyMode } = {}) {
    const project = {
      id: `prj-${crypto.randomBytes(8).toString('hex')}`,
      orgId: user.orgId,
      ownerId: user.id,
      name: String(name || 'Untitled project').slice(0, 100),
      referenceModelId: referenceModelId ? String(referenceModelId).slice(0, 200) : null,
      policy: ['quality_first', 'balanced', 'maximum_savings', 'lowest_latency', 'custom'].includes(policy) ? policy : 'balanced',
      privacyMode: ['metadata_only', 'standard', 'zero_retention'].includes(privacyMode) ? privacyMode : 'standard',
      createdAt: new Date().toISOString(),
    };
    if (this.remote) {
      return this.remote.createProjectRow(project).then(() => ({ ...project }));
    }
    this.projects.push(project);
    this.persist(this.projectsFile, this.projects);
    return project;
  }

  listProjects(principal) {
    if (!principal) return [];
    if (this.remote) {
      const globalAdmin = principal.role === 'admin' && principal.source !== 'session';
      return this.remote.listProjects({ orgId: principal.orgId, ownerId: principal.id, globalAdmin })
        .then((rows) => rows.map((p) => ({ ...p })));
    }
    const globalAdmin = principal.role === 'admin' && principal.source !== 'session';
    const rows = this.projects.filter((p) => globalAdmin || p.orgId === principal.orgId || p.ownerId === principal.id);
    return rows.map((p) => ({ ...p }));
  }

  getProject(id, principal) {
    const rowsP = this.listProjects(principal);
    if (rowsP && typeof rowsP.then === 'function') {
      return rowsP.then((rows) => rows.find((p) => p.id === id) || null);
    }
    return rowsP.find((p) => p.id === id) || null;
  }

  updateProject(id, principal, patch = {}) {
    if (this.remote) {
      return this.listProjects(principal).then((rows) => {
        const project = rows.find((p) => p.id === id) || null;
        // Datastore-boundary ownership: same rule as list/get (global env
        // admins bypass; everyone else must own the project org/user).
        if (!ownsProject(principal, project)) return null;
        const next = {};
        if (patch.name !== undefined) next.name = String(patch.name || project.name).slice(0, 100);
        if (patch.referenceModelId !== undefined) next.referenceModelId = patch.referenceModelId ? String(patch.referenceModelId).slice(0, 200) : null;
        if (patch.policy !== undefined && ['quality_first', 'balanced', 'maximum_savings', 'lowest_latency', 'custom'].includes(patch.policy)) next.policy = patch.policy;
        if (patch.privacyMode !== undefined && ['metadata_only', 'standard', 'zero_retention'].includes(patch.privacyMode)) next.privacyMode = patch.privacyMode;
        return this.remote.updateProjectRow(id, next).then(() => ({ ...project, ...next, updatedAt: new Date().toISOString() }));
      });
    }
    const project = this.projects.find((p) => p.id === id) || null;
    // Datastore-boundary ownership: same rule as list/get (global env admins
    // bypass; everyone else must own the project org/user). No silent
    // cross-tenant mutation.
    if (!ownsProject(principal, project)) return null;
    if (patch.name !== undefined) project.name = String(patch.name || project.name).slice(0, 100);
    if (patch.referenceModelId !== undefined) project.referenceModelId = patch.referenceModelId ? String(patch.referenceModelId).slice(0, 200) : null;
    if (patch.policy !== undefined && ['quality_first', 'balanced', 'maximum_savings', 'lowest_latency', 'custom'].includes(patch.policy)) project.policy = patch.policy;
    if (patch.privacyMode !== undefined && ['metadata_only', 'standard', 'zero_retention'].includes(patch.privacyMode)) project.privacyMode = patch.privacyMode;
    project.updatedAt = new Date().toISOString();
    this.persist(this.projectsFile, this.projects);
    return { ...project };
  }
}

function sessionCookie(req) {
  const raw = String(req?.headers?.cookie || '');
  const part = raw.split(';').map((v) => v.trim()).find((v) => v.startsWith('oa_session='));
  return part ? decodeURIComponent(part.slice('oa_session='.length)) : '';
}

// Datastore-boundary ownership enforcement. Global (env-token) admins may
// access any project; session principals are confined to their org (or own
// user id for legacy rows). Returns true/false for filters; require* throws
// a { code:'forbidden' } operational error for route handlers.
function ownsProject(principal, project) {
  if (!principal || !project) return false;
  if (principal.role === 'admin' && principal.source !== 'session') return true;
  if (project.orgId && principal.orgId && project.orgId === principal.orgId) return true;
  if (project.ownerId && principal.id && project.ownerId === principal.id) return true;
  return false;
}

function requireProjectAccess(principal, project) {
  if (!principal) {
    const err = new Error('authentication required');
    err.code = 'unauthenticated';
    throw err;
  }
  if (!project || !ownsProject(principal, project)) {
    const err = new Error('project is not accessible');
    err.code = 'forbidden';
    throw err;
  }
  return project;
}

function quarantineCorrupt(file) {
  try {
    fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
  } catch {}
}

// Postgres rows use camelCase aliases (see infrastructure/postgres.js); the
// file adapter uses the same shape natively. This normalizes both.
function toLocalUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    passwordHash: row.passwordHash || row.password_hash,
    passwordSalt: row.passwordSalt || row.password_salt,
    orgId: row.orgId || row.org_id,
    role: row.role,
    createdAt: row.createdAt || row.created_at,
  };
}

module.exports = { TenantStore, sessionCookie, ownsProject, requireProjectAccess };
