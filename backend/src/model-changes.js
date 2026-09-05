'use strict';

// Bounded, real-only model change log: new models, price/context changes,
// provider degradation. Appended by DiscoveryService; never fabricated.

const fs = require('fs');
const path = require('path');

const MAX_CHANGES = 100;

class ModelChangeLog {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'model-changes.json');
    this._cache = null;
  }

  load() {
    if (this._cache) return this._cache;
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const v = JSON.parse(raw);
      this._cache = Array.isArray(v) ? v : [];
    } catch (e) {
      if (e && e.code !== 'ENOENT') {
        try { fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`); } catch { /* ignore */ }
      }
      this._cache = [];
    }
    return this._cache;
  }

  append(entry) {
    const list = this.load();
    list.push({ ts: new Date().toISOString(), ...entry });
    this._cache = list.slice(-MAX_CHANGES);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(this._cache), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch { /* best-effort */ }
    return entry;
  }
}

module.exports = { ModelChangeLog, MAX_CHANGES };
