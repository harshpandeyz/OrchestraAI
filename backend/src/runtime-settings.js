'use strict';

// Installation runtime defaults (user-facing, persisted).
// Stored in <dataDir>/runtime-settings.json. These are defaults for NEW runs;
// per-run overrides apply at creation and never mutate these.

const fs = require('fs');
const path = require('path');
const { validPreset } = require('./policies/presets');

const DEFAULTS = {
  defaultPreset: 'balanced',
  defaultBudgetUsd: 0.5,
  maxSteps: 12,
  allowSwitching: true,
  allowCompaction: true,
  toolPolicy: 'auto', // 'auto' | 'readonly' — readonly blocks mutating tools
  qualityFloor: null,
  latencyTargetMs: null,
  hardBudget: false,
};

function sanitize(input, base) {
  const out = { ...(base || DEFAULTS) };
  if (!input || typeof input !== 'object') return out;
  if (typeof input.defaultPreset === 'string' && validPreset(input.defaultPreset)) {
    out.defaultPreset = input.defaultPreset.toLowerCase();
  }
  if (Number.isFinite(Number(input.defaultBudgetUsd))) {
    out.defaultBudgetUsd = Math.max(0, Math.min(1000, Number(input.defaultBudgetUsd)));
  }
  if (Number.isFinite(Number(input.maxSteps))) {
    out.maxSteps = Math.max(1, Math.min(50, Math.floor(Number(input.maxSteps))));
  }
  if (typeof input.allowSwitching === 'boolean') out.allowSwitching = input.allowSwitching;
  if (typeof input.allowCompaction === 'boolean') out.allowCompaction = input.allowCompaction;
  if (input.toolPolicy === 'auto' || input.toolPolicy === 'readonly') out.toolPolicy = input.toolPolicy;
  if (input.qualityFloor === null || input.qualityFloor === '') out.qualityFloor = null;
  else if (Number.isFinite(Number(input.qualityFloor))) out.qualityFloor = Math.max(0, Math.min(1, Number(input.qualityFloor)));
  if (input.latencyTargetMs === null || input.latencyTargetMs === '') out.latencyTargetMs = null;
  else if (Number.isFinite(Number(input.latencyTargetMs))) out.latencyTargetMs = Math.max(1000, Math.min(3600000, Math.floor(Number(input.latencyTargetMs))));
  if (typeof input.hardBudget === 'boolean') out.hardBudget = input.hardBudget;
  return out;
}

class RuntimeSettings {
  constructor(dataDir, options = {}) {
    this.file = path.join(dataDir, 'runtime-settings.json');
    this.log = options.logger || null;
    this._cache = null;
  }

  load() {
    if (this._cache) return this._cache;
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      this._cache = sanitize(JSON.parse(raw));
    } catch (e) {
      if (e && e.code !== 'ENOENT') {
        try {
          if (this.log && this.log.warn) this.log.warn('runtime settings corrupt, using defaults');
          fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
        } catch { /* ignore */ }
      }
      this._cache = { ...DEFAULTS };
    }
    return this._cache;
  }

  save(patch) {
    const next = sanitize({ ...this.load(), ...patch }, this.load());
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
    this._cache = next;
    return next;
  }
}

module.exports = { RuntimeSettings, DEFAULTS, sanitize };
