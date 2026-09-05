'use strict';

const fs = require('fs');
const path = require('path');

// Session 3 — ExecutionController: composes Session-1 Orchestrator with the
// agent execution capabilities (policy, approvals, changesets, git,
// environment, plans, episodes, pause/resume, recovery, verification).
//
// Integration rule: Session 1 contracts are consumed, never replaced.
// - Persistence: FileStore (Session 1) continues to persist runs/events.
// - Provider/model routing: untouched.
// - Lifecycle: only additive transitions (COMPLETED -> RETRYING for
//   same-run continuation); everything else wraps via gate hooks and
//   explicit new methods.
// - Default behavior with no Session-3 config is unchanged (existing tests).

const { EventType, TaskStatus } = require('../core/types');
const { generateId, now } = require('../state/runtime-state');
const {
  ToolCategory, RiskLevel, ToolStatus, TOOL_DEFINITIONS, normalizeDefinition,
} = require('./tool-system');
const {
  AutonomyMode, ApprovalMode, NetworkMode, defaultPolicy,
  isToolAllowedByPolicy, needsApproval,
} = require('./execution-policy');
const { ApprovalStatus, ApprovalStore, classifyRisk } = require('./approvals');
const { ChangesetStore, ChangesetStatus, gitStatus, gitDiff, gitLog, gitBranches, gitCreateBranch, gitAdd, gitCommit, resolveWorkspaceRoot } = require('./changesets');
const { environmentProfile, detectProject, ArtifactStore, redactSecrets, summarizeInputs } = require('./environment');
const { PlanManager, PlanStepStatus, EpisodeManager, EpisodeStatus, PauseController, PauseState, parseRuntimeCommand, RuntimeCommand, ConstraintStore, actionObservation } = require('./plans-episodes');
const { RecoveryDecision, SideEffectState, buildCheckpoint, fingerprintContext, decideRecovery, retryDecision, backoffForAttempt, verificationRecord, VerificationKind, agentResult, ToolHealthTracker, LoopGuard } = require('./recovery');

function attachExecution(orchestrator, options = {}) {
  if (orchestrator.__session3) return orchestrator.__session3;
  const controller = new ExecutionController(orchestrator, options);
  orchestrator.__session3 = controller;
  return controller;
}

class ExecutionController {
  constructor(orchestrator, options = {}) {
    this.orch = orchestrator;
    this.workspace = options.workspace || process.env.WORKSPACE_ROOT || process.cwd();
    this.productionSafeToolsOnly = !!options.productionSafeToolsOnly;
    this.approvals = new ApprovalStore(options.approvals);
    this.changesets = new ChangesetStore();
    this.plans = new PlanManager();
    this.episodes = new EpisodeManager();
    this.pause = new PauseController();
    this.constraints = new ConstraintStore();
    this.artifacts = new ArtifactStore();
    this.health = new ToolHealthTracker();
    this.policies = new Map(); // runId -> ExecutionPolicy
    this.observations = new Map(); // runId -> ActionObservation[]
    this.verifications = new Map(); // runId -> verification records[]
    this.results = new Map(); // runId -> AgentExecutionResult
    this.recoveryLog = new Map(); // runId -> recovery decisions[]
    this.autoVerify = options.autoVerify !== undefined ? !!options.autoVerify : true;
    this._verifying = new Set(); // idempotency keys of verification-originated calls
    this._wrapExecutor();
    this._wrapLifecycle();
    this._seedCatalog();
  }

  // --- setup ---

  _seedCatalog() {
    // Ensure every canonical capability exists in the registry (disabled
    // high-risk ones included) so policy/approval has something to gate.
    // Runs synchronously when the registry is synchronous (Map-backed) so
    // the approval gate is correct on the very first tool call — no async
    // race between seeding and gating. Falls back to async for remote
    // registries.
    const reg = this.orch.toolRegistry;
    if (!reg || typeof reg.getTool !== 'function') return;
    // Same defaults as InMemoryToolRegistry.registerTool so the sync fast
    // path and the async path produce identical records (safety metadata
    // parameters/timeoutMs/costPerCall always present for /api/tools).
    const seedOne = (def, existing) => ({
      id: def.id, name: def.name, description: def.description,
      parameters: def.inputSchema || { type: 'object', properties: {}, required: [] },
      inputSchema: def.inputSchema || { type: 'object', properties: {}, required: [] },
      status: def.disabled ? 'disabled' : 'enabled',
      disabled: !!def.disabled, available: def.available !== false,
      capabilities: [def.category], category: def.category || 'code',
      riskLevel: def.riskLevel || 'LOW', requiresApproval: !!def.requiresApproval,
      supportsDryRun: !!def.supportsDryRun, idempotent: !!def.idempotent,
      delivery: def.delivery || 'unknown', permissions: def.permissions || [],
      timeoutMs: Number.isFinite(def.timeoutMs) ? def.timeoutMs : 30000,
      costPerCall: Number.isFinite(def.costPerCall) ? def.costPerCall : 0.001,
    });
    try {
      // Fast path: registry exposes its internal map (InMemoryToolRegistry).
      if (reg.tools instanceof Map) {
        for (const def of TOOL_DEFINITIONS) {
          const existing = reg.tools.get(def.name) || null;
          if (!existing) {
            // registerTool is async but Map-backed: call sync equivalent.
            reg.tools.set(def.name, {
              ...seedOne(def),
              id: def.id || `tool-${def.name}`,
              registeredAt: new Date().toISOString(),
              parameters: def.inputSchema,
              inputSchema: def.inputSchema,
              avgLatencyMs: 100, successRate: 1.0, metadata: {},
            });
          } else {
            if (!existing.category) existing.category = def.category;
            if (!existing.riskLevel) existing.riskLevel = def.riskLevel;
            if (existing.requiresApproval === undefined) existing.requiresApproval = def.requiresApproval;
            if (existing.supportsDryRun === undefined) existing.supportsDryRun = def.supportsDryRun;
            if (existing.available === undefined) existing.available = def.available !== false;
            if (existing.disabled === undefined) existing.disabled = !!def.disabled;
            if (existing.timeoutMs === undefined) existing.timeoutMs = Number.isFinite(def.timeoutMs) ? def.timeoutMs : 30000;
            if (existing.costPerCall === undefined) existing.costPerCall = Number.isFinite(def.costPerCall) ? def.costPerCall : 0.001;
            if (!existing.parameters && def.inputSchema) existing.parameters = def.inputSchema;
            if (!existing.inputSchema && existing.parameters) existing.inputSchema = existing.parameters;
            // Canonical requiresApproval is authoritative: a legacy record
            // without the flag must not silently widen apply_patch/git_commit.
            if (def.requiresApproval && !existing.requiresApproval) existing.requiresApproval = true;
          }
        }
        return;
      }
    } catch { /* fall through to async */ }
    (async () => {
      for (const def of TOOL_DEFINITIONS) {
        try {
          const existing = await reg.getTool(def.name);
          if (!existing) {
            await reg.registerTool(seedOne(def, null));
          } else {
            // Backfill capability fields on legacy records (additive).
            const patch = {};
            if (!existing.category) patch.category = def.category;
            if (!existing.riskLevel) patch.riskLevel = def.riskLevel;
            if (existing.requiresApproval === undefined) patch.requiresApproval = def.requiresApproval;
            if (existing.supportsDryRun === undefined) patch.supportsDryRun = def.supportsDryRun;
            if (existing.available === undefined) patch.available = def.available !== false;
            if (def.requiresApproval && !existing.requiresApproval) patch.requiresApproval = true;
            if (Object.keys(patch).length && typeof reg.updateTool === 'function') {
              await reg.updateTool(def.name, patch);
            }
          }
        } catch { /* registry hiccup must not break boot */ }
      }
    })();
  }

