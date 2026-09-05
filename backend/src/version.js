'use strict';

// Single authoritative version source: package.json.
// Do not maintain version literals anywhere else (server.js, docs, health).

const fs = require('fs');
const path = require('path');

let cached = null;

function appVersion() {
  if (cached) return cached;
  try {
    const pkgPath = path.resolve(__dirname, '..', '..', 'package.json');
    const raw = fs.readFileSync(pkgPath, 'utf8');
    const pkg = JSON.parse(raw);
    cached = String(pkg.version || '0.0.0');
  } catch {
    cached = '0.0.0';
  }
  return cached;
}

module.exports = { appVersion };
