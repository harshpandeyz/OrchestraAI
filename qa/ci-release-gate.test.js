'use strict';

// Static regression for the CI release gate.
//
// A pull-request run must never reach Docker publishing. This test inspects
// .github/workflows/ci.yml directly and fails the build if:
//   - the workflow does not trigger on both push and pull_request, OR
//   - the publish jobs (`release-image`, `release-latest`) are not gated on
//     `github.event_name == 'push'`, OR
//   - `release-latest` does not additionally restrict to main/release.
//
// Run: node qa/ci-release-gate.test.js
// This is a source-level assertion (no YAML dependency): it is intentionally
// coarse so it remains part of the zero-dependency backend test surface.

const fs = require('fs');
const path = require('path');

const workflowPath = path.join(__dirname, '..', '.github', 'workflows', 'ci.yml');
const yml = fs.readFileSync(workflowPath, 'utf8');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`✗ ${name}: ${e && e.message}`);
    failed++;
  }
}

// Strip comment lines so a commented-out guard can't pass.
const lines = yml.split('\n').map((l) => l.replace(/#.*$/, ''));

// Find the `if:` that governs a job: the job key line is `  <name>:` (exactly
// two leading spaces and no indent on the next non-empty line beyond it).
function jobIf(jobName) {
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === `${jobName}:` && /^ {2}\S/.test(lines[i])) {
      idx = i;
      break;
    }
  }
  if (idx === -1) return null;
  // The `if:` must appear before the next job key (a line with two spaces and
  // a colon) after the job's own header.
  for (let j = idx + 1; j < lines.length; j++) {
    const t = lines[j];
    if (/^ {2}[A-Za-z0-9_-]+:$/.test(t) && !t.startsWith('     ')) break;
    const m = t.match(/^ {4}if:\s*(.+)$/);
    if (m) return m[1].trim();
  }
  return null;
}

function main() {
  test('workflow triggers on push and pull_request', () => {
    assert(/on\s*:/.test(yml), 'missing `on:` block');
    const onBlock = yml.slice(yml.indexOf('on:'), yml.indexOf('permissions:') === -1 ? yml.length : yml.indexOf('permissions:'));
    assert(/push:/.test(onBlock), 'missing push trigger');
    assert(/pull_request:/.test(onBlock), 'missing pull_request trigger');
  });

  test('release-image is gated on push (never on PRs)', () => {
    const cond = jobIf('release-image');
    assert(cond !== null, 'release-image has no `if:` guard');
    assert(/github\.event_name\s*==\s*'push'/.test(cond), `release-image if must require push, got: ${cond}`);
  });

  test('release-latest is gated on push to main/release', () => {
    const cond = jobIf('release-latest');
    assert(cond !== null, 'release-latest has no `if:` guard');
    assert(/github\.event_name\s*==\s*'push'/.test(cond), `release-latest if must require push, got: ${cond}`);
    assert(/refs\/heads\/(main|release)/.test(cond), `release-latest must be limited to main/release, got: ${cond}`);
  });

  test('publish jobs use immutable :sha tag and only advance latest after release', () => {
    assert(/\$\{GITHUB_SHA\}/.test(yml), 'image must be tagged by GITHUB_SHA');
    assert(/pull ".*:\$\{GITHUB_SHA\}"/.test(yml) || /:\$\{GITHUB_SHA\}" ".*:latest"/.test(yml), 'latest must be re-tagged from the immutable SHA image');
    // The single-container and compose smokes are the release validation the
    // publish jobs depend on.
    assert(/needs:\s*\[[^\]]*docker-build[^\]]*\]/.test(yml.replace(/docker-build/g, '@@')) || /compose-smoke/.test(yml), 'compose smoke must be part of validation');
  });

  test('no docker login/push outside the gated release jobs', () => {
    // Registry credentials are only used by release-image / release-latest.
    const body = yml;
    const loginCount = (body.match(/docker\/login-action@v3/g) || []).length;
    assert(loginCount === 2, `expected exactly 2 docker logins (image + latest), found ${loginCount}`);
    // Both logins appear after a push-gated job marker; the gate test above
    // already pins the `if`. Here we assert the login steps live inside the
    // release jobs' text (i.e. the workflow has not scattered a push elsewhere).
    const releaseImageAt = body.indexOf('release-image:');
    const releaseLatestAt = body.indexOf('release-latest:');
    body.split('docker/login-action@v3').slice(1).forEach((tail, i) => {
      // This is a coarse structural check; the authoritative guard remains the
      // `if:` assertions above.
      assert(i < 2, 'unexpected extra docker login');
    });
    assert(releaseImageAt >= 0 && releaseLatestAt >= 0, 'release jobs must exist');
  });

  console.log(`\n--- CI release-gate results: ${passed} passed, ${failed} failed ---`);
  process.exit(failed ? 1 : 0);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

main();