'use strict';

// RecoveryService — the ONE place that turns a failure + durable signals
// into a recovery action. Used by manual retry (Orchestrator.retryRun) and by
// restart reconciliation (server restorePersisted) so both share identical
// semantics: validate checkpoint -> inspect last side effect -> consult
// idempotency -> decide -> restore cursor/state -> continue.
//
// Recovery actions:
//   resume          continue stepping after the checkpoint cursor
//   retry_step      re-run from the cursor (nothing irreversible in flight)
//   skip_completed  side effect provably done; do not re-execute it
//   ask_user        needs operator input (stale/ambiguous/non-retryable)
//   mark_unknown    destructive/in-flight outcome; recorded UNKNOWN, not retried
//   unrecoverable   no valid checkpoint and unsafe to restart blindly

const { CheckpointType } = require('./types');
const {
  validateCheckpoint,
  captureControlSnapshot,
  restoreControlSnapshot,
} = require('../checkpoint/checkpoint-manager');

function defaultToolRecord() {
  return { state: 'not_started', tool: null, idempotencyKey: null, destructive: false, idempotent: true, retryable: true };
}

// Classify a tool definition for recovery: destructive tools must never be
// blindly re-run when their outcome is unknown.
function classifySideEffect(definition) {
  const risk = String((definition && definition.risk) || 'low').toLowerCase();
  const name = String((definition && definition.name) || '');
  const destructive = risk === 'high' || risk === 'critical';
  const readOnly = ['read_file', 'search_code', 'git_status', 'git_diff', 'git_log', 'git_branch', 'env_inspect', 'web_search', 'fetch_url'].includes(name);
  return { destructive, idempotent: readOnly || risk === 'low', risk };
}

class RecoveryService {
  constructor({ checkpointManager, recoveryManager, logger = null } = {}) {
    if (!checkpointManager || !recoveryManager) throw new Error('RecoveryService requires checkpointManager + recoveryManager');
    this.checkpoints = checkpointManager;
    this.recovery = recoveryManager;
    this.log = logger;
  }

  _log(level, msg, extra) {
    try {
      if (this.log && typeof this.log[level] === 'function') this.log[level](msg, extra);
    } catch {}
  }

  // Take a completed, restorable checkpoint for a run (runtime snapshot +
  // control snapshot). Returns the checkpoint or null.
  captureCheckpoint(runtimeState, ctrl, type = CheckpointType.STEP_COMPLETE, extra = {}) {
    try {
      const stepNumber = Number.isFinite(extra.stepNumber)
        ? extra.stepNumber
        : (runtimeState && runtimeState.execution ? runtimeState.execution.currentStep : 0);
      const { checkpoint } = this.checkpoints.createCheckpoint(
        runtimeState.runId,
        type,
        runtimeState.toSnapshot(),
        { stepNumber, controlSnapshot: captureControlSnapshot(ctrl), metadata: extra.metadata || {} },
      );
      if (checkpoint && typeof checkpoint.markCompleted === 'function') {
        checkpoint.markCompleted(extra.result !== undefined ? extra.result : { step: stepNumber });
      }
      if (ctrl && Number.isFinite(ctrl.completedCheckpoints)) ctrl.completedCheckpoints++;
      return checkpoint;
    } catch (e) {
      this._log('warn', 'checkpoint capture failed', { runId: runtimeState && runtimeState.runId, error: String((e && e.message) || e).slice(0, 160) });
      return null;
    }
  }

  // Full recovery flow. Mutates nothing until the plan is decided; on
  // resume/retry/skip it restores runtime + control state in place and
  // returns the cursor to continue from. Never throws for expected
  // validation outcomes — they are returned as plans.
  async recover({ runId, runtimeState, ctrl, idempotencyStore = null, toolRecord = null, checkpointId = null, workspaceHash = null, workspaceHashAtCheckpoint = null }) {
    const record = toolRecord || (ctrl && ctrl.lastToolEffect) || defaultToolRecord();
    const raw = checkpointId
      ? this.checkpoints.getCheckpoint(runId, checkpointId)
      : this.checkpoints.getLastCompletedCheckpoint(runId);
    const validation = validateCheckpoint(raw, runId);

    const plan = this.recovery.planRecovery({
      runId,
      checkpoint: validation.ok ? validation.checkpoint : null,
      validation,
      toolRecord: record,
      idempotencyStore,
      workspaceHash,
      workspaceHashAtCheckpoint,
    });
    this._log('info', 'recovery plan', { runId, action: plan.action, cursor: plan.cursor, reason: String(plan.reason).slice(0, 200) });

    if (plan.action === 'ask_user' || plan.action === 'mark_unknown' || plan.action === 'unrecoverable') {
      return { plan, checkpoint: validation.ok ? validation.checkpoint : null, restored: false, record };
    }

    // Restore durable state for resume / retry_step / skip_completed.
    if (validation.ok) {
      const res = await this.recovery.recoverFromCheckpoint(runId, validation.checkpoint.checkpointId, runtimeState);
      if (!res.success) {
        return { plan: { action: 'unrecoverable', reason: res.error, cursor: null }, checkpoint: null, restored: false, record };
      }
      if (ctrl && res.restoredControl) restoreControlSnapshot(ctrl, res.restoredControl);
      // Cursor discipline: the execution cursor returns to the last
      // COMPLETED step so step numbers continue monotonically and the next
      // uncheckpointed step reuses its original step number (which keeps
      // step-scoped idempotency keys stable for dedupe).
      const cursor = Number.isFinite(plan.cursor) ? plan.cursor : 0;
      if (runtimeState && runtimeState.execution) {
        runtimeState.execution.currentStep = cursor;
        runtimeState.execution.totalSteps = Math.max(runtimeState.execution.totalSteps || 0, cursor);
      }
      return { plan, checkpoint: res.checkpoint, restored: true, record, cursor };
    }

    // No checkpoint but explicitly safe (nothing in flight): continue from
    // preserved live state at step 0 without touching accounting.
    // Cursor null means "keep the preserved live cursor" (resume/skip without
    // a checkpoint); the caller falls back to runtimeState.execution state.
    return { plan, checkpoint: null, restored: false, record, cursor: plan.cursor ?? null };
  }
}

module.exports = { RecoveryService, classifySideEffect, defaultToolRecord };
