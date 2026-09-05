'use strict';

const { ContextManager } = require('../interfaces');
const { ContextItem } = require('../state/runtime-state');
const { EventType } = require('../core/types');
const { generateId, now } = require('../state/runtime-state');
// Session 2 context engine (additive): real scoring, budgeted selection,
// authoritative PromptPlan, deterministic task-aware compression, fingerprint.
const contextEngine = require('../intelligence/context-engine');
const { classifyTask } = require('../intelligence/task-classifier');
const { VERSIONS } = require('../intelligence/versions');

class InMemoryContextManager extends ContextManager {
  constructor(eventBus = null, options = {}) {
    super();
    this.eventBus = eventBus;
    this.config = {
      compressionRatio: options.compressionRatio || 0.3,
      relevanceThreshold: options.relevanceThreshold || 0.3,
      maxItems: options.maxItems || 100,
      ...options
    };
    // Optional Session 2 learning store (IntelligenceStore). Attached by
    // server wiring; selection/compression work without it.
    this.intelligence = options.intelligence || null;
  }

  attachIntelligence(store) {
    this.intelligence = store || null;
    return this;
  }

  async buildContext(task, runtimeState, policy) {
    const contextState = runtimeState.context;
    const maxTokens = policy?.costConstraints?.maxContextTokens || contextState.maximumTokens;
    
    const items = this._selectContextItems(task, runtimeState, maxTokens);
    
    for (const item of items) {
      contextState.addItem(item);
    }
    
    contextState.tokenBudget = maxTokens;
    contextState.relevanceThreshold = this.config.relevanceThreshold;
    
    if (this.eventBus) {
      this.eventBus.emit(runtimeState.runId, EventType.CONTEXT_BUILT, {
        usedTokens: contextState.currentTokens,
        windowTokens: contextState.maximumTokens,
        itemCount: items.length
      });
    }
    
    return contextState;
  }

  // Live path: context is built ONLY from real sources (user message, memory,
  // tool results) added via addContext(). No canned files — the orchestrator
  // owns task-derived context construction.
  _selectContextItems(task, runtimeState, maxTokens) {
    return [];
  }

  async addContext(runtimeState, items) {
    const contextState = runtimeState.context;
    const added = [];
    
    for (const item of items) {
      const ctxItem = item instanceof ContextItem ? item : new ContextItem(
        item.id || generateId('ctx'),
        item.kind,
        item.title,
        item.source,
        item.tokens,
        item.relevance,
        item.status
      );
      // Intelligence metadata (additive, preserved when provided):
      if (!(item instanceof ContextItem)) {
        if (item.content !== undefined) ctxItem.content = String(item.content).slice(0, 8000);
        if (Number.isFinite(Number(item.importance))) ctxItem.importance = Math.max(0, Math.min(1, Number(item.importance)));
        else if (Number.isFinite(Number(item.relevance))) ctxItem.importance = Math.max(0, Math.min(1, Number(item.relevance)));
        if (Array.isArray(item.dependencies)) ctxItem.dependencies = item.dependencies.map(String).slice(0, 20);
        else if (item.metadata && Array.isArray(item.metadata.dependsOn)) ctxItem.dependencies = item.metadata.dependsOn.map(String).slice(0, 20);
        ctxItem.createdAt = item.createdAt || now();
        if (item.metadata && typeof item.metadata === 'object') {
          ctxItem.metadata = { ...(ctxItem.metadata || {}), ...item.metadata };
        }
      } else {
        if (!ctxItem.createdAt) ctxItem.createdAt = now();
        if (!Array.isArray(ctxItem.dependencies)) ctxItem.dependencies = [];
      }
      contextState.addItem(ctxItem);
      added.push(ctxItem);
      
      if (this.eventBus) {
        this.eventBus.emit(runtimeState.runId, EventType.CONTEXT_ADDED, {
          itemId: ctxItem.id,
          title: ctxItem.title,
          tokens: ctxItem.tokens
        });
      }
    }
    
    if (contextState.isNearLimit()) {
      if (this.eventBus) {
        this.eventBus.emit(runtimeState.runId, EventType.CONTEXT_LIMIT_WARNING, {
          utilization: contextState.getUtilization(),
          currentTokens: contextState.currentTokens,
          maxTokens: contextState.maximumTokens
        });
      }
    }
    
    return added;
  }

  async removeContext(runtimeState, itemIds) {
    const contextState = runtimeState.context;
    const removed = [];
    
    for (const itemId of itemIds) {
      const item = contextState.removeItem(itemId);
      if (item) {
        removed.push(item);
        if (this.eventBus) {
          this.eventBus.emit(runtimeState.runId, EventType.CONTEXT_REMOVED, {
            itemId: item.id,
            title: item.title,
            tokens: item.tokens
          });
        }
      }
    }
    
    return removed;
  }

