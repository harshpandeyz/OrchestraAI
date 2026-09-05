'use strict';

// Session 1 — consistent internal error taxonomy.
//
// Every failure carries a stable `code` so Sessions 2/3 (routing, evaluation,
// recovery) can branch on semantics instead of string-matching messages.
// API mapping is centralized here: internal code -> HTTP status + public code.
//
// Never include secrets, keys, or stack traces in `message`. Messages are
// safe to surface to clients; details stay server-side in logs.

class OrchestraError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = options.code || 'internal';
    this.status = options.status ?? 500;
    this.retryable = !!options.retryable;
    this.runId = options.runId || null;
    this.cause = options.cause || null;
  }

  toSafeJSON(requestId) {
    return {
      error: String(this.message || 'internal error').slice(0, 500),
      code: this.code,
      ...(requestId ? { requestId } : {}),
    };
  }
}

class ConfigurationError extends OrchestraError {
  constructor(message = 'invalid configuration', options = {}) {
    super(message, { code: 'configuration', status: 500, ...options });
  }
}
class AuthenticationError extends OrchestraError {
  constructor(message = 'authentication required', options = {}) {
    super(message, { code: 'unauthenticated', status: 401, ...options });
  }
}
class AuthorizationError extends OrchestraError {
  constructor(message = 'forbidden', options = {}) {
    super(message, { code: 'forbidden', status: 403, ...options });
  }
}
class ValidationError extends OrchestraError {
  constructor(message = 'invalid request', options = {}) {
    super(message, { code: 'bad_request', status: 400, ...options });
  }
}
class NotFoundError extends OrchestraError {
  constructor(message = 'not found', options = {}) {
    super(message, { code: 'not_found', status: 404, ...options });
  }
}
class ConflictError extends OrchestraError {
  constructor(message = 'conflict', options = {}) {
    super(message, { code: 'conflict', status: 409, ...options });
  }
}
class TerminalStateError extends OrchestraError {
  constructor(message = 'run is in a terminal state', options = {}) {
    super(message, { code: 'terminal', status: 409, ...options });
  }
}
class BusyError extends OrchestraError {
  constructor(message = 'run is already executing', options = {}) {
    super(message, { code: 'busy', status: 409, ...options });
  }
}
class ProviderErrorBase extends OrchestraError {
  constructor(message = 'provider error', options = {}) {
    super(message, { code: 'provider_error', status: 502, retryable: false, ...options });
  }
}
class ProviderRateLimitError extends ProviderErrorBase {
  constructor(message = 'provider rate limit exceeded', options = {}) {
    super(message, { code: 'rate_limit', status: 429, retryable: true, ...options });
  }
}
class ProviderTimeoutError extends ProviderErrorBase {
  constructor(message = 'provider request timed out', options = {}) {
    super(message, { code: 'timeout', status: 504, retryable: true, ...options });
  }
}
class ProviderAuthError extends ProviderErrorBase {
  constructor(message = 'provider authentication failed', options = {}) {
    super(message, { code: 'auth', status: 502, retryable: false, ...options });
  }
}
class ContextLimitError extends OrchestraError {
  constructor(message = 'context limit exceeded', options = {}) {
    super(message, { code: 'context_exhausted', status: 422, ...options });
  }
}
class ToolError extends OrchestraError {
  constructor(message = 'tool execution failed', options = {}) {
    super(message, { code: 'tool_error', status: 422, ...options });
  }
}
class PersistenceError extends OrchestraError {
  constructor(message = 'persistence failed', options = {}) {
    super(message, { code: 'persistence', status: 500, ...options });
  }
}
class CancellationError extends OrchestraError {
  constructor(message = 'cancelled', options = {}) {
    super(message, { code: 'cancelled', status: 409, ...options });
  }
}
class BudgetExceededError extends OrchestraError {
  constructor(message = 'budget exceeded', options = {}) {
    super(message, { code: 'budget_exceeded', status: 422, ...options });
  }
}
class StepLimitExceededError extends OrchestraError {
  constructor(message = 'step limit exceeded', options = {}) {
    super(message, { code: 'step_limit', status: 422, ...options });
  }
}

// Map legacy / provider-adapter error codes to HTTP status for the API layer.
// Provider adapter already emits codes: auth, rate_limit, bad_request,
// not_found, unavailable, timeout, cancelled, unknown.
function statusForCode(code) {
  switch (String(code || '')) {
    case 'unauthenticated': return 401;
    case 'forbidden': return 403;
    case 'bad_request':
    case 'invalid_json':
    case 'bad_params':
    case 'bad_key':
    case 'bad_provider':
      return 400;
    case 'not_found': return 404;
    case 'busy':
    case 'terminal':
    case 'retry_rejected':
    case 'cancelled':
    case 'conflict': return 409;
    case 'payload_too_large': return 413;
    case 'auth': return 502; // provider auth surfaces as 502 except verify path (401)
    case 'rate_limit': return 429;
    case 'timeout': return 504;
    case 'budget_exceeded':
    case 'step_limit':
    case 'context_exhausted':
    case 'tool_budget':
    case 'tool_error':
    case 'no_models': return 422;
    case 'method_not_allowed': return 405;
    default: return 500;
  }
}

module.exports = {
  OrchestraError,
  ConfigurationError,
  AuthenticationError,
  AuthorizationError,
  ValidationError,
  NotFoundError,
  ConflictError,
  TerminalStateError,
  BusyError,
  ProviderErrorBase,
  ProviderRateLimitError,
  ProviderTimeoutError,
  ProviderAuthError,
  ContextLimitError,
  ToolError,
  PersistenceError,
  CancellationError,
  BudgetExceededError,
  StepLimitExceededError,
  statusForCode,
};
