'use strict';

// Session 3 — Tool capability framework.
//
// A clean capability abstraction over the Session-1 ToolRegistry contract.
// Session 1 owns persistence/auth/provider/API; this module owns the agent
// execution view of tools: categories, risk, permissions, timeouts,
// dry-run/idempotency metadata, normalized results, output limits, artifacts.
//
// Backward compatible: plain Session-1 tool records ({name, description,
// parameters, status, ...}) are accepted and normalized with safe defaults.

const crypto = require('crypto');

const ToolCategory = Object.freeze({
  FILESYSTEM: 'filesystem',
  SEARCH: 'search',
  CODE: 'code',
  TESTING: 'testing',
  GIT: 'git',
  ENVIRONMENT: 'environment',
  NETWORK: 'network',
  BROWSER: 'browser',
  DEPLOYMENT: 'deployment',
});

const RiskLevel = Object.freeze({
  LOW: 'LOW',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
  CRITICAL: 'CRITICAL',
});

const RISK_ORDER = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };

const ToolStatus = Object.freeze({
  SUCCESS: 'success',
  FAILURE: 'failure',
  TIMED_OUT: 'timed_out',
  CANCELLED: 'cancelled',
  DISABLED: 'disabled',
  DENIED: 'denied',
  NEEDS_APPROVAL: 'needs_approval',
  UNKNOWN: 'unknown',
});

// Delivery semantics — honest, per tool. Exactly-once is NOT claimed unless
// the underlying side effect supports it.
const DeliverySemantics = Object.freeze({
  AT_MOST_ONCE: 'at-most-once',
  AT_LEAST_ONCE: 'at-least-once',
  IDEMPOTENT: 'idempotent',
  UNKNOWN: 'unknown',
});

const DEFAULTS = {
  maxOutputBytes: 24 * 1024,
  maxLines: 400,
  maxArtifacts: 8,
  timeoutMs: 30000,
};