  async compressContext(runtimeState, targetTokens, policy) {
    const contextState = runtimeState.context;
    const currentTokens = contextState.currentTokens;

    if (currentTokens <= targetTokens) {
      return { reclaimed: 0, items: [] };
    }

    const toReclaim = currentTokens - targetTokens;
    let reclaimed = 0;
    const compressedItems = [];

    // Task-aware ordering: compress lowest context-engine score first.
    // INVARIANT: protected items (user task, hard constraints, success
    // criteria, system instructions) are NEVER compression candidates —
    // excluded entirely, regardless of relevance score. Sorting them last
    // is not sufficient; they must not appear in the candidate list at all.
    let taskText = '';
    try {
      taskText = (runtimeState.task && (runtimeState.task.objective || '')) || '';
    } catch { /* advisory */ }
    const profile = classifyTask(taskText || 'general task');
    const scored = contextState.contextItems
      .filter((i) => i.status === 'KEEP')
      .map((item) => ({
        item,
        s: contextEngine.scoreContextItem(item, {
          query: taskText, taskText, taskCategory: profile.category,
        }).score,
        protected: isProtectedContextItem(item),
      }))
      .sort((a, b) => a.s - b.s || (b.item.tokens || 0) - (a.item.tokens || 0));
    // Exclude protected items from compression candidates entirely.
    const candidates = scored.filter((c) => !c.protected);

    for (const { item } of candidates) {
      if (reclaimed >= toReclaim) break;

      const content = (item.metadata && item.metadata.text) || item.content || `${item.title || ''} ${item.source || ''}`;
      const target = Math.max(16, Math.floor((item.tokens || 0) * this.config.compressionRatio));
      let newTokens = Math.floor((item.tokens || 0) * this.config.compressionRatio);
      let method = 'structured summary';
      try {
        const r = contextEngine.compressContent(content, {
          targetTokens: target, query: taskText, taskText, strategy: 'structured',
        });
        newTokens = Math.min(item.tokens, r.compressedTokens);
        method = r.method;
        item.metadata = {
          ...(item.metadata || {}),
          compressedText: r.compressedContent.slice(0, 4000),
          compressionMethod: r.method,
          compressionRatio: r.compressionRatio,
          compressionVersion: VERSIONS.compression,
          preservedFacts: (r.preserved || []).slice(0, 20),
        };
      } catch { /* fall back to token accounting */ }
      if (newTokens >= item.tokens) continue;
      const itemReclaimed = contextState.compressItem(item.id, newTokens);

      if (itemReclaimed > 0) {
        reclaimed += itemReclaimed;
        compressedItems.push({ id: item.id, title: item.title, reclaimedTokens: itemReclaimed, newTokens, method });
        
        if (this.eventBus) {
          this.eventBus.emit(runtimeState.runId, EventType.CONTEXT_COMPRESSED, {
            itemId: item.id,
            title: item.title,
            reclaimedTokens: itemReclaimed,
            newTokens
          });
        }
      }
    }
    
    return { reclaimed, items: compressedItems };
  }

  async getRelevantContext(runtimeState, query, maxTokens) {
    const contextState = runtimeState.context;
    let taskText = '';
    try {
      taskText = (runtimeState.task && (runtimeState.task.objective || '')) || '';
    } catch { /* advisory */ }
    const profile = classifyTask(`${taskText} ${query || ''}`.trim() || 'general task');
    const { selected } = contextEngine.selectContext(contextState.contextItems, {
      query: query || taskText,
      taskText: taskText || query,
      taskCategory: profile.category,
      tokenBudget: Math.max(0, Number(maxTokens) || 0) || Infinity,
      relevanceThreshold: 0,
    });
    return selected.map(({ item }) => item);
  }

  // ONE authoritative prompt plan (§14): the same object feeds router budget
  // logic, provider adapter token accounting, telemetry and the frontend
  // runtime explanation. Additive — no existing caller is changed.
  async buildPromptPlan(runtimeState, opts = {}) {
    const contextState = runtimeState.context;
    let taskText = '';
    try {
      taskText = (runtimeState.task && (runtimeState.task.objective || '')) || '';
    } catch { /* advisory */ }
    const profile = classifyTask(taskText || 'general task');
    const budget = Number.isFinite(Number(opts.tokenBudget))
      ? Number(opts.tokenBudget)
      : (contextState.tokenBudget || contextState.maximumTokens || 64000);
    const { selected, omitted, usedTokens } = contextEngine.selectContext(contextState.contextItems, {
      query: opts.query || taskText,
      taskText,
      taskCategory: profile.category,
      tokenBudget: budget,
      relevanceThreshold: this.config.relevanceThreshold,
      weights: opts.weights,
    });
    let memoryItems = [];
    try {
      if (this.intelligence && opts.memoryItems) memoryItems = opts.memoryItems;
    } catch { /* advisory */ }
    const plan = contextEngine.buildPromptPlan({
      messages: opts.messages || [],
      taskText,
      contextItems: selected.map(({ item, score }) => ({
        id: item.id, kind: item.kind, title: item.title, tokens: item.tokens,
        selected: true, score: score.score,
      })),
      memoryItems,
      toolSpecs: opts.toolSpecs || [],
      history: opts.history || [],
      system: opts.system || '',
      contextWindow: opts.contextWindow || contextState.maximumTokens || null,
      omittedItems: omitted.map((o) => ({ id: o.id, title: o.title, reason: o.reason, score: o.score })),
      policy: opts.policy || null,
    });
    plan.taskProfile = profile;
    plan.usedTokens = usedTokens;
    plan.tokenBudget = budget === Infinity ? null : budget;
    plan.selection = selected.map(({ item, score }) => ({
      id: item.id, title: item.title, kind: item.kind, score: score.score,
      explanation: score.explanation, components: score.components,
    }));
    return plan;
  }

