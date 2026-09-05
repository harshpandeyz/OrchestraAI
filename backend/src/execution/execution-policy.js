'use strict';

// Session 3 — Execution policy: autonomy levels, tool/command/network policy.
//
// Session 1 security is never bypassed: this policy can only narrow what
// Session 1 allows (blockedTools/policy.isToolAllowed still apply). A
// capability escalation always needs policy permission and/or explicit
// approval — the model can never silently widen its own sandbox.

const { RiskLevel, compareRisk } = require('./tool-system');

const AutonomyMode = Object.freeze({
  READ_ONLY: 'read_only',
  ASSISTED: 'assisted',
  AUTONOMOUS: 'autonomous',
  RESTRICTED_AUTONOMOUS: 'restricted_autonomous',
});

const ApprovalMode = Object.freeze({
  AUTO_APPROVE_LOW: 'AUTO_APPROVE_LOW',
  APPROVE_WRITES: 'APPROVE_WRITES',
  APPROVE_DANGEROUS: 'APPROVE_DANGEROUS',
  APPROVE_ALL: 'APPROVE_ALL',
});

const NetworkMode = Object.freeze({
  DISABLED: 'disabled',
  ALLOWLIST: 'allowlist',
  ENABLED: 'enabled',
});

const AUTONOMY_PRESETS = {
  [AutonomyMode.READ_ONLY]: {
    approvalMode: ApprovalMode.APPROVE_ALL,
    writeAccess: false,
    networkAccess: NetworkMode.DISABLED,
    allowDeploy: false,
    allowPush: false,
    allowInstall: false,
    maxExecutionTimeMs: 120000,
    maxOutputSize: 16 * 1024,
  },
  [AutonomyMode.ASSISTED]: {
    approvalMode: ApprovalMode.APPROVE_WRITES,
    writeAccess: false, // writes only via approval
    networkAccess: NetworkMode.ALLOWLIST,
    allowDeploy: false,
    allowPush: false,
    allowInstall: false,
    maxExecutionTimeMs: 300000,
    maxOutputSize: 24 * 1024,
  },
  [AutonomyMode.AUTONOMOUS]: {
    approvalMode: ApprovalMode.APPROVE_DANGEROUS,
    writeAccess: true, // low-risk writes auto-approved; HIGH/CRITICAL still gated
    networkAccess: NetworkMode.ALLOWLIST,
    allowDeploy: false,
    allowPush: false,
    allowInstall: false,
    maxExecutionTimeMs: 600000,
    maxOutputSize: 32 * 1024,
  },
  [AutonomyMode.RESTRICTED_AUTONOMOUS]: {
    approvalMode: ApprovalMode.APPROVE_DANGEROUS,
    writeAccess: true,
    networkAccess: NetworkMode.DISABLED,
    allowDeploy: false,
    allowPush: false,
    allowInstall: false,
    maxExecutionTimeMs: 180000,
    maxOutputSize: 16 * 1024,
  },
};

// Conservative default: writes require approval, network restricted,
// deployment + push + destructive commands disabled.
function defaultPolicy(overrides = {}) {
  const mode = overrides.autonomyMode || AutonomyMode.ASSISTED;
  const preset = AUTONOMY_PRESETS[mode] || AUTONOMY_PRESETS[AutonomyMode.ASSISTED];
  return {
    autonomyMode: mode,
    approvalMode: overrides.approvalMode || preset.approvalMode,
    allowedTools: Array.isArray(overrides.allowedTools) ? [...overrides.allowedTools] : [],
    deniedTools: Array.isArray(overrides.deniedTools) ? [...overrides.deniedTools] : ['git_push', 'deploy_preview', 'install_package'],
    allowedCommands: Array.isArray(overrides.allowedCommands) ? [...overrides.allowedCommands] : [],
    deniedCommands: Array.isArray(overrides.deniedCommands) ? [...overrides.deniedCommands] : [],
    workspaceRoot: overrides.workspaceRoot || process.env.WORKSPACE_ROOT || process.cwd(),
    networkAccess: overrides.networkAccess || preset.networkAccess,
    networkAllowlist: Array.isArray(overrides.networkAllowlist) ? [...overrides.networkAllowlist] : [],
    writeAccess: overrides.writeAccess !== undefined ? !!overrides.writeAccess : preset.writeAccess,
    allowDeploy: false,
    allowPush: false,
    allowInstall: false,
    maxExecutionTimeMs: Number.isFinite(overrides.maxExecutionTimeMs) ? overrides.maxExecutionTimeMs : preset.maxExecutionTimeMs,
    maxOutputSize: Number.isFinite(overrides.maxOutputSize) ? overrides.maxOutputSize : preset.maxOutputSize,
    maxSteps: Number.isFinite(overrides.maxSteps) ? overrides.maxSteps : 12,
    maxToolCalls: Number.isFinite(overrides.maxToolCalls) ? overrides.maxToolCalls : 20,
    ...(overrides.allowDeploy === true ? {} : {}), // explicit: deploy stays off unless allowDeploy passed AND approved per-action
  };
}

