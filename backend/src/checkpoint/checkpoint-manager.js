'use strict';

const { CheckpointType } = require('../core/types');
const { generateId, now } = require('../state/runtime-state');

class ExecutionCheckpoint {
  constructor(runId, type, stateSnapshot, options = {}) {
    this.checkpointId = generateId('checkpoint');
    this.runId = runId;
    this.type = type;
    this.timestamp = now();
    this.stateSnapshot = stateSnapshot;
    this.stepNumber = options.stepNumber || 0;
    this.idempotencyKey = options.idempotencyKey || `${runId}:${type}:${options.stepNumber}:${Date.now()}`;
    this.metadata = options.metadata || {};
    this.completed = false;
    this.completedAt = null;
  }

  markCompleted(result = null) {
    this.completed = true;
    this.completedAt = now();
    this.result = result;
  }

  isCompleted() {
    return this.completed;
  }

  toJSON() {
    return {
      checkpointId: this.checkpointId,
      runId: this.runId,
      type: this.type,
      timestamp: this.timestamp,
      stepNumber: this.stepNumber,
      idempotencyKey: this.idempotencyKey,
      metadata: this.metadata,
      completed: this.completed,
      completedAt: this.completedAt,
      result: this.result
    };
  }
}

class CheckpointManager {
  constructor(options = {}) {
    this.checkpoints = new Map();
    this.idempotencyKeys = new Set();
    this.maxCheckpoints = options.maxCheckpoints || 50;
  }

  createCheckpoint(runId, type, stateSnapshot, options = {}) {
    const checkpoint = new ExecutionCheckpoint(runId, type, stateSnapshot, options);
    
    if (this.idempotencyKeys.has(checkpoint.idempotencyKey)) {
      return { checkpoint, duplicate: true };
    }
    
    this.idempotencyKeys.add(checkpoint.idempotencyKey);
    
    if (!this.checkpoints.has(runId)) {
      this.checkpoints.set(runId, []);
    }
    
    const runCheckpoints = this.checkpoints.get(runId);
    runCheckpoints.push(checkpoint);
    
    if (runCheckpoints.length > this.maxCheckpoints) {
      const removed = runCheckpoints.shift();
      this.idempotencyKeys.delete(removed.idempotencyKey);
    }
    
    return { checkpoint, duplicate: false };
  }

  getCheckpoint(runId, checkpointId) {
    const runCheckpoints = this.checkpoints.get(runId) || [];
    return runCheckpoints.find(c => c.checkpointId === checkpointId) || null;
  }

  getLastCheckpoint(runId, type = null) {
    const runCheckpoints = this.checkpoints.get(runId) || [];
    
    if (type) {
      const filtered = runCheckpoints.filter(c => c.type === type);
      return filtered[filtered.length - 1] || null;
    }
    
    return runCheckpoints[runCheckpoints.length - 1] || null;
  }

  getCheckpointsByType(runId, type) {
    const runCheckpoints = this.checkpoints.get(runId) || [];
    return runCheckpoints.filter(c => c.type === type);
  }

  markCheckpointCompleted(runId, checkpointId, result = null) {
    const checkpoint = this.getCheckpoint(runId, checkpointId);
    if (checkpoint) {
      checkpoint.markCompleted(result);
      return true;
    }
    return false;
  }

  isIdempotent(runId, idempotencyKey) {
    return this.idempotencyKeys.has(idempotencyKey);
  }

  canResumeFrom(runId, checkpointId) {
    const checkpoint = this.getCheckpoint(runId, checkpointId);
    return checkpoint && checkpoint.completed;
  }

  getResumeState(runId, checkpointId) {
    const checkpoint = this.getCheckpoint(runId, checkpointId);
    if (!checkpoint || !checkpoint.completed) {
      return null;
    }
    return checkpoint.stateSnapshot;
  }

  clearRun(runId) {
    const runCheckpoints = this.checkpoints.get(runId) || [];
    for (const cp of runCheckpoints) {
      this.idempotencyKeys.delete(cp.idempotencyKey);
    }
    this.checkpoints.delete(runId);
  }

  getAllCheckpoints(runId) {
    return this.checkpoints.get(runId) || [];
  }
}

class RecoveryManager {
  constructor(checkpointManager, options = {}) {
    this.checkpointManager = checkpointManager;
    this.config = {
      maxRecoveryAttempts: options.maxRecoveryAttempts || 3,
      ...options
    };
  }

  async recoverFromCheckpoint(runId, checkpointId, runtimeState) {
    const checkpoint = this.checkpointManager.getCheckpoint(runId, checkpointId);
    
    if (!checkpoint) {
      return { success: false, error: 'Checkpoint not found' };
    }
    
    if (!checkpoint.completed) {
      return { success: false, error: 'Checkpoint not completed' };
    }
    
    const snapshot = checkpoint.stateSnapshot;
    
    runtimeState.task.status = snapshot.task.status;
    runtimeState.task.progress = snapshot.task.progress;
    runtimeState.model.currentModel = snapshot.model.currentModel;
    runtimeState.model.currentProvider = snapshot.model.currentProvider;
    runtimeState.context.currentTokens = snapshot.context.currentTokens;
    runtimeState.context.contextItems = snapshot.context.contextItems;
    runtimeState.budget.currentSpend = snapshot.budget.currentSpend;
    runtimeState.execution.currentStep = snapshot.execution.currentStep;
    runtimeState.execution.stepHistory = snapshot.execution.stepHistory;
    runtimeState.status = snapshot.status;
    runtimeState.updatedAt = now();
    
    return { success: true, checkpoint, restoredState: snapshot };
  }

  async recoverFromLastCheckpoint(runId, runtimeState, type = null) {
    const checkpoint = this.checkpointManager.getLastCheckpoint(runId, type);
    
    if (!checkpoint) {
      return { success: false, error: 'No checkpoint available' };
    }
    
    return this.recoverFromCheckpoint(runId, checkpoint.checkpointId, runtimeState);
  }

  createIdempotencyKey(runId, operation, stepNumber) {
    return `${runId}:${operation}:${stepNumber}`;
  }

  checkIdempotency(runId, operation, stepNumber) {
    const key = this.createIdempotencyKey(runId, operation, stepNumber);
    return this.checkpointManager.isIdempotent(runId, key);
  }
}

module.exports = {
  ExecutionCheckpoint,
  CheckpointManager,
  RecoveryManager
};