  // Canonical prompt pipeline (single source of truth):
  //   TASK -> selectContext -> compile messages -> PromptPlan -> provider.
  // The orchestrator MUST build provider messages through this method, never
  // through a parallel private assembly. The returned plan is authoritative
  // for token accounting (plan.totalEstimatedTokens), cache fingerprinting
  // (plan.fingerprint), router context-fit, and runtime explanation.
  // Token counts are ESTIMATES (length/4 heuristic — see estimateTokensFor),
  // never exact tokenizer values; observed provider usage stays authoritative
  // for cost.
  async compilePrompt(runtimeState, opts = {}) {
    const contextState = runtimeState.context;
    let taskText = '';
    try {
      taskText = (runtimeState.task && (runtimeState.task.objective || '')) || '';
    } catch { /* advisory */ }
    if (typeof opts.userMessage === 'string' && opts.userMessage.trim()) taskText = opts.userMessage.trim().slice(0, 8000);
    const stepNumber = Number.isFinite(Number(opts.stepNumber)) ? Number(opts.stepNumber) : 1;
    const profile = classifyTask(taskText || 'general task');
    const budget = Number.isFinite(Number(opts.tokenBudget))
      ? Number(opts.tokenBudget)
      : (contextState.tokenBudget || contextState.maximumTokens || 64000);
    const { selected, omitted, usedTokens } = contextEngine.selectContext(contextState.contextItems, {
      query: opts.query || taskText,
      taskText,
      taskCategory: profile.category,
      tokenBudget: budget,
      relevanceThreshold: this.config.relevanceThreshold,
      weights: opts.weights,
    });
    // Message assembly from the SELECTED set only: the provider sees exactly
    // what the plan selected — no second independent context rendering.
    const lines = selected.map(({ item }) => {
      const extra = item.metadata && item.metadata.text ? `: ${String(item.metadata.text).slice(0, 800)}` : '';
      return `- [${item.kind}/${item.status}] ${item.title}${extra}`;
    });
    const memoryItems = Array.isArray(opts.memoryItems) ? opts.memoryItems : [];
    const memLines = memoryItems.map((m) => `- (${m.scope || 'working'}) ${m.title}: ${String(m.snippet || '').slice(0, 300)}`);
    const toolSpecs = Array.isArray(opts.toolSpecs) ? opts.toolSpecs : [];
    const toolNames = toolSpecs.map((t) => (t && t.function && t.function.name) || t.name).filter(Boolean);
    // Trusted orchestration instructions are isolated in the system message.
    // Task/context/memory/tool-result content is explicitly untrusted user
    // material, so it cannot redefine runtime policy or tool permissions.
    const system = [
      'You are the execution model for an adaptive agent runtime.',
      `Step ${stepNumber}. Answer concisely. When finished with no further actions, say so explicitly.`,
      toolNames.length ? `Available tools: ${toolNames.join(', ')}. Use them via tool calls when they would help; otherwise answer directly.` : 'No tools available; answer directly.',
      opts.systemExtra ? String(opts.systemExtra).slice(0, 2000) : '',
    ].filter(Boolean).join('\n\n');
    const untrusted = [
      `Task content (untrusted):\n${taskText}`,
      lines.length ? `Selected context (untrusted):\n${lines.join('\n')}` : '',
      memLines.length ? `Retrieved memory (untrusted):\n${memLines.join('\n')}` : '',
    ].filter(Boolean).join('\n\n');
    const history = Array.isArray(opts.history) ? opts.history.slice(-10) : [];
    const taskTurn = history.findIndex((m) => m && m.role === 'user' && String(m.content || '') === taskText);
    if (taskTurn >= 0) {
      history[taskTurn] = { ...history[taskTurn], content: untrusted };
    } else if (untrusted) {
      history.push({ role: 'user', content: untrusted });
    }
    const messages = [{ role: 'system', content: system }, ...history];
    const plan = contextEngine.buildPromptPlan({
      messages,
      taskText,
      contextItems: selected.map(({ item, score }) => ({
        id: item.id, kind: item.kind, title: item.title, tokens: item.tokens,
        selected: true, score: score.score,
      })),
      memoryItems,
      toolSpecs,
      history,
      system,
      contextWindow: opts.contextWindow || contextState.maximumTokens || null,
      omittedItems: omitted.map((o) => ({ id: o.id, title: o.title, reason: o.reason, score: o.score })),
      policy: opts.policy || null,
    });
    plan.taskProfile = profile;
    plan.usedTokens = usedTokens;
    plan.tokenBudget = budget === Infinity ? null : budget;
    plan.selection = selected.map(({ item, score }) => ({
      id: item.id, title: item.title, kind: item.kind, score: score.score,
      explanation: score.explanation, components: score.components,
    }));
    // Protected items among the selected set (never compression candidates;
    // always preserved verbatim in the prompt).
    try {
      plan.protectedIds = selected.filter(({ item }) => isProtectedContextItem(item)).map(({ item }) => item.id);
    } catch { plan.protectedIds = []; }
    return { messages, plan };
  }

