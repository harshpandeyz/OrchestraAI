'use strict';

// Privacy is enforced at the serialization boundary, not only in project
// settings. Runtime code may need the original prompt to complete a request;
// persisted/API representations must obey the project's retention mode.

const MODES = new Set(['metadata_only', 'standard', 'zero_retention']);
const REDACTED = '[REDACTED_BY_PRIVACY]';
const CONTENT_KEYS = new Set([
  'content', 'text', 'full', 'delta', 'prompt', 'query', 'userText',
  'userMessage', 'snippet', 'raw', 'result', 'output', 'stdout', 'stderr',
  'arguments', 'input', 'messages', 'memory', 'contextItems', 'compressedItems',
  'discardedItems', 'working', 'longterm', 'message', 'description', 'objective',
  'goal', 'sourceTask', 'providerMetadata', 'providerPayload', 'responseBody',
]);
const SECRET_KEYS = /api[_-]?key|authorization|bearer|secret|password|session[_-]?token|access[_-]?token|refresh[_-]?token/i;

function normalizePrivacyMode(mode) {
  return MODES.has(mode) ? mode : 'standard';
}

function clone(value) {
  if (value === undefined) return undefined;
  try { return JSON.parse(JSON.stringify(value)); } catch { return null; }
}

function sanitize(value, mode, key = '') {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return mode === 'standard' || !CONTENT_KEYS.has(key) ? value : REDACTED;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => sanitize(item, mode, key));

  const out = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    if (SECRET_KEYS.test(childKey)) {
      out[childKey] = REDACTED;
    } else if (mode !== 'standard' && CONTENT_KEYS.has(childKey)) {
      // Keep a bounded shape marker for diagnostics without retaining content.
      out[childKey] = Array.isArray(childValue) ? [] : REDACTED;
    } else {
      out[childKey] = sanitize(childValue, mode, childKey);
    }
  }
  return out;
}

function persistedEvents(events, mode) {
  const normalized = normalizePrivacyMode(mode);
  if (normalized === 'zero_retention') return [];
  return (Array.isArray(events) ? events : []).map((event) => sanitize(clone(event), normalized));
}

function persistedSnapshot(snapshot, mode) {
  const normalized = normalizePrivacyMode(mode);
  if (!snapshot || typeof snapshot !== 'object') return null;
  const out = sanitize(clone(snapshot), normalized);
  if (normalized !== 'standard') {
    out.messages = [];
    out.memory = { working: [], longterm: [] };
  }
  if (normalized === 'zero_retention') {
    // Zero retention keeps the economic and operational ledger, while
    // removing trace/message/context/memory payloads that could reconstruct
    // customer content.
    out.trace = [];
    out.context = out.context && typeof out.context === 'object'
      ? { usedTokens: out.context.usedTokens || 0, windowTokens: out.context.windowTokens || 0, segments: out.context.segments || [], items: [] }
      : { usedTokens: 0, windowTokens: 0, segments: [], items: [] };
    out.memory = { working: [], longterm: [] };
    out.execution = out.execution && typeof out.execution === 'object'
      ? { status: out.execution.status || null, currentAction: out.execution.currentAction || null, pause: out.execution.pause || null }
      : null;
  }
  return out;
}

function persistedRunSummary(summary, mode) {
  const normalized = normalizePrivacyMode(mode);
  const out = sanitize(clone(summary), normalized);
  if (normalized === 'zero_retention' && out) out.title = 'Private run';
  return out;
}

module.exports = {
  MODES: Array.from(MODES),
  REDACTED,
  normalizePrivacyMode,
  persistedEvents,
  persistedSnapshot,
  persistedRunSummary,
  sanitize,
};
