'use strict';

// Encrypted-at-rest provider credential store.
//
// The frontend never owns provider secrets: keys are POSTed once to the
// backend, encrypted with an installation-specific key, and persisted to
// <dataDir>/provider-credentials.json. Only presence metadata (configured,
// last verified, masked suffix) ever leaves the backend.
//
// Encryption: AES-256-GCM, one random IV per secret. The installation key
// lives at <dataDir>/.install-key (0600, generated once with CSPRNG).
// Nothing is hardcoded and the key is never derivable from a provider key.
//
// Failure handling: a missing key file generates one; a corrupted store is
// quarantined to *.corrupt-<ts> and the store starts empty (reported, never
// silently poisoning reads). Writes are atomic (tmp + rename).

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { redact } = require('../config');

const SUPPORTED_PROVIDERS = ['openrouter', 'openai', 'anthropic'];

function parseEncryptionKey(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');
  try {
    const key = Buffer.from(raw, 'base64');
    return key.length === 32 ? key : null;
  } catch { return null; }
}

function maskKey(key) {
  if (!key || key.length < 4) return '••••';
  return `••••${key.slice(-4)}`;
}

class CredentialStore {
  constructor(dataDir, options = {}) {
    this.dataDir = dataDir;
    this.log = options.logger || null;
    this.file = path.join(dataDir, 'provider-credentials.json');
    this.keyFile = path.join(dataDir, '.install-key');
    this.encryptionKey = options.encryptionKey || '';
    this.requireEncryptionKey = !!options.requireEncryptionKey;
    if (this.requireEncryptionKey && !parseEncryptionKey(this.encryptionKey)) {
      throw Object.assign(new Error('DATA_ENCRYPTION_KEY is required in production and must be 32 bytes (64 hex characters or base64)'), { code: 'config' });
    }
    this._key = null;
    this._cache = null; // { version, providers: { id: record } }
  }

  _warn(msg, extra) {
    try {
      if (this.log && typeof this.log.warn === 'function') this.log.warn(msg, extra || {});
    } catch { /* ignore */ }
  }

  _ensureDir() {
    fs.mkdirSync(this.dataDir, { recursive: true });
  }

  // Installation key: generated once, reused afterwards. 0600 best-effort.
  _installKey() {
    if (this._key) return this._key;
    this._ensureDir();
    if (this.encryptionKey) {
      const key = parseEncryptionKey(this.encryptionKey);
      if (key && key.length === 32) {
        this._key = key;
        return this._key;
      }
      if (this.requireEncryptionKey) {
        throw Object.assign(new Error('DATA_ENCRYPTION_KEY must be 32 bytes (64 hex characters or base64)'), { code: 'config' });
      }
      this._warn('DATA_ENCRYPTION_KEY is invalid; using the local install key only');
    } else if (this.requireEncryptionKey) {
      throw Object.assign(new Error('DATA_ENCRYPTION_KEY is required in production'), { code: 'config' });
    }
    try {
      const raw = fs.readFileSync(this.keyFile, 'utf8').trim();
      if (/^[0-9a-f]{64}$/i.test(raw)) {
        this._key = Buffer.from(raw, 'hex');
        return this._key;
      }
      this._warn('install key malformed, regenerating');
    } catch (e) {
      if (!e || e.code !== 'ENOENT') this._warn('install key read failed', { error: String((e && e.message) || e).slice(0, 120) });
    }
    const fresh = crypto.randomBytes(32);
    try {
      fs.writeFileSync(this.keyFile, fresh.toString('hex'), { mode: 0o600 });
      try { fs.chmodSync(this.keyFile, 0o600); } catch { /* non-posix */ }
    } catch (e) {
      this._warn('install key write failed', { error: String((e && e.message) || e).slice(0, 120) });
    }
    this._key = fresh;
    return this._key;
  }

