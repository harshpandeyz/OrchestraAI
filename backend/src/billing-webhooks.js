'use strict';

const crypto = require('crypto');

// Stripe-compatible signature verification without adding a runtime SDK
// dependency. The raw request body is signed as `${timestamp}.${payload}`.
// Webhook consumers should still treat the event as untrusted input.
function verifyStripeSignature(payload, header, secret, options = {}) {
  if (!secret) return { ok: false, code: 'not_configured' };
  if (typeof payload !== 'string' || typeof header !== 'string') return { ok: false, code: 'invalid_signature' };
  const parts = header.split(',').map((part) => part.trim());
  const timestamp = Number((parts.find((part) => part.startsWith('t=')) || '').slice(2));
  const signatures = parts.filter((part) => part.startsWith('v1=')).map((part) => part.slice(3)).filter(Boolean);
  if (!Number.isFinite(timestamp) || signatures.length === 0) return { ok: false, code: 'invalid_signature' };
  const now = Number.isFinite(options.now) ? options.now : Math.floor(Date.now() / 1000);
  const tolerance = Number.isFinite(options.toleranceSec) ? Math.max(0, options.toleranceSec) : 300;
  if (tolerance > 0 && Math.abs(now - timestamp) > tolerance) return { ok: false, code: 'stale_signature' };
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${payload}`, 'utf8').digest('hex');
  const matches = signatures.some((candidate) => {
    const left = Buffer.from(candidate, 'utf8');
    const right = Buffer.from(expected, 'utf8');
    return left.length === right.length && crypto.timingSafeEqual(left, right);
  });
  return matches ? { ok: true, timestamp } : { ok: false, code: 'invalid_signature' };
}

function eventMetadata(event, receivedAt = new Date().toISOString()) {
  return {
    eventId: typeof event?.id === 'string' ? event.id.slice(0, 200) : null,
    type: typeof event?.type === 'string' ? event.type.slice(0, 200) : null,
    created: Number.isFinite(Number(event?.created)) ? Number(event.created) : null,
    livemode: event?.livemode === true,
    apiVersion: typeof event?.api_version === 'string' ? event.api_version.slice(0, 80) : null,
    receivedAt,
  };
}

module.exports = { verifyStripeSignature, eventMetadata };