  policyFor(runId) {
    if (!this.policies.has(runId)) {
      this.policies.set(runId, defaultPolicy({ workspaceRoot: this.workspaceFor(this.orch.getRun(runId) || { runId }) }));
    }
    return this.policies.get(runId);
  }

  setPolicy(runId, patch = {}) {
    const cur = this.policyFor(runId);
    const next = { ...cur, ...patch };
    // Autonomy presets flip the approval mode unless explicitly overridden.
    if (patch.autonomyMode && !patch.approvalMode) {
      const { approvalModeForAutonomy } = require('./approvals');
      next.approvalMode = approvalModeForAutonomy(patch.autonomyMode);
    }
    this.policies.set(runId, next);
    return { ...next };
  }

  _wrapExecutor() {
    const exec = this.orch.toolExecutor;
    if (!exec || exec.__session3Wrapped) return;
    const inner = exec.execute.bind(exec);
    const controller = this;
    exec.gate = async ({ toolName, params, definition, runtimeState, options }) => controller._preGate(runtimeState.runId, toolName, params, definition, options);
    exec.execute = async function gatedExecute(toolName, params, runtimeState, options = {}) {
      const runId = runtimeState && runtimeState.runId;
      // Cooperative pause: hold at tool boundaries (never kills in-flight
      // provider/network work; settles to PAUSED while holding).
      if (runId) await controller._holdForPause(runId, options.signal);
      const res = await inner(toolName, params, runtimeState, {
        ...options,
        workspace: controller.workspaceFor(runtimeState),
      });
      if (runId && !options.skipPostHook) {
        try { await controller._postTool(runId, toolName, params || {}, res, runtimeState); } catch { /* post-hook never fails the tool */ }
      }
      return res;
    };
    exec.__session3Wrapped = true;
  }

  _wrapLifecycle() {
    const orch = this.orch;
    if (orch.__session3Lifecycle) return;
    const controller = this;
    const origCreate = orch.createRun.bind(orch);
    orch.createRun = async (objective, config = {}) => {
      const state = await origCreate(objective, config);
      controller._initRun(state.runId, config);
      return state;
    };
    const origStart = orch.startRun.bind(orch);
    orch.startRun = async (runId, userMessage) => {
      // First message on a run starts episode 1 if none exists.
      if (!controller.episodes.current(runId)) {
        controller.episodes.start(runId, { goal: String(userMessage || '').slice(0, 1000) });
        try { orch._emit(runId, EventType.EPISODE_STARTED, { episodeId: controller.episodes.current(runId).episodeId, goal: String(userMessage || '').slice(0, 500) }); } catch {}
      }
      return origStart(runId, userMessage);
    };
    orch.__session3Lifecycle = true;
  }

  _initRun(runId, config = {}) {
    // Execution policy comes from run config (autonomyMode/approvalMode) or
    // the conservative default. Never widens Session-1 policy.
    const policy = defaultPolicy({
      workspaceRoot: this.workspaceFor(this.orch.getRun(runId) || { runId, orgId: config.orgId, projectId: config.projectId }),
      autonomyMode: config.autonomyMode || AutonomyMode.ASSISTED,
      approvalMode: config.approvalMode || undefined,
      allowedTools: config.allowedTools, deniedTools: config.deniedTools,
      networkAccess: config.networkAccess, networkAllowlist: config.networkAllowlist,
      maxSteps: config.maxSteps, maxToolCalls: config.maxToolCalls,
    });
    this.policies.set(runId, policy);
    this.observations.set(runId, []);
    this.verifications.set(runId, []);
  }

