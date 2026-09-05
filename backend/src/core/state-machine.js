'use strict';

const { TaskStatus } = require('../core/types');

const STATE_TRANSITIONS = {
  [TaskStatus.CREATED]: [TaskStatus.PLANNING, TaskStatus.CANCELLED],
  [TaskStatus.PLANNING]: [TaskStatus.CONTEXT_BUILD, TaskStatus.FAILED, TaskStatus.CANCELLED],
  [TaskStatus.CONTEXT_BUILD]: [TaskStatus.MODEL_SELECT, TaskStatus.FAILED, TaskStatus.CANCELLED],
  [TaskStatus.MODEL_SELECT]: [TaskStatus.EXECUTING, TaskStatus.FAILED, TaskStatus.CANCELLED],
  [TaskStatus.EXECUTING]: [
    TaskStatus.WAITING_FOR_TOOL, 
    TaskStatus.OBSERVING, 
    TaskStatus.REOPTIMIZING, 
    TaskStatus.COMPLETED, 
    TaskStatus.FAILED, 
    TaskStatus.CANCELLED,
    TaskStatus.PAUSED,
    TaskStatus.PAUSING
  ],
  [TaskStatus.WAITING_FOR_TOOL]: [TaskStatus.EXECUTING, TaskStatus.RETRYING, TaskStatus.FAILED, TaskStatus.CANCELLED, TaskStatus.PAUSING],
  [TaskStatus.OBSERVING]: [TaskStatus.EXECUTING, TaskStatus.REOPTIMIZING, TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.CANCELLED, TaskStatus.PAUSING],
  [TaskStatus.REOPTIMIZING]: [TaskStatus.EXECUTING, TaskStatus.MODEL_SELECT, TaskStatus.CONTEXT_BUILD, TaskStatus.FAILED, TaskStatus.CANCELLED],
  // Session 5: RETRYING may resume mid-run (→ EXECUTING, state preserved) or
  // restart setup from scratch (→ PLANNING, e.g. failure happened before any
  // model was selected and there is nothing to preserve).
  [TaskStatus.RETRYING]: [TaskStatus.EXECUTING, TaskStatus.PLANNING, TaskStatus.FAILED, TaskStatus.CANCELLED],
  [TaskStatus.PAUSED]: [TaskStatus.EXECUTING, TaskStatus.RESUMING, TaskStatus.CANCELLED],
  // Session 3 cooperative pause: EXECUTING -> PAUSING -> PAUSED ->
  // RESUMING -> EXECUTING. Direct PAUSED -> EXECUTING kept for compat.
  [TaskStatus.PAUSING]: [TaskStatus.PAUSED, TaskStatus.CANCELLED],
  [TaskStatus.RESUMING]: [TaskStatus.EXECUTING, TaskStatus.CANCELLED],
  [TaskStatus.COMPLETED]: [TaskStatus.RETRYING],
  // Session 3: same-run continuation reopens a COMPLETED run as a new
  // execution episode (COMPLETED -> RETRYING is the only legal re-entry;
  // COMPLETED -> anything else stays rejected).
  [TaskStatus.FAILED]: [TaskStatus.RETRYING, TaskStatus.CANCELLED],
  [TaskStatus.CANCELLED]: []
};

const TERMINAL_STATES = [TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.CANCELLED];

class StateMachine {
  constructor(initialState = TaskStatus.CREATED) {
    this.currentState = initialState;
    this.history = [{ state: initialState, timestamp: new Date().toISOString() }];
    this.maxHistory = 100;
  }

  getState() {
    return this.currentState;
  }

  canTransition(toState) {
    const allowed = STATE_TRANSITIONS[this.currentState] || [];
    return allowed.includes(toState);
  }

  transition(toState, metadata = {}) {
    if (!this.canTransition(toState)) {
      const error = new Error(`Invalid state transition: ${this.currentState} -> ${toState}`);
      error.currentState = this.currentState;
      error.attemptedState = toState;
      error.allowedStates = STATE_TRANSITIONS[this.currentState] || [];
      throw error;
    }
    
    const previousState = this.currentState;
    this.currentState = toState;
    
    this.history.push({
      state: toState,
      previousState,
      timestamp: new Date().toISOString(),
      metadata
    });
    
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }
    
    return { previousState, currentState: toState };
  }

  isTerminal() {
    return TERMINAL_STATES.includes(this.currentState);
  }

  getHistory() {
    return [...this.history];
  }

  getPossibleTransitions() {
    return STATE_TRANSITIONS[this.currentState] || [];
  }

  reset(initialState = TaskStatus.CREATED) {
    this.currentState = initialState;
    this.history = [{ state: initialState, timestamp: new Date().toISOString() }];
  }

  static validateSequence(sequence) {
    for (let i = 1; i < sequence.length; i++) {
      const from = sequence[i - 1];
      const to = sequence[i];
      const allowed = STATE_TRANSITIONS[from] || [];
      if (!allowed.includes(to)) {
        return { valid: false, at: i, from, to, allowed };
      }
    }
    return { valid: true };
  }
}

module.exports = {
  StateMachine,
  STATE_TRANSITIONS,
  TERMINAL_STATES
};