// Canonical tool definitions shipped with the runtime. The framework is ready
// for all categories; only safe, sandboxed tools are enabled by default.
// High-risk tools (push/deploy/browser automation) exist as definitions with
// requiresApproval + disabled status so policy can gate them explicitly.
const TOOL_DEFINITIONS = [
  {
    id: 'tool-read-file', name: 'read_file', category: ToolCategory.FILESYSTEM,
    description: 'Read a workspace file with line ranges (sandboxed)',
    riskLevel: RiskLevel.LOW, permissions: ['workspace:read'],
    timeoutMs: 10000, supportsDryRun: false, idempotent: true,
    requiresApproval: false, delivery: DeliverySemantics.AT_MOST_ONCE,
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, startLine: { type: 'number' }, endLine: { type: 'number' }, maxBytes: { type: 'number' } }, required: ['path'] },
  },
  {
    id: 'tool-search-code', name: 'search_code', category: ToolCategory.SEARCH,
    description: 'Bounded code search over the workspace',
    riskLevel: RiskLevel.LOW, permissions: ['workspace:read'],
    timeoutMs: 15000, supportsDryRun: false, idempotent: true,
    requiresApproval: false, delivery: DeliverySemantics.AT_MOST_ONCE,
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, include: { type: 'string' }, maxResults: { type: 'number' }, excludeDir: { type: 'array' } }, required: ['query'] },
  },
  {
    id: 'tool-run-tests', name: 'run_tests', category: ToolCategory.TESTING,
    description: 'Execute an allowlisted test/build/lint command (no shell)',
    riskLevel: RiskLevel.LOW, permissions: ['tests:execute'],
    timeoutMs: 60000, supportsDryRun: false, idempotent: false,
    requiresApproval: false, delivery: DeliverySemantics.AT_LEAST_ONCE,
    inputSchema: { type: 'object', properties: { suite: { type: 'string' }, command: { type: 'string' } }, required: [] },
  },
  {
    id: 'tool-apply-patch', name: 'apply_patch', category: ToolCategory.CODE,
    description: 'Apply exact-match edits to a workspace file (atomic, hash-verified)',
    riskLevel: RiskLevel.MEDIUM, permissions: ['workspace:write'],
    timeoutMs: 10000, supportsDryRun: true, idempotent: false,
    requiresApproval: true, delivery: DeliverySemantics.AT_MOST_ONCE,
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, edits: { type: 'array' }, dryRun: { type: 'boolean' }, changesetId: { type: 'string' } }, required: ['path', 'edits'] },
  },
  {
    id: 'tool-git-status', name: 'git_status', category: ToolCategory.GIT,
    description: 'Read-only git status for the workspace',
    riskLevel: RiskLevel.LOW, permissions: ['workspace:read', 'git:read'],
    timeoutMs: 10000, supportsDryRun: false, idempotent: true,
    requiresApproval: false, delivery: DeliverySemantics.AT_MOST_ONCE,
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    id: 'tool-git-diff', name: 'git_diff', category: ToolCategory.GIT,
    description: 'Read-only git diff (bounded output)',
    riskLevel: RiskLevel.LOW, permissions: ['workspace:read', 'git:read'],
    timeoutMs: 10000, supportsDryRun: false, idempotent: true,
    requiresApproval: false, delivery: DeliverySemantics.AT_MOST_ONCE,
    inputSchema: { type: 'object', properties: { staged: { type: 'boolean' }, path: { type: 'string' }, maxBytes: { type: 'number' } }, required: [] },
  },
  {
    id: 'tool-git-log', name: 'git_log', category: ToolCategory.GIT,
    description: 'Read-only git log (bounded)',
    riskLevel: RiskLevel.LOW, permissions: ['git:read'],
    timeoutMs: 10000, supportsDryRun: false, idempotent: true,
    requiresApproval: false, delivery: DeliverySemantics.AT_MOST_ONCE,
    inputSchema: { type: 'object', properties: { limit: { type: 'number' } }, required: [] },
  },
  {
    id: 'tool-git-branch', name: 'git_branch', category: ToolCategory.GIT,
    description: 'List or show git branches (read-only)',
    riskLevel: RiskLevel.LOW, permissions: ['git:read'],
    timeoutMs: 10000, supportsDryRun: false, idempotent: true,
    requiresApproval: false, delivery: DeliverySemantics.AT_MOST_ONCE,
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    id: 'tool-git-create-branch', name: 'git_create_branch', category: ToolCategory.GIT,
    description: 'Create and optionally checkout a new branch',
    riskLevel: RiskLevel.MEDIUM, permissions: ['git:write'],
    timeoutMs: 15000, supportsDryRun: true, idempotent: false,
    requiresApproval: true, delivery: DeliverySemantics.AT_MOST_ONCE,
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, checkout: { type: 'boolean' } }, required: ['name'] },
  },
  {
    id: 'tool-git-add', name: 'git_add', category: ToolCategory.GIT,
    description: 'Stage explicit workspace-relative paths (never -A)',
    riskLevel: RiskLevel.MEDIUM, permissions: ['git:write'],
    timeoutMs: 15000, supportsDryRun: true, idempotent: true,
    requiresApproval: true, delivery: DeliverySemantics.IDEMPOTENT,
    inputSchema: { type: 'object', properties: { paths: { type: 'array' } }, required: ['paths'] },
  },
  {
    id: 'tool-git-commit', name: 'git_commit', category: ToolCategory.GIT,
    description: 'Commit staged changes with an explicit message (scope-checked)',
    riskLevel: RiskLevel.MEDIUM, permissions: ['git:write'],
    timeoutMs: 15000, supportsDryRun: true, idempotent: false,
    requiresApproval: true, delivery: DeliverySemantics.AT_MOST_ONCE,
    inputSchema: { type: 'object', properties: { message: { type: 'string' }, allowUnrelated: { type: 'boolean' } }, required: ['message'] },
  },
  {
    id: 'tool-git-push', name: 'git_push', category: ToolCategory.GIT,
    description: 'Push to remote (HIGH risk, disabled by default)',
    riskLevel: RiskLevel.HIGH, permissions: ['git:push'],
    timeoutMs: 30000, supportsDryRun: true, idempotent: false,
    requiresApproval: true, disabled: true, delivery: DeliverySemantics.AT_MOST_ONCE,
    inputSchema: { type: 'object', properties: { remote: { type: 'string' }, branch: { type: 'string' }, dryRun: { type: 'boolean' } }, required: [] },
  },
  {
    id: 'tool-env-inspect', name: 'env_inspect', category: ToolCategory.ENVIRONMENT,
    description: 'Normalized environment/project profile (no secrets)',
    riskLevel: RiskLevel.LOW, permissions: ['env:read'],
    timeoutMs: 10000, supportsDryRun: false, idempotent: true,
    requiresApproval: false, delivery: DeliverySemantics.AT_MOST_ONCE,
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    id: 'tool-install-package', name: 'install_package', category: ToolCategory.ENVIRONMENT,
    description: 'Install a package (supply-chain risk, approval required)',
    riskLevel: RiskLevel.HIGH, permissions: ['env:install'],
    timeoutMs: 120000, supportsDryRun: true, idempotent: false,
    requiresApproval: true, disabled: true, delivery: DeliverySemantics.AT_MOST_ONCE,
    inputSchema: { type: 'object', properties: { manager: { type: 'string' }, package: { type: 'string' }, version: { type: 'string' }, dryRun: { type: 'boolean' } }, required: ['package'] },
  },
  {
    id: 'tool-web-search', name: 'web_search', category: ToolCategory.NETWORK,
    description: 'Policy-gated web search interface (allowlist/network policy apply)',
    riskLevel: RiskLevel.MEDIUM, permissions: ['network:search'],
    timeoutMs: 20000, supportsDryRun: false, idempotent: true,
    requiresApproval: false, disabled: true, delivery: DeliverySemantics.AT_MOST_ONCE,
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, maxResults: { type: 'number' } }, required: ['query'] },
  },
  {
    id: 'tool-fetch-url', name: 'fetch_url', category: ToolCategory.NETWORK,
    description: 'Policy-gated URL fetch with SSRF guards and size/time limits',
    riskLevel: RiskLevel.MEDIUM, permissions: ['network:fetch'],
    timeoutMs: 20000, supportsDryRun: false, idempotent: true,
    requiresApproval: false, disabled: true, delivery: DeliverySemantics.AT_MOST_ONCE,
    inputSchema: { type: 'object', properties: { url: { type: 'string' }, maxBytes: { type: 'number' } }, required: ['url'] },
  },
  {
    id: 'tool-build', name: 'build_project', category: ToolCategory.TESTING,
    description: 'Run the detected build command (allowlisted, no shell)',
    riskLevel: RiskLevel.LOW, permissions: ['tests:execute'],
    timeoutMs: 120000, supportsDryRun: false, idempotent: false,
    requiresApproval: false, delivery: DeliverySemantics.AT_LEAST_ONCE,
    inputSchema: { type: 'object', properties: { target: { type: 'string' } }, required: [] },
  },
  {
    id: 'tool-deploy-preview', name: 'deploy_preview', category: ToolCategory.DEPLOYMENT,
    description: 'Build a preview deployment (CRITICAL, disabled by default)',
    riskLevel: RiskLevel.CRITICAL, permissions: ['deploy'],
    timeoutMs: 30000, supportsDryRun: true, idempotent: false,
    requiresApproval: true, disabled: true, delivery: DeliverySemantics.AT_MOST_ONCE,
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    // Honest placeholder: the capability category exists so policy, routing
    // and the UI can reason about it, but no browser automation is
    // implemented. available=false + disabled means every call is rejected
    // with 'disabled/unavailable' — never a fake result.
    id: 'tool-browser-navigate', name: 'browser_navigate', category: ToolCategory.BROWSER,
    description: 'Browser automation (not implemented in this runtime)',
    riskLevel: RiskLevel.HIGH, permissions: ['browser:automate'],
    timeoutMs: 20000, supportsDryRun: false, idempotent: false,
    requiresApproval: true, disabled: true, available: false,
    delivery: DeliverySemantics.UNKNOWN,
    inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  },
];

