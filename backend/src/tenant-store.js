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
    this.users = this.read(this.usersFile);
    this.sessions = this.read(this.sessionsFile);
    this.projects = this.read(this.projectsFile);
  }

  read(file) {
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(value) ? value : [];
    } catch { return []; }
  }

  persist(file, value) {
    try { atomicWrite(file, Array.isArray(value) ? value : []); return true; } catch { return false; }
  }

  signup({ email, password, name } = {}) {
    const normalized = String(email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(normalized)) throw Object.assign(new Error('valid email required'), { code: 'bad_request' });
    if (typeof password !== 'string' || password.length < 12 || password.length > 256) {
      throw Object.assign(new Error('password must be 12 to 256 characters'), { code: 'bad_request' });
    }
    if (this.users.some((u) => u.email === normalized)) throw Object.assign(new Error('email already registered'), { code: 'conflict' });
    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = crypto.scryptSync(password, salt, 64).toString('hex');
    const user = {
      id: `usr-${crypto.randomBytes(8).toString('hex')}`,
      email: normalized,
      name: String(name || normalized.split('@')[0]).slice(0, 80),
      passwordHash, passwordSalt: salt,
      orgId: `org-${crypto.randomBytes(8).toString('hex')}`,
      role: 'admin',
      createdAt: new Date().toISOString(),
    };
    this.users.push(user);
    this.persist(this.usersFile, this.users);
    const project = this.createProject(user, { name: 'My first project' });
    return { user: this.publicUser(user), project };
  }

  publicUser(user) {
    if (!user) return null;
    return { id: user.id, email: user.email, name: user.name, orgId: user.orgId, role: user.role, createdAt: user.createdAt };
  }

  findUser(email) {
    const normalized = String(email || '').trim().toLowerCase();
    return this.users.find((u) => u.email === normalized) || null;
  }

  login({ email, password } = {}) {
    const user = this.findUser(email);
    if (!user || typeof password !== 'string') throw Object.assign(new Error('invalid email or password'), { code: 'unauthenticated' });
    const candidate = crypto.scryptSync(password, user.passwordSalt, 64).toString('hex');
    if (!safeEqual(candidate, user.passwordHash)) throw Object.assign(new Error('invalid email or password'), { code: 'unauthenticated' });
    const raw = crypto.randomBytes(32).toString('base64url');
    this.sessions.push({ hash: hash(raw), userId: user.id, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString() });
    this.persist(this.sessionsFile, this.sessions);
    return { token: raw, user: this.publicUser(user) };
  }

  userForSession(token) {
    if (!token) return null;
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
    this.projects.push(project);
    this.persist(this.projectsFile, this.projects);
    return project;
  }

  listProjects(principal) {
    if (!principal) return [];
    const globalAdmin = principal.role === 'admin' && principal.source !== 'session';
    const rows = this.projects.filter((p) => globalAdmin || p.orgId === principal.orgId || p.ownerId === principal.id);
    return rows.map((p) => ({ ...p }));
  }

  getProject(id, principal) {
    return this.listProjects(principal).find((p) => p.id === id) || null;
  }

  updateProject(id, principal, patch = {}) {
    const project = this.projects.find((p) => p.id === id) || null;
    if (!project || !principal || (principal.source === 'session' && project.orgId !== principal.orgId)) return null;
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

module.exports = { TenantStore, sessionCookie };