  _encrypt(plaintext) {
    const key = this._installKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    return { iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), data: data.toString('hex') };
  }

  _decrypt(enc) {
    const key = this._installKey();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(enc.iv, 'hex'));
    decipher.setAuthTag(Buffer.from(enc.tag, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(enc.data, 'hex')), decipher.final()]).toString('utf8');
  }

  _load() {
    if (this._cache) return this._cache;
    let doc = { version: 1, providers: {} };
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      doc = JSON.parse(raw);
      if (!doc || typeof doc !== 'object' || !doc.providers || typeof doc.providers !== 'object') {
        throw new Error('bad credential store shape');
      }
    } catch (e) {
      if (e && e.code === 'ENOENT') {
        this._cache = doc;
        return this._cache;
      }
      // Corrupted store: quarantine, start empty, report. Never lose silently
      // without a trace — the quarantine file preserves the bytes.
      try {
        fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
      } catch { /* ignore */ }
      this._warn('credential store corrupt, quarantined; starting empty');
      this._cache = { version: 1, providers: {}, corrupted: true };
      return this._cache;
    }
    this._cache = doc;
    return this._cache;
  }

  _scopeKey(scope) {
    const value = String(scope || 'default').trim();
    return value && value.length <= 128 ? value : 'default';
  }

  _bucket(doc, scope = 'default', create = false) {
    const key = this._scopeKey(scope);
    // `providers` is the backwards-compatible deployment/bootstrap namespace.
    if (key === 'default') {
      if (!doc.providers || typeof doc.providers !== 'object') doc.providers = {};
      return doc;
    }
    if (!doc.scopes || typeof doc.scopes !== 'object') {
      if (!create) return { providers: {} };
      doc.scopes = {};
    }
    if (!doc.scopes[key]) {
      if (!create) return { providers: {} };
      doc.scopes[key] = { providers: {} };
    }
    if (!doc.scopes[key].providers || typeof doc.scopes[key].providers !== 'object') doc.scopes[key].providers = {};
    return doc.scopes[key];
  }

  _save() {
    this._ensureDir();
    const tmp = `${this.file}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tmp, JSON.stringify(this._cache), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  static supportedProviders() {
    return [...SUPPORTED_PROVIDERS];
  }

  static validProvider(id) {
    return SUPPORTED_PROVIDERS.includes(String(id || '').toLowerCase());
  }

  // Presence + health metadata only. Never secrets.
  listMeta(scope = 'default') {
    return SUPPORTED_PROVIDERS.map((id) => this.metaFor(id, scope));
  }

  metaFor(providerId, scope = 'default') {
    const id = String(providerId || '').toLowerCase();
    const doc = this._load();
    const rec = this._bucket(doc, scope).providers[id];
    return {
      id,
      configured: !!rec,
      keyMasked: rec ? maskKey(this._peekSuffix(rec)) : null,
      source: rec ? 'stored' : null, // 'stored' | null; env fallback resolved by caller
      updatedAt: (rec && rec.updatedAt) || null,
      lastVerifiedAt: (rec && rec.lastVerifiedAt) || null,
      lastStatus: (rec && rec.lastStatus) || null,
      lastError: rec && rec.lastError ? redact(rec.lastError) : null,
      lastLatencyMs: rec && Number.isFinite(rec.lastLatencyMs) ? rec.lastLatencyMs : null,
      modelCount: rec && Number.isFinite(rec.modelCount) ? rec.modelCount : null,
    };
  }

  _peekSuffix(rec) {
    // Suffix is stored alongside the ciphertext for masked display only.
    return (rec && rec.suffix) || '••••';
  }

  hasStored(providerId, scope = 'default') {
    const doc = this._load();
    return !!this._bucket(doc, scope).providers[String(providerId || '').toLowerCase()];
  }

  hasAnyStored(providerId) {
    const id = String(providerId || '').toLowerCase();
    const doc = this._load();
    if (doc.providers?.[id]) return true;
    return Object.values(doc.scopes || {}).some((scope) => !!scope?.providers?.[id]);
  }

  getKey(providerId, scope = 'default') {
    const doc = this._load();
    const rec = this._bucket(doc, scope).providers[String(providerId || '').toLowerCase()];
    if (!rec || !rec.enc) return '';
    try {
      return this._decrypt(rec.enc);
    } catch (e) {
      this._warn('credential decrypt failed', { provider: String(providerId).slice(0, 32) });
      return '';
    }
  }

  setKey(providerId, apiKey, scope = 'default') {
    const id = String(providerId || '').toLowerCase();
    if (!CredentialStore.validProvider(id)) throw Object.assign(new Error('unsupported provider'), { code: 'bad_provider' });
    if (typeof apiKey !== 'string' || apiKey.length < 8 || apiKey.length > 500) {
      throw Object.assign(new Error('API key must be 8–500 characters'), { code: 'bad_key' });
    }
    const doc = this._load();
    const bucket = this._bucket(doc, scope, true);
    const previous = bucket.providers[id] || {};
    bucket.providers[id] = {
      enc: this._encrypt(apiKey),
      suffix: apiKey.slice(-4),
      updatedAt: new Date().toISOString(),
      lastVerifiedAt: previous.lastVerifiedAt || null,
      lastStatus: previous.lastStatus || null,
      lastError: null,
      lastLatencyMs: previous.lastLatencyMs || null,
      modelCount: previous.modelCount || null,
    };
    this._save();
    return this.metaFor(id, scope);
  }

  recordVerification(providerId, result = {}, scope = 'default') {
    const id = String(providerId || '').toLowerCase();
    const doc = this._load();
    const rec = this._bucket(doc, scope).providers[id];
    if (!rec) return null;
    rec.lastVerifiedAt = result.ok ? new Date().toISOString() : rec.lastVerifiedAt;
    rec.lastCheckedAt = new Date().toISOString();
    rec.lastStatus = result.ok ? 'connected' : 'failed';
    rec.lastError = result.ok ? null : redact(String(result.error || result.code || 'verification failed')).slice(0, 300);
    rec.lastLatencyMs = Number.isFinite(result.latencyMs) ? Math.round(result.latencyMs) : rec.lastLatencyMs;
    rec.modelCount = Number.isFinite(result.modelCount) ? result.modelCount : rec.modelCount;
    this._save();
    return this.metaFor(id, scope);
  }

  remove(providerId, scope = 'default') {
    const id = String(providerId || '').toLowerCase();
    const doc = this._load();
    const bucket = this._bucket(doc, scope, false);
    const existed = !!bucket.providers[id];
    delete bucket.providers[id];
    this._save();
    return existed;
  }

  wasCorrupted() {
    return !!this._load().corrupted;
  }
}

module.exports = { CredentialStore, SUPPORTED_PROVIDERS, maskKey };