function normalizeDefinition(raw) {
  const d = { ...(raw || {}) };
  return {
    id: d.id || `tool-${d.name || 'unknown'}`,
    name: d.name,
    description: d.description || '',
    category: d.category || inferCategory(d.name),
    inputSchema: d.inputSchema || d.parameters || { type: 'object', properties: {}, required: [] },
    outputSchema: d.outputSchema || null,
    riskLevel: d.riskLevel || inferRisk(d.name, d.permissions || []),
    permissions: d.permissions || [],
    timeoutMs: Math.min(Math.max(Number(d.timeoutMs) || DEFAULTS.timeoutMs, 1000), 300000),
    supportsDryRun: !!d.supportsDryRun,
    idempotent: !!d.idempotent,
    requiresApproval: !!d.requiresApproval,
    disabled: !!d.disabled || d.status === 'disabled',
    // Explicit availability: false means "category known, implementation
    // absent". Absent (undefined) means available (legacy behavior).
    available: d.available === false ? false : true,
    delivery: d.delivery || DeliverySemantics.UNKNOWN,
    capabilities: d.capabilities || [],
    costPerCall: Number.isFinite(d.costPerCall) ? d.costPerCall : 0.001,
  };
}

function inferCategory(name) {
  const n = String(name || '');
  if (n.startsWith('git_')) return ToolCategory.GIT;
  if (n === 'read_file') return ToolCategory.FILESYSTEM;
  if (n === 'search_code' || n === 'web_search') return n === 'web_search' ? ToolCategory.NETWORK : ToolCategory.SEARCH;
  if (n === 'run_tests' || n === 'build_project') return ToolCategory.TESTING;
  if (n === 'apply_patch') return ToolCategory.CODE;
  if (n === 'env_inspect' || n === 'install_package') return ToolCategory.ENVIRONMENT;
  if (n === 'fetch_url') return ToolCategory.NETWORK;
  if (n.startsWith('browser_')) return ToolCategory.BROWSER;
  if (n.startsWith('deploy_')) return ToolCategory.DEPLOYMENT;
  return ToolCategory.CODE;
}