function isToolAllowedByPolicy(policy, toolName, definition) {
  if (!policy) return { allowed: true, reason: 'no-policy' };
  if ((policy.deniedTools || []).includes(toolName)) return { allowed: false, reason: `tool denied by policy: ${toolName}` };
  if ((policy.allowedTools || []).length && !(policy.allowedTools || []).includes(toolName)) {
    return { allowed: false, reason: `tool not in policy allowlist: ${toolName}` };
  }
  if (definition && definition.disabled && toolName !== 'deploy_preview') {
    // Disabled-by-default high-risk tools need explicit policy opt-in AND approval.
    if (!((policy.allowedTools || []).includes(toolName))) {
      return { allowed: false, reason: `tool disabled by default: ${toolName}` };
    }
  }
  if (definition && definition.category === 'deployment' && !policy.allowDeploy) {
    return { allowed: false, reason: 'deployment disabled by policy' };
  }
  if (toolName === 'git_push' && !policy.allowPush) {
    return { allowed: false, reason: 'git push disabled by policy' };
  }
  if (toolName === 'install_package' && !policy.allowInstall) {
    return { allowed: false, reason: 'package install disabled by policy' };
  }
  return { allowed: true, reason: 'allowed' };
}

// Approval decision for a tool call at a risk level under an approval mode.
// Returns { needsApproval, reason }. Autonomous NEVER means unrestricted:
// HIGH/CRITICAL always need approval.
function needsApproval(policy, definition, riskLevel) {
  const mode = (policy && policy.approvalMode) || ApprovalMode.APPROVE_WRITES;
  const risk = riskLevel || (definition && definition.riskLevel) || RiskLevel.LOW;
  const name = definition && definition.name;
  if (mode === ApprovalMode.APPROVE_ALL) return { needsApproval: true, reason: 'APPROVE_ALL' };
  if (definition && definition.requiresApproval) {
    if (mode === ApprovalMode.AUTO_APPROVE_LOW && risk === RiskLevel.LOW) {
      return { needsApproval: false, reason: 'AUTO_APPROVE_LOW: low-risk auto-approved' };
    }
    return { needsApproval: true, reason: `tool requires approval: ${name}` };
  }
  if (mode === ApprovalMode.APPROVE_WRITES) {
    if (compareRisk(risk, RiskLevel.MEDIUM) >= 0) return { needsApproval: true, reason: `APPROVE_WRITES: ${risk} action` };
    return { needsApproval: false, reason: 'low-risk read/test auto-approved' };
  }
  if (mode === ApprovalMode.APPROVE_DANGEROUS) {
    if (compareRisk(risk, RiskLevel.HIGH) >= 0) return { needsApproval: true, reason: `APPROVE_DANGEROUS: ${risk} action` };
    return { needsApproval: false, reason: 'MEDIUM and below auto-approved' };
  }
  if (mode === ApprovalMode.AUTO_APPROVE_LOW) {
    if (risk === RiskLevel.LOW) return { needsApproval: false, reason: 'AUTO_APPROVE_LOW' };
    return { needsApproval: true, reason: `${risk} action needs approval` };
  }
  return { needsApproval: true, reason: 'default-deny' };
}

// --- Command policy: no arbitrary shell. ---
//
// Agent 3: execFile() is a command restriction, NOT a sandbox. The strict
// argv rules live in ./command-guard.js (single source of truth, shared with
// the isolated worker); this module keeps the policy-level family
// declarations and delegates enforcement there.

// Allowlisted command families. Exact argv matching happens in environment.js;
// this is the policy-level declaration of which families a run may use.
const COMMAND_FAMILIES = Object.freeze({
  NODE_TEST_FILE: 'node_test_file',   // node <workspace-file> [args]
  NPM_TEST: 'npm_test',               // npm test / npm run test|build|lint
  PYTEST: 'pytest',
  CARGO_TEST: 'cargo_test',
  GO_TEST: 'go_test',
  GIT_READONLY: 'git_readonly',       // git status/diff/log/branch/show
  GIT_WRITE: 'git_write',             // git add/commit/branch (approval-gated)
});

function classifyCommand(argv) {
  try {
    return require('./command-guard').classifyArgv(argv);
  } catch {
    return { family: null, risk: RiskLevel.CRITICAL, reason: 'classification failed' };
  }
}

// Shell metacharacters: any argv element containing one is rejected. Brackets
// [ ] are intentionally NOT in this set: pytest selectors such as
// test.py::case[param] need them and workspace escape is still blocked by the
// path rules in command-guard.js.
const SHELL_METACHAR_RE = /[;&|`$(){}!#~*?<>\n\r]/;

function containsShellMetachars(argv) {
  if ((Array.isArray(argv) ? argv : []).some((a) => SHELL_METACHAR_RE.test(String(a)))) return true;
  try {
    return require('./command-guard').containsSubstitution((Array.isArray(argv) ? argv : []).map(String).join(' '));
  } catch {
    return false;
  }
}

function isCommandAllowed(policy, argv) {
  try {
    return require('./command-guard').assertCommandAllowed(policy, argv);
  } catch (e) {
    return { allowed: false, family: null, risk: RiskLevel.CRITICAL, reason: String((e && e.message) || e).slice(0, 200) };
  }
}

module.exports = {
  AutonomyMode,
  ApprovalMode,
  NetworkMode,
  AUTONOMY_PRESETS,
  COMMAND_FAMILIES,
  defaultPolicy,
  isToolAllowedByPolicy,
  needsApproval,
  classifyCommand,
  containsShellMetachars,
  isCommandAllowed,
};
