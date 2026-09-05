'use strict';

// Demo / production boundary: backend/demo/ is historical reference material.
// It must parse cleanly (no broken JS beside production code) and production
// code must never import it (it is also excluded from the Docker image).
//
// Run: node backend/test/demo-boundary.test.js (no network)

process.env.RUNTIME_MODE = 'demo';
process.env.LOG_LEVEL = 'error';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`✗ ${name}: ${e && e.stack ? String(e.stack).split('\n').slice(0, 4).join(' | ') : (e && e.message)}`);
    failed++;
  }
}

async function main() {
  await test('production code never imports demo code; demo parses cleanly', () => {
    const root = path.join(__dirname, '..');
    const prodFiles = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.runtime-data')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { if (entry.name !== 'demo') walk(full); }
        else if (entry.name.endsWith('.js')) prodFiles.push(full);
      }
    };
    walk(path.join(root, 'src'));
    for (const f of ['server.js', 'data.js']) {
      if (fs.existsSync(path.join(root, f))) prodFiles.push(path.join(root, f));
    }
    const offenders = prodFiles.filter((f) => {
      const text = fs.readFileSync(f, 'utf8');
      return /require\(['"][^'"]*demo\//.test(text) || /from\s+['"][^'"]*demo\//.test(text);
    });
    assert.deepStrictEqual(offenders, [], 'no production file may import backend/demo/');
    for (const f of fs.readdirSync(path.join(root, 'demo')).filter((n) => n.endsWith('.js'))) {
      execFileSync('node', ['--check', path.join(root, 'demo', f)], { stdio: 'ignore' });
    }
  });
}

main().then(() => {
  console.log(`\n--- Demo-boundary results: ${passed} passed, ${failed} failed ---`);
  process.exit(failed ? 1 : 0);
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