function inferRisk(name, permissions) {
  const perms = (permissions || []).join(' ');
  if (/deploy|push|install/.test(String(name)) || /deploy|push|install/.test(perms)) return RiskLevel.HIGH;
  if (/write/.test(perms) || /patch|commit|branch|add/.test(String(name))) return RiskLevel.MEDIUM;
  return RiskLevel.LOW;
}

function compareRisk(a, b) {
  return (RISK_ORDER[a] ?? 0) - (RISK_ORDER[b] ?? 0);
}

// Normalized execution result. Every tool returns this shape — tools never
// invent their own result format. Legacy Session-1 fields are preserved
// alongside (toolName/success/result/error/latencyMs/cost/timestamp/code)
// so existing consumers keep working.
function createExecutionResult(opts = {}) {
  const startedAt = opts.startedAt || new Date().toISOString();
  const completedAt = opts.completedAt || new Date().toISOString();
  const durationMs = Number.isFinite(opts.durationMs)
    ? opts.durationMs
    : Math.max(0, new Date(completedAt) - new Date(startedAt));
  const status = opts.status || (opts.success === false ? ToolStatus.FAILURE : ToolStatus.SUCCESS);
  // Status is derived from actual execution, never from a tool's self-report.
  return {
    executionId: opts.executionId || (`exec-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`),
    toolId: opts.toolId || opts.toolName || null,
    toolName: opts.toolName || opts.toolId || null,
    status,
    // legacy aliases
    success: status === ToolStatus.SUCCESS,
    code: status === ToolStatus.SUCCESS ? 'success' : (opts.code || status),
    startedAt,
    completedAt,
    durationMs,
    latencyMs: durationMs,
    output: opts.output !== undefined ? opts.output : (opts.result !== undefined ? opts.result : null),
    result: opts.output !== undefined ? opts.output : (opts.result !== undefined ? opts.result : null),
    error: opts.error || null,
    artifacts: Array.isArray(opts.artifacts) ? opts.artifacts : [],
    sideEffects: Array.isArray(opts.sideEffects) ? opts.sideEffects : [],
    approvalId: opts.approvalId || null,
    idempotencyKey: opts.idempotencyKey || null,
    cost: Number.isFinite(opts.cost) ? opts.cost : 0,
    timestamp: completedAt,
    outputTruncated: !!opts.outputTruncated,
    dryRun: !!opts.dryRun,
    deduped: !!opts.deduped,
  };
}

function truncateOutput(value, limits = {}) {
  const maxBytes = Math.min(Number(limits.maxOutputBytes) || DEFAULTS.maxOutputBytes, 256 * 1024);
  const maxLines = Math.min(Number(limits.maxLines) || DEFAULTS.maxLines, 2000);
  let text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  let truncated = false;
  const lines = text.split('\n');
  if (lines.length > maxLines) {
    text = lines.slice(0, maxLines).join('\n');
    truncated = true;
  }
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    text = Buffer.from(text, 'utf8').slice(0, maxBytes).toString('utf8');
    truncated = true;
  }
  return { text, outputTruncated: truncated };
}

function validateInput(schema, params) {
  const p = params || {};
  if (schema && Array.isArray(schema.required)) {
    for (const key of schema.required) {
      if (p[key] === undefined) return { valid: false, error: `Missing required parameter: ${key}` };
    }
  }
  if (schema && schema.properties && typeof schema.properties === 'object') {
    for (const [key, def] of Object.entries(schema.properties)) {
      const v = p[key];
      if (v === undefined) continue;
      if (def.type === 'string' && typeof v !== 'string') return { valid: false, error: `Parameter ${key} must be a string` };
      if (def.type === 'number' && typeof v !== 'number') return { valid: false, error: `Parameter ${key} must be a number` };
      if (def.type === 'boolean' && typeof v !== 'boolean') return { valid: false, error: `Parameter ${key} must be a boolean` };
      if (def.type === 'array' && !Array.isArray(v)) return { valid: false, error: `Parameter ${key} must be an array` };
      if (def.type === 'object' && (typeof v !== 'object' || v === null || Array.isArray(v))) return { valid: false, error: `Parameter ${key} must be an object` };
    }
  }
  return { valid: true };
}

module.exports = {
  ToolCategory,
  RiskLevel,
  ToolStatus,
  DeliverySemantics,
  TOOL_DEFINITIONS,
  DEFAULTS,
  normalizeDefinition,
  inferCategory,
  inferRisk,
  compareRisk,
  createExecutionResult,
  truncateOutput,
  validateInput,
};
