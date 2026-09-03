'use strict';

const { ContextManager } = require('../interfaces');
const { ContextItem } = require('../state/runtime-state');
const { EventType } = require('../core/types');
const { generateId, now } = require('../state/runtime-state');

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
    
    const candidates = contextState.contextItems
      .filter(i => i.status === 'KEEP' && i.relevance < 0.7)
      .sort((a, b) => a.relevance - b.relevance);
    
    for (const item of candidates) {
      if (reclaimed >= toReclaim) break;
      
      const compressedTokens = Math.floor(item.tokens * this.config.compressionRatio);
      const itemReclaimed = contextState.compressItem(item.id, compressedTokens);
      
      if (itemReclaimed > 0) {
        reclaimed += itemReclaimed;
        compressedItems.push({ id: item.id, title: item.title, reclaimedTokens: itemReclaimed, newTokens: compressedTokens });
        
        if (this.eventBus) {
          this.eventBus.emit(runtimeState.runId, EventType.CONTEXT_COMPRESSED, {
            itemId: item.id,
            title: item.title,
            reclaimedTokens: itemReclaimed,
            newTokens: compressedTokens
          });
        }
      }
    }
    
    return { reclaimed, items: compressedItems };
  }

  async getRelevantContext(runtimeState, query, maxTokens) {
    const contextState = runtimeState.context;
    const keywords = query.toLowerCase().split(/\s+/);
    
    const scored = contextState.contextItems.map(item => {
      const text = `${item.title} ${item.source}`.toLowerCase();
      const matches = keywords.filter(k => text.includes(k)).length;
      return { item, score: matches / keywords.length };
    });
    
    scored.sort((a, b) => b.score - a.score);
    
    const result = [];
    let usedTokens = 0;
    
    for (const { item, score } of scored) {
      if (usedTokens + item.tokens <= maxTokens && score > 0) {
        result.push(item);
        usedTokens += item.tokens;
      }
    }
    
    return result;
  }

  async estimateTokens(content) {
    return Math.ceil(content.length / 4);
  }

  getContextState(runtimeState) {
    return runtimeState.context.toJSON();
  }

  on(event, handler) {}
}

module.exports = {
  InMemoryContextManager
};