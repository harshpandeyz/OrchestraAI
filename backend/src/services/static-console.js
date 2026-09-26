'use strict';

// Production console static server (frontend/dist).
//
// `npm run build` (frontend) + Docker both produce frontend/dist. When it is
// present the runtime also serves the console itself, so one process is the
// whole deployable product (:8787 serves UI + API). Dev keeps using Vite.
//
// Traversal-proof, no directory listing, SPA fallback to index.html for
// non-/api routes. GET/HEAD only.

const fs = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

// Resolve the built console directory (frontend/dist). Returns the resolved
// path plus whether an index.html actually exists (so callers can disable the
// static server cleanly when the console was not built into the image).
function resolveConsoleRoot(appRoot) {
  const dist = path.resolve(appRoot, 'frontend', 'dist');
  let ok = false;
  try {
    ok = fs.existsSync(path.join(dist, 'index.html'));
  } catch {
    ok = false;
  }
  return { dist, ok };
}

// Create a static-console request handler bound to a resolved dist directory
// and a mode/secure flag so security headers match the API's. Returns `true`
// when it handled the request, else `false` (caller falls through).
function createConsoleHandler({ dist, enabled, securityHeaders, cors = {} }) {
  const corsFor = typeof cors === 'function' ? cors : () => cors;
  return function serveConsole(req, res, pathname) {
    if (!enabled || (req.method !== 'GET' && req.method !== 'HEAD')) return false;
    if (pathname.startsWith('/api/')) return false;
    let rel;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      return false;
    }
    if (rel === '/' || rel === '') rel = '/index.html';
    // Traversal guard: resolve inside DIST_DIR only.
    const resolved = path.normalize(path.join(dist, rel));
    if (resolved !== dist && !resolved.startsWith(dist + path.sep)) return false;
    let file = resolved;
    try {
      const st = fs.statSync(file);
      if (st.isDirectory()) file = path.join(file, 'index.html');
    } catch {
      // SPA fallback: unknown non-asset routes serve the console shell.
      if (!path.extname(resolved)) file = path.join(dist, 'index.html');
      else return false;
    }
    let data;
    try {
      data = fs.readFileSync(file);
    } catch {
      return false;
    }
    const headers = {
      ...securityHeaders(),
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
      ...(corsFor(req) || {}),
    };
    res.writeHead(200, headers);
    if (req.method === 'GET') res.end(data);
    else res.end();
    return true;
  };
}

module.exports = { resolveConsoleRoot, createConsoleHandler, MIME };