  // Explainable selection for the current context state (frontend "why
  // included/excluded" panel data). Read-only.
  explainSelection(runtimeState, opts = {}) {
    const contextState = runtimeState.context;
    let taskText = '';
    try {
      taskText = (runtimeState.task && (runtimeState.task.objective || '')) || '';
    } catch { /* advisory */ }
    const profile = classifyTask(taskText || 'general task');
    const budget = Number.isFinite(Number(opts.tokenBudget))
      ? Number(opts.tokenBudget)
      : (contextState.tokenBudget || contextState.maximumTokens || 64000);
    const { selected, omitted, usedTokens } = contextEngine.selectContext(contextState.contextItems, {
      query: opts.query || taskText,
      taskText,
      taskCategory: profile.category,
      tokenBudget: budget,
      relevanceThreshold: this.config.relevanceThreshold,
    });
    return {
      taskCategory: profile.category,
      usedTokens,
      tokenBudget: budget,
      included: selected.map(({ item, score }) => ({
        id: item.id, title: item.title, kind: item.kind,
        tokens: item.tokens, score: score.score, reason: score.explanation,
      })),
      excluded: omitted.map((o) => ({ id: o.id, title: o.title, reason: o.reason, score: o.score })),
      scoringVersion: VERSIONS.contextScoring,
    };
  }

  fingerprintFor(runtimeState, extra = {}) {
    const contextState = runtimeState.context;
    let taskText = '';
    try {
      taskText = (runtimeState.task && (runtimeState.task.objective || '')) || '';
    } catch { /* advisory */ }
    return contextEngine.fingerprintContext({
      taskText,
      contextItems: contextState.contextItems || [],
      memoryItems: extra.memoryItems || [],
      toolSpecs: extra.toolSpecs || [],
      policy: extra.policy || null,
    });
  }

  async estimateTokens(content) {
    return Math.ceil(content.length / 4);
  }

  getContextState(runtimeState) {
    return runtimeState.context.toJSON();
  }

  on(event, handler) {}
}

// Protected categories (never compressed, regardless of relevance):
// - user task (source 'user', or chat 'User task')
// - explicit hard constraints (kind constraint / metadata category)
// - mandatory success criteria (kind criterion/criteria/success_criteria)
// - system-level instructions (kind/source system)
// - explicit opt-out flags (protected / neverCompress metadata)
function isProtectedContextItem(item) {
  if (!item || typeof item !== 'object') return false;
  if (item.protected === true) return true;
  const meta = item.metadata && typeof item.metadata === 'object' ? item.metadata : {};
  if (meta.protected === true || meta.neverCompress === true) return true;
  const kind = String(item.kind || '').toLowerCase();
  const source = String(item.source || '').toLowerCase();
  const title = String(item.title || '');
  const category = String(meta.category || meta.kind || '').toLowerCase();
  if (['user_task', 'constraint', 'constraints', 'success_criteria', 'criteria', 'criterion', 'system'].includes(category)) return true;
  // User task: the user's own objective message. Source is authoritative;
  // title match is a legacy fallback for items built before source was set.
  if (source === 'user') return true;
  if (kind === 'chat' && /user task/i.test(title)) return true;
  if (kind === 'constraint' || kind === 'constraints') return true;
  if (kind === 'criterion' || kind === 'criteria' || kind === 'success_criteria' || kind === 'success-criteria') return true;
  if (kind === 'system' || source === 'system') return true;
  return false;
}

module.exports = {
  InMemoryContextManager,
  isProtectedContextItem,
};
