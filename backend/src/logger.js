'use strict';

// Minimal structured logger. Every line is JSON with runId/taskId/stepId when
// known. Secrets are redacted. Full prompt context is never logged — only token
// counts and hashes.

const { redact } = require('./config');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function createLogger(options = {}) {
  const levelName = (options.level || process.env.LOG_LEVEL || 'info').toLowerCase();
  const threshold = LEVELS[levelName] ?? LEVELS.info;
  const sink = options.sink || ((line) => process.stdout.write(line + '\n'));

  function log(level, msg, fields = {}) {
    if ((LEVELS[level] ?? 20) < threshold) return;
    const safe = {};
    for (const [k, v] of Object.entries(fields)) {
      if (/key|secret|credential|authorization|prompt|context|content/i.test(k)) {
        safe[k] = '[REDACTED]';
      } else if (typeof v === 'string') {
        safe[k] = redact(v).slice(0, 2000);
      } else {
        safe[k] = v;
      }
    }
    sink(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...safe }));
  }

  return {
    debug: (msg, fields) => log('debug', msg, fields),
    info: (msg, fields) => log('info', msg, fields),
    warn: (msg, fields) => log('warn', msg, fields),
    error: (msg, fields) => log('error', msg, fields),
    child: (extra) => createLogger({
      level: levelName,
      sink: (line) => sink(line),
    }),
  };
}

module.exports = { createLogger };