  workspaceFor(runtimeState = {}) {
    if (!this.productionSafeToolsOnly) return this.workspace;
    const safe = (value, fallback) => String(value || fallback).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100);
    const scoped = path.join(this.workspace, safe(runtimeState.orgId, 'unassigned-org'), safe(runtimeState.projectId, 'unassigned-project'), safe(runtimeState.runId, 'run'));
    try { fs.mkdirSync(scoped, { recursive: true, mode: 0o700 }); } catch {}
    return scoped;
  }

  // --- pre-gate: policy -> constraints -> approval ---

  async _preGate(runId, toolName, params, definition, options = {}) {
    const policy = this.policyFor(runId);
    const def = normalizeDefinition(definition || { name: toolName });
    if (this.productionSafeToolsOnly && !new Set(['read_file', 'search_code', 'git_status', 'git_diff', 'git_log', 'git_branch']).has(toolName)) {
      return { allowed: false, code: 'denied', reason: `production safe-tools policy blocks ${toolName}` };
    }
    // Unify source of truth: the canonical TOOL_DEFINITIONS are authoritative
    // for requiresApproval/risk. A legacy registry record missing the flag
    // must not silently widen gated tools (apply_patch, git_commit, ...).
    try {
      const canonical = TOOL_DEFINITIONS.find((d) => d.name === toolName) || null;
      if (canonical) {
        if (canonical.requiresApproval && !def.requiresApproval) def.requiresApproval = true;
        if (canonical.disabled && !def.disabled) def.disabled = true;
        if (canonical.available === false) def.available = false;
        if (!definition?.riskLevel && canonical.riskLevel) {
          const { compareRisk } = require('./tool-system');
          if (compareRisk(canonical.riskLevel, def.riskLevel) > 0) def.riskLevel = canonical.riskLevel;
        }
        if (!definition?.category && canonical.category) def.category = canonical.category;
      }
    } catch { /* canonical overlay is advisory */ }
    // 1. Session-1 policy still applies (never bypassed).
    try {
      const rs = this.orch.activeRuns.get(runId);
      if (rs && rs.policy && typeof rs.policy.isToolAllowed === 'function' && !rs.policy.isToolAllowed(toolName)) {
        return { allowed: false, code: 'denied', reason: `tool blocked by run policy: ${toolName}` };
      }
    } catch { /* fall through to session-3 policy */ }
    // 2. Session-3 execution policy.
    const pol = isToolAllowedByPolicy(policy, toolName, def);
    if (!pol.allowed) return { allowed: false, code: 'denied', reason: pol.reason };
    // 3. Human-override constraints (only-paths / forbid-paths / branch).
    if (toolName === 'apply_patch' && params && params.path) {
      const c = this.constraints.checkWrite(runId, String(params.path).replace(/^\/+/, ''));
      if (!c.allowed) return { allowed: false, code: 'denied', reason: c.reason };
    }
    if ((toolName === 'git_commit' || toolName === 'git_add') && this.constraints.get(runId).onlyPaths.length) {
      const paths = toolName === 'git_add' ? (params.paths || []) : null;
      if (paths && paths.some((p) => !this.constraints.checkWrite(runId, String(p)).allowed)) {
        return { allowed: false, code: 'denied', reason: 'paths outside user-constrained scope' };
      }
    }
    // 4. Risk classification + approval.
    const { risk } = classifyRisk(def, params);
    const need = needsApproval(policy, def, risk);
    if (need.needsApproval) {
      // Explicit approvalId (executeWithApproval path): consume single-use
      // here — the gate is the ONE consumption point, so direct execution
      // and the controller can never disagree or double-consume.
      const explicitId = options && options.approvalId ? String(options.approvalId) : null;
      if (explicitId) {
        const check = this.approvals.checkAndConsume({ runId, actionType: toolName, params, approvalId: explicitId });
        if (check.ok) return { allowed: true, approvalId: explicitId };
        return { allowed: false, code: check.error && /expired/i.test(check.error) ? 'expired' : 'denied', reason: `approval rejected: ${check.error}` };
      }
      // An unconsumed matching approval lets execution proceed — consume it
      // NOW (single-use) so the same approval can never authorize a replay.
      const peek = this.approvals.peek({ runId, actionType: toolName, params });
      if (peek) {
        const consume = this.approvals.checkAndConsume({ runId, actionType: toolName, params, approvalId: peek.id });
        if (consume.ok) return { allowed: true, approvalId: peek.id };
        // Peeked approval went stale (expired/consumed) between peek and
        // consume: fall through to request a fresh approval below.
      }
      // Otherwise request approval and block this call.
      const req = this.approvals.request({
        runId, actionType: toolName,
        title: `${toolName} requires approval`,
        description: `${toolName} ${need.reason} (risk ${risk}). Params: ${summarizeInputs(params).slice(0, 500)}`,
        riskLevel: risk, params,
        proposedAction: { tool: toolName, params: redactSecrets(params) },
        affectedResources: toolName === 'apply_patch' && params.path ? [String(params.path)] : [],
      });
      try {
        this.orch._emit(runId, EventType.TOOL_APPROVAL_REQUIRED, {
          approvalId: req.id, tool: toolName, risk, reason: need.reason,
          affectedResources: req.affectedResources,
        });
        this.orch._emit(runId, EventType.APPROVAL_REQUESTED, { approvalId: req.id, actionType: toolName, risk });
      } catch {}
      return { allowed: false, code: 'needs_approval', needsApproval: true, approvalId: req.id, reason: `waiting for approval ${req.id} (${risk})` };
    }
    return { allowed: true };
  }

  async _holdForPause(runId, signal) {
    // Settle PAUSING -> PAUSED at this safe boundary, then hold while paused.
    const settled = this.pause.settlePause(runId);
    if (settled === PauseState.PAUSED) {
      try {
        const orch = this.orch;
        const rs = orch.activeRuns.get(runId);
        if (rs) {
          try { orch.transition(rs, TaskStatus.PAUSED); } catch {}
          orch._emit(runId, EventType.EXECUTION_PAUSED, { at: now() });
        }
      } catch {}
    }
    let waited = 0;
    while (this.pause.isPaused(runId)) {
      if (signal && signal.aborted) break;
      await new Promise((r) => setTimeout(r, 50));
      waited += 50;
      if (waited > 15 * 60 * 1000) break; // 15min hard cap on a pause hold
    }
  }

  // --- post-tool: telemetry, observations, verification ---

  async _postTool(runId, toolName, params, res, runtimeState) {
    const status = res.status || (res.success ? ToolStatus.SUCCESS : ToolStatus.FAILURE);
    const outputBytes = Buffer.byteLength(JSON.stringify(res.output ?? res.result ?? ''), 'utf8');
    this.health.record({
      tool: toolName, durationMs: res.durationMs ?? res.latencyMs ?? 0,
      status, risk: (res.definitionRisk || null), approvalId: res.approvalId || null,
      outputBytes, artifactCount: (res.artifacts || []).length,
    });
    const obs = actionObservation({
      tool: toolName,
      intent: `model-requested ${toolName}`,
      inputsSummary: summarizeInputs(params),
      resultSummary: res.success ? JSON.stringify(res.output ?? res.result ?? '').slice(0, 500) : String(res.error || '').slice(0, 500),
      artifacts: (res.artifacts || []).map((a) => (a && a.reference) || a),
      sideEffects: res.sideEffects || (toolName === 'apply_patch' && res.success ? [{ type: 'file_write', path: params.path }] : []),
      success: res.success,
    });
    const list = this.observations.get(runId) || [];
    list.push(obs);
    if (list.length > 200) list.shift();
    this.observations.set(runId, list);

    if (this.episodes.current(runId)) {
      const cur = this.episodes.current(runId);
      this.episodes.recordStep(runId, cur.episodeId, { toolCalls: 1 });
    }

    // Verify after modifications: diff inspection always; test run when
    // autoVerify is on (reentrancy-guarded, bounded, failure recorded not thrown).
    if (toolName === 'apply_patch' && res.success && res.output && res.output.applied && this.autoVerify) {
      const key = res.idempotencyKey || res.executionId;
      if (!this._verifying.has(`verify:${key}`)) {
        this._verifying.add(`verify:${key}`);
        try { await this.verifyChangeset(runId, null, { origin: 'auto-after-patch' }); }
        catch { /* verification failure is recorded, never thrown */ }
        finally { this._verifying.delete(`verify:${key}`); }
      }
    }
  }

  // --- approvals API ---

  requestApproval(runId, body = {}) {
    const req = this.approvals.request({ runId, ...body });
    try {
      this.orch._emit(runId, EventType.APPROVAL_REQUESTED, { approvalId: req.id, actionType: req.actionType, risk: req.riskLevel });
    } catch {}
    return req;
  }

  decideApproval(runId, approvalId, decision, decidedBy = 'user') {
    const fn = decision === 'approve' ? 'approve' : decision === 'deny' ? 'deny' : 'cancel';
    const r = this.approvals[fn](approvalId);
    if (!r.ok) return r;
    if (r.approval.runId !== runId) return { ok: false, error: 'approval belongs to a different run' };
    try {
      this.orch._emit(runId, EventType.APPROVAL_DECIDED, { approvalId, decision: r.approval.status });
      this.orch._emit(runId, r.approval.status === ApprovalStatus.APPROVED ? EventType.TOOL_APPROVED : EventType.TOOL_DENIED, {
        approvalId, actionType: r.approval.actionType,
      });
    } catch {}
    return r;
  }

  // Execute a gated tool with an explicit approval. Consumption happens
  // ONCE inside the gate (_preGate checkAndConsume) so direct execution and
  // this path share one source of truth — never pre-consume here (that would
  // double-consume and force the gate to block a valid approval).
  async executeWithApproval(runId, toolName, params, approvalId, options = {}) {
    const runtimeState = (this.orch.activeRuns && this.orch.activeRuns.get(runId))
      || (this.orch.getRun ? this.orch.getRun(runId) : null);
    if (!runtimeState) return { ok: false, error: 'run not found' };
    if (!approvalId) return { ok: false, error: 'approvalId is required' };
    const res = await this.orch.toolExecutor.execute(toolName, params, runtimeState, {
      ...options, approvalId, skipPostHook: false,
    });
    // Gate rejection surfaces as needs_approval/denied/expired (success
    // false) — surface the reason instead of claiming ok:true.
    if (res.success) return { ok: true, result: res };
    if (res.code === 'needs_approval' || res.status === 'needs_approval') {
      return { ok: false, needsApproval: true, approvalId: res.approvalId || approvalId, error: res.error, result: res };
    }
    return { ok: false, error: res.error || res.code || 'denied', code: res.code, result: res };
  }

  // --- changesets API (propose -> approve -> apply -> verify -> rollback) ---

  async proposeChangeset(runId, files, { riskLevel } = {}) {
    const policy = this.policyFor(runId);
    if (!policy.writeAccess && policy.approvalMode === ApprovalMode.APPROVE_ALL) {
      // read-only: proposals allowed (dry-run), applies blocked later.
    }
    const cs = await this.changesets.propose({ runId, workspace: this.workspaceFor(this.orch.getRun(runId) || { runId }), files, riskLevel });
    try {
      this.orch._emit(runId, EventType.CHANGESET_CREATED, {
        changesetId: cs.id, files: cs.files.map((f) => f.path),
        additions: cs.additions, deletions: cs.deletions,
      });
    } catch {}
    return cs;
  }

  async applyChangeset(runId, changesetId, { approvalId = null } = {}) {
    const cs = this.changesets.get(changesetId);
    if (!cs || cs.runId !== runId) return { ok: false, error: 'changeset not found for run' };
    const policy = this.policyFor(runId);
    const need = needsApproval(policy, { name: 'apply_patch', requiresApproval: true }, cs.riskLevel || RiskLevel.MEDIUM);
    if (need.needsApproval) {
      if (!approvalId) {
        const req = this.approvals.request({
          runId, actionType: 'apply_patch',
          title: `Apply changeset ${changesetId}`,
          description: `Files: ${cs.files.map((f) => f.path).join(', ')} (+${cs.additions}/-${cs.deletions})`,
          riskLevel: cs.riskLevel, params: { changesetId },
          proposedAction: { changesetId, files: cs.files },
          affectedResources: cs.files.map((f) => f.path),
          estimatedChanges: { additions: cs.additions, deletions: cs.deletions },
        });
        try { this.orch._emit(runId, EventType.CHANGESET_APPROVAL_REQUIRED, { changesetId, approvalId: req.id }); } catch {}
        return { ok: false, needsApproval: true, approvalId: req.id };
      }
      const check = this.approvals.checkAndConsume({ runId, actionType: 'apply_patch', params: { changesetId }, approvalId });
      if (!check.ok) return check;
    }
    // Git-aware: capture workspace state before writes.
    const workspace = this.workspaceFor(this.orch.getRun(runId) || { runId });
    const before = await gitStatus(workspace).catch(() => null);
    const r = await this.changesets.apply(changesetId, { workspace });
    if (!r.ok) return r;
    try {
      const after = await gitDiff(workspace, {}).catch(() => null);
      this.orch._emit(runId, EventType.CHANGESET_APPLIED, {
        changesetId, files: cs.files.map((f) => f.path),
        additions: cs.additions, deletions: cs.deletions,
        gitBefore: before ? { branch: before.branch, files: before.files.length } : null,
        gitDiff: after ? { additions: after.additions, deletions: after.deletions, truncated: after.truncated } : null,
      });
    } catch {}
    return r;
  }

  async rollbackChangeset(runId, changesetId) {
    const r = await this.changesets.rollback(changesetId, { workspace: this.workspaceFor(this.orch.getRun(runId) || { runId }) });
    try {
      if (r.ok) this.orch._emit(runId, EventType.CHANGESET_ROLLED_BACK, { changesetId, restored: r.restored });
    } catch {}
    return r;
  }

  // --- verification ---

  async verifyChangeset(runId, changesetId = null, { origin = 'manual' } = {}) {
    const runtimeState = this.orch.activeRuns.get(runId);
    const records = this.verifications.get(runId) || [];
    try { this.orch._emit(runId, EventType.VERIFICATION_STARTED, { changesetId, origin }); } catch {}
    const t0 = Date.now();
    // 1. Diff inspection (always available, read-only).
    let diff = null;
    try { diff = await gitDiff(this.workspaceFor(runtimeState || { runId }), {}); } catch (e) { diff = { error: String(e.message).slice(0, 200) }; }
    records.push(verificationRecord({
      kind: VerificationKind.DIFF_INSPECTION,
      passed: !diff.error,
      summary: diff.error ? `diff unavailable: ${diff.error}` : `${diff.additions || 0} additions, ${diff.deletions || 0} deletions`,
      durationMs: Date.now() - t0,
    }));
    // 2. Tests (bounded, via the safe runner — never raw shell).
    const t1 = Date.now();
    try {
      const res = await this.orch.toolExecutor.execute('run_tests', { suite: 'session' }, runtimeState, {
        workspace: this.workspaceFor(runtimeState),
        signal: this.orch.control(runId)?.abortController?.signal, skipPostHook: true,
      });
      const passed = res.success === true;
      const art = this.artifacts.put({
        runId, type: 'test-report', name: 'test-report.log',
        content: `command: ${res.output?.command || res.result?.command || 'run_tests'}\nexit: ${res.output?.exitCode ?? res.result?.exitCode ?? '?'}\n${(res.output?.stdout || res.result?.stdout || '').slice(-3000)}\n${(res.output?.stderr || res.result?.stderr || '').slice(-1000)}`,
      });
      records.push(verificationRecord({
        kind: VerificationKind.TESTS,
        passed,
        summary: passed ? 'tests passed' : `tests failed: ${String(res.error || '').slice(0, 300)}`,
        artifacts: [art.reference], durationMs: Date.now() - t1,
      }));
    } catch (e) {
      records.push(verificationRecord({
        kind: VerificationKind.TESTS, passed: false,
        summary: `verification error: ${String((e && e.message) || e).slice(0, 300)}`,
        durationMs: Date.now() - t1,
      }));
    }
    this.verifications.set(runId, records.slice(-50));
    const failed = records.slice(-2).filter((v) => !v.passed);
    try {
      this.orch._emit(runId, failed.length ? EventType.VERIFICATION_FAILED : EventType.VERIFICATION_PASSED, {
        changesetId, origin,
        summary: records.slice(-2).map((v) => `${v.kind}:${v.passed ? 'pass' : 'fail'}`).join(', '),
      });
    } catch {}
    // Automatic rollback offer signal: patch applied + tests failed => mark
    // result so Session 4 can offer rollback (we do not auto-revert user-visible work).
    return { ok: failed.length === 0, records: records.slice(-2), diff };
  }

  // --- episodes: same-run continuation ---

  async continueRun(runId, userMessage) {
    const orch = this.orch;
    // Runs retire to terminal history after completion: resurrect COMPLETED /
    // FAILED runs back to active so continuation stays on the SAME run with
    // the SAME workspace/task context (never a new run). Mirrors retryRun's
    // resurrection, but allowed for COMPLETED (new episode) as well.
    if (!orch.activeRuns.has(runId) && orch.terminalRuns && orch.terminalRuns.has(runId)) {
      const term = orch.terminalRuns.get(runId);
      if (!term || !term.runtimeState || !term.control) return { ok: false, error: 'run not found' };
      if (term.control.running) return { ok: false, error: 'run is already executing', code: 'busy' };
      orch.terminalRuns.delete(runId);
      if (Array.isArray(orch.terminalOrder)) orch.terminalOrder = orch.terminalOrder.filter((id) => id !== runId);
      orch.activeRuns.set(runId, term.runtimeState);
      orch.runControl.set(runId, term.control);
      // Re-arm abort state for the new episode.
      try {
        term.control.abort = false;
        term.control.abortController = new AbortController();
        term.control.running = false;
      } catch {}
    }
    const rs = orch.activeRuns.get(runId) || (orch.getRun ? orch.getRun(runId) : null);
    if (!rs) return { ok: false, error: 'run not found' };
    const ctrl = orch.control(runId);
    if (!ctrl) return { ok: false, error: 'run has no control record' };
    if (ctrl.running) return { ok: false, error: 'run is already executing', code: 'busy' };
    const terminal = new Set([TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.CANCELLED]);
    // Finish the previous episode (if still open) without duplicating side effects.
    const prev = this.episodes.current(runId);
    if (prev && prev.status === EpisodeStatus.RUNNING) {
      this.episodes.finish(runId, prev.episodeId, rs.status === TaskStatus.FAILED ? EpisodeStatus.FAILED : EpisodeStatus.COMPLETED);
      try { orch._emit(runId, EventType.EPISODE_COMPLETED, { episodeId: prev.episodeId, status: rs.status }); } catch {}
    }
    const parent = prev ? prev.episodeId : null;
    const ep = this.episodes.start(runId, { parentEpisodeId: parent, goal: String(userMessage || '').slice(0, 1000) });
    try { orch._emit(runId, EventType.EPISODE_STARTED, { episodeId: ep.episodeId, parentEpisodeId: parent }); } catch {}
    if (terminal.has(rs.status)) {
      // Reopen the run for a new episode: COMPLETED -> RETRYING is the only
      // legal re-entry (state-machine extension, documented dependency).
      try { orch.transition(rs, TaskStatus.RETRYING); }
      catch { rs.updateStatus(TaskStatus.RETRYING); try { ctrl.machine.reset(TaskStatus.RETRYING); } catch {} }
    }
    // Idempotency keys are step-derived and preserved, so re-executed tool
    // calls return stored results instead of duplicating side effects.
    // startRun appends the user message to the preserved history (queryable)
    // and reuses the same workspace/task context.
    await orch.startRun(runId, userMessage);
    // Return the full contract the frontend/tests rely on: ok + episode +
    // runId so callers never dereference undefined.status.
    return { ok: true, episode: ep, runId, status: rs.status };
  }

  // User intervention during active execution becomes a runtime constraint
  // (not just appended text): parsed command + note into context.
  async userMessage(runId, text) {
    const cmd = parseRuntimeCommand(text);
    const orch = this.orch;
    if (cmd.type === RuntimeCommand.STOP) {
      await orch.cancelRun(runId, 'user stop');
      return { ok: true, command: cmd.type };
    }
    if (cmd.type === RuntimeCommand.PAUSE) {
      this.pauseRun(runId);
      return { ok: true, command: cmd.type };
    }
    if (cmd.type === RuntimeCommand.RESUME) {
      this.resumeRun(runId);
      return { ok: true, command: cmd.type };
    }
    if ([RuntimeCommand.CONSTRAIN_PATHS, RuntimeCommand.FORBID_PATHS, RuntimeCommand.USE_BRANCH, RuntimeCommand.ADD_NOTE].includes(cmd.type)) {
      if (cmd.type !== RuntimeCommand.ADD_NOTE) this.constraints.applyCommand(runId, cmd);
      // The caller emits TASK_UPDATED and continues the normal message flow;
      // this only records the structured constraint (never just appends text).
      return { ok: true, command: cmd.type, constraints: this.constraints.get(runId) };
    }
    return { ok: true, command: 'none' };
  }

  // --- pause / resume (cooperative) ---

  pauseRun(runId) {
    const orch = this.orch;
    const rs = orch.activeRuns.get(runId);
    const state = this.pause.requestPause(runId);
    // Best-effort lifecycle move at a safe boundary; the gate settles
    // PAUSING -> PAUSED before the next tool call.
    if (rs && state === PauseState.PAUSING) {
      try { orch.transition(rs, TaskStatus.PAUSING); } catch {}
      try { orch._emit(runId, EventType.EXECUTION_PAUSED, { phase: 'pausing' }); } catch {}
    }
    return state;
  }

  resumeRun(runId) {
    const orch = this.orch;
    const rs = orch.activeRuns.get(runId);
    const state = this.pause.requestResume(runId);
    if (rs && state === PauseState.RESUMING) {
      try {
        const cur = orch.control(runId)?.machine.getState();
        if (cur === TaskStatus.PAUSED) orch.transition(rs, TaskStatus.RESUMING);
        else if (cur === TaskStatus.PAUSING) orch.transition(rs, TaskStatus.PAUSED);
      } catch {}
      const settled = this.pause.settleResume(runId);
      try {
        const cur2 = orch.control(runId)?.machine.getState();
        if (cur2 === TaskStatus.RESUMING) orch.transition(rs, TaskStatus.EXECUTING);
        else if (cur2 === TaskStatus.PAUSED) orch.transition(rs, TaskStatus.EXECUTING);
      } catch {}
      try { orch._emit(runId, EventType.EXECUTION_RESUMED, { at: now() }); } catch {}
      return settled;
    }
    return state;
  }

  // --- recovery: restart-safe resume with UNKNOWN semantics ---

  checkpointNow(runId, extra = {}) {
    const orch = this.orch;
    const rs = orch.activeRuns.get(runId);
    if (!rs) return null;
    const ctrl = orch.control(runId);
    const ep = this.episodes.current(runId);
    const snap = rs.toSnapshot();
    const ckpt = buildCheckpoint({
      runId,
      episodeId: ep ? ep.episodeId : null,
      step: rs.execution.currentStep,
      planVersion: this.plans.view(runId)?.version ?? null,
      model: rs.model.currentModel,
      toolHistoryTail: (rs.tools.recentToolCalls || []).slice(-10),
      changesetIds: this.changesets.listForRun(runId).map((c) => c.id),
      contextFingerprint: fingerprintContext(rs.context.contextItems || []),
      successCriteria: extra.successCriteria || [],
      pendingApprovalIds: this.approvals.pendingForRun(runId).map((a) => a.id),
      workspaceHash: extra.workspaceHash || '',
      extra: { snapshot: snap },
    });
    // Also record in Session-1 CheckpointManager (durable idempotency
    // foundation stays authoritative; this is the actionable extension).
    try {
      orch.checkpointManager.createCheckpoint(runId, 'step_complete', snap, { stepNumber: rs.execution.currentStep });
    } catch {}
    return ckpt;
  }

  // Advisory crash analysis for a live run (diagnostics + events only).
  //
  // Division of responsibility (do not merge the two paths):
  //   - Run-level recovery (retry after failure, restart reconciliation) is
  //     owned by RecoveryService (src/core/recovery-service.js): it
  //     VALIDATES checkpoints, RESTORES runtime/control state, and resumes
  //     execution. That is the only path that continues a run.
  //   - This method only ADVISES: it inspects in-flight tool records and
  //     reports decideRecovery outcomes without restoring anything.
  // Both paths share the same decideRecovery rules (./recovery.js) — never
  // inline a second copy of the decision table.
  async recover(runId, { toolRecord = null, idempotencyKnownCompleted = false, workspaceHash = '', workspaceHashAtCheckpoint = '' } = {}) {
    const lastCheckpoint = this.checkpointNow(runId);
    const exec = this.orch.toolExecutor;
    // In-flight tool records at crash time are UNKNOWN unless the
    // idempotency store proves completion.
    let records = [];
    if (toolRecord) records = [toolRecord];
    else if (exec && typeof exec.inFlightRecords === 'function') {
      try { records = exec.inFlightRecords().filter((r) => r.runId === runId); } catch { records = []; }
    }
    const decisions = [];
    try { this.orch._emit(runId, EventType.EXECUTION_RECOVERY_STARTED, { checkpointId: lastCheckpoint?.checkpointId || null }); } catch {}
    if (!records.length) {
      const d = decideRecovery({ lastCheckpoint, toolRecord: null, idempotencyKnownCompleted: false, workspaceHash, workspaceHashAtCheckpoint });
      decisions.push({ ...d, scope: 'run' });
    } else {
      for (const rec of records) {
        const known = idempotencyKnownCompleted || (exec.completedKeys && exec.completedKeys.has(rec.idempotencyKey));
        const d = decideRecovery({
          lastCheckpoint,
          toolRecord: {
            state: known ? SideEffectState.COMPLETED : SideEffectState.UNKNOWN,
            retryable: true, destructive: /push|deploy|install|reset|clean/.test(rec.toolName || ''),
            idempotent: !!rec.idempotencyKey,
          },
          idempotencyKnownCompleted: !!known,
          workspaceHash, workspaceHashAtCheckpoint,
        });
        decisions.push({ ...d, tool: rec.toolName, executionId: rec.executionId });
      }
    }
    const log = this.recoveryLog.get(runId) || [];
    log.push({ at: now(), checkpointId: lastCheckpoint?.checkpointId || null, decisions });
    this.recoveryLog.set(runId, log.slice(-20));
    const blocked = decisions.some((d) => d.decision === RecoveryDecision.MARK_UNKNOWN || d.decision === RecoveryDecision.ASK_USER);
    try {
      this.orch._emit(runId, blocked ? EventType.EXECUTION_RECOVERY_BLOCKED : EventType.EXECUTION_RECOVERED, { decisions });
    } catch {}
    return { checkpoint: lastCheckpoint, decisions, blocked };
  }

  retryPolicy(input) { return retryDecision(input); }
  backoffFor(attempt) { return backoffForAttempt(attempt); }

  // --- plans ---

  createPlan(runId, descriptions) {
    const plan = this.plans.create(runId, descriptions);
    try { this.orch._emit(runId, EventType.PLAN_CREATED, { steps: plan.steps.length }); } catch {}
    return plan;
  }

  adaptPlan(runId, patch) {
    const plan = this.plans.adapt(runId, patch);
    try { this.orch._emit(runId, EventType.PLAN_UPDATED, { version: plan?.version }); } catch {}
    return plan;
  }

  // --- completion result (honest: MODEL_STOPPED != TASK_COMPLETED) ---

  buildResult(runId, { summary = '', goal = '' } = {}) {
    const orch = this.orch;
    const rs = orch.activeRuns.get(runId);
    const ctrl = orch.control(runId);
    const verifications = this.verifications.get(runId) || [];
    const changesets = this.changesets.listForRun(runId);
    const appliedChanges = changesets.filter((c) => c.status === ChangesetStatus.APPLIED);
    const hasUnverifiedChanges = appliedChanges.length > 0 && !verifications.some((v) => v.passed && v.kind === VerificationKind.TESTS);
    const failedTools = (rs?.tools.recentToolCalls || []).filter((c) => c && c.success === false);
    const lastAssistant = ctrl ? [...(ctrl.messages || [])].reverse().find((m) => m.role === 'assistant') : null;
    const requiredVerification = appliedChanges.length ? [VerificationKind.TESTS] : [];
    const result = agentResult({
      status: rs?.status === TaskStatus.COMPLETED
        ? (hasUnverifiedChanges ? 'VERIFICATION_INCOMPLETE' : 'TASK_COMPLETED')
        : rs?.status === TaskStatus.FAILED ? 'FAILED'
        : rs?.status === TaskStatus.CANCELLED ? 'CANCELLED'
        : lastAssistant ? 'MODEL_STOPPED' : 'UNKNOWN',
      goal: goal || rs?.task.objective || '',
      summary: summary || (lastAssistant ? String(lastAssistant.content).slice(0, 2000) : ''),
      plan: this.plans.view(runId),
      completedSteps: (rs?.execution.stepHistory || []).filter((s) => s.status === 'completed'),
      changeset: changesets[changesets.length - 1] || null,
      artifacts: this.artifacts.listForRun(runId).map((a) => a.reference),
      verification: verifications,
      approvals: this.approvals.listForRun(runId, true),
      toolExecutions: (rs?.tools.recentToolCalls || []).slice(-50),
      episodes: this.episodes.list(runId),
      unresolvedIssues: failedTools.map((t) => `tool ${t.name} failed`),
      requiredVerification,
    });
    this.results.set(runId, result);
    return result;
  }

  // --- Session-4 view: one clean backend state ---

  executionView(runId) {
    const orch = this.orch;
    // Live runs first, then retired terminal history (continuation queries
    // the view after completion; never return null for a known run).
    const rs = (orch.activeRuns && orch.activeRuns.get(runId))
      || (orch.getRun ? orch.getRun(runId) : null);
    if (!rs) return null;
    const pending = this.approvals.pendingForRun(runId);
    const changesets = this.changesets.listForRun(runId);
    const last = changesets[changesets.length - 1] || null;
    const verifications = (this.verifications.get(runId) || []).slice(-10);
    // Session-4 contract: accurate state, never empty fakes. files = real
    // changeset paths; tests = real verification records of kind tests.
    const files = [];
    for (const cs of changesets) {
      for (const f of cs.files || []) files.push(typeof f === 'string' ? f : f.path);
    }
    const tests = verifications.filter((v) => v && (v.kind === 'tests' || /test/i.test(String(v.kind || ''))));
    return {
      runId,
      status: rs.status,
      pause: this.pause.state(runId),
      plan: this.plans.view(runId),
      readySteps: this.plans.readySteps(runId),
      currentAction: this._currentAction(runId),
      pendingApprovals: pending,
      waitingForApproval: pending.length > 0,
      changesets: changesets.map((c) => ({ ...c })),
      // Aliases the frontend uses interchangeably; all reference the same
      // underlying records (no duplicated sources of truth).
      changes: changesets.map((c) => ({ ...c })),
      files: [...new Set(files)],
      tests,
      lastChangeset: last,
      verifications,
      episodes: this.episodes.list(runId),
      currentEpisode: this.episodes.current(runId),
      constraints: this.constraints.get(runId),
      toolHealth: this.health.all(),
      observations: (this.observations.get(runId) || []).slice(-20),
      recovery: (this.recoveryLog.get(runId) || []).slice(-5),
      result: this.results.get(runId) || null,
    };
  }

  _currentAction(runId) {
    const ctrl = this.orch.control(runId);
    const trace = ctrl?.trace || [];
    const last = trace[trace.length - 1];
    return last ? { type: last.type, label: last.label, status: last.status } : null;
  }

  // --- git passthrough (policy-gated) ---

  async git(runId, op, args = {}) {
    const policy = this.policyFor(runId);
    const readOps = { status: () => gitStatus(this.workspace), diff: () => gitDiff(this.workspace, args), log: () => gitLog(this.workspace, args.limit), branch: () => gitBranches(this.workspace) };
    if (readOps[op]) return { ok: true, ...(await readOps[op]()) };
    // Mutating git requires approval under the tool policy.
    const toolName = op === 'create_branch' ? 'git_create_branch' : op === 'add' ? 'git_add' : op === 'commit' ? 'git_commit' : `git_${op}`;
    const gate = await this._preGate(runId, toolName, args, { name: toolName });
    if (!gate.allowed) return { ok: false, needsApproval: gate.code === 'needs_approval', approvalId: gate.approvalId || null, error: gate.reason };
    try {
      if (op === 'create_branch') return { ok: true, ...(await gitCreateBranch(this.workspace, args.name, args.checkout !== false)) };
      if (op === 'add') return { ok: true, ...(await gitAdd(this.workspace, args.paths)) };
      if (op === 'commit') {
        const allowedPaths = args.allowUnrelated ? null : this._agentPaths(runId);
        return { ok: true, ...(await gitCommit(this.workspace, args.message, { allowedPaths })) };
      }
      return { ok: false, error: `unsupported git op: ${op}` };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e).slice(0, 500), code: (e && e.code) || 'git_failure' };
    }
  }

  _agentPaths(runId) {
    const paths = [];
    for (const cs of this.changesets.listForRun(runId)) {
      for (const f of cs.files || []) paths.push(f.path);
    }
    return paths.length ? [...new Set(paths)] : null;
  }

  async envProfile() {
    const [profile, project] = await Promise.all([
      environmentProfile(this.workspace).catch((e) => ({ error: String(e.message).slice(0, 200) })),
      detectProject(this.workspace).catch(() => null),
    ]);
    return { ...profile, project };
  }

  clearRun(runId) {
    this.approvals.clearRun(runId);
    this.changesets.clearRun(runId);
    this.plans.clearRun(runId);
    this.episodes.clearRun(runId);
    this.pause.clearRun(runId);
    this.constraints.clearRun(runId);
    this.artifacts.clearRun(runId);
    this.policies.delete(runId);
    this.observations.delete(runId);
    this.verifications.delete(runId);
    this.results.delete(runId);
    this.recoveryLog.delete(runId);
  }
}

module.exports = {
  ExecutionController,
  attachExecution,
  AutonomyMode,
  ApprovalMode,
  NetworkMode,
  ToolCategory,
  RiskLevel,
  ToolStatus,
  TOOL_DEFINITIONS,
};
