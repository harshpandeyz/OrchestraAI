'use strict';

const { MemoryManager } = require('../interfaces');
const { EventType } = require('../core/types');
const { generateId, now } = require('../state/runtime-state');

class InMemoryMemoryManager extends MemoryManager {
  constructor(eventBus = null, options = {}) {
    super();
    this.eventBus = eventBus;
    this.workingMemory = new Map();
    this.longTermMemory = new Map();
    this.config = {
      maxWorkingItems: options.maxWorkingItems || 50,
      maxLongTermItems: options.maxLongTermItems || 500,
      importanceThreshold: options.importanceThreshold || 0.3,
      ...options
    };
  }

  // Run isolation: items are tagged with the writing run's ID. Reads return the
  // run's own items first, then shared seed knowledge (runId 'shared'/missing).
  // Runs never see each other's working memory.
  _visibleItems(store, runId) {
    const items = Array.from(store.values()).filter((item) => item.status === 'active');
    return items.filter((i) => !i.runId || i.runId === 'shared' || i.runId === runId)
      .sort((a, b) => {
        const aOwn = a.runId === runId ? 0 : 1;
        const bOwn = b.runId === runId ? 0 : 1;
        if (aOwn !== bOwn) return aOwn - bOwn;
        return (b.importance * b.confidence) - (a.importance * a.confidence);
      });
  }

  _rankByQuery(items, query) {
    if (!query) return items;
    const keywords = query.toLowerCase().split(/\s+/);
    return items.map((item) => {
      const text = `${item.title} ${item.snippet}`.toLowerCase();
      const matches = keywords.filter((k) => text.includes(k)).length;
      return { item, matches };
    }).sort((a, b) => b.matches - a.matches).map((x) => x.item);
  }

  async readWorkingMemory(runtimeState, query, limit = 10) {
    runtimeState.memory.recordRead();
    
    const items = this._rankByQuery(this._visibleItems(this.workingMemory, runtimeState.runId), query);
    
    const result = items.slice(0, limit);
    
    if (this.eventBus) {
      this.eventBus.emit(runtimeState.runId, EventType.MEMORY_READ, {
        scope: 'working',
        query,
        count: result.length
      });
    }
    
    return result;
  }

  async readLongTermMemory(runtimeState, query, limit = 10) {
    runtimeState.memory.recordRead();
    
    const items = this._rankByQuery(this._visibleItems(this.longTermMemory, runtimeState.runId), query);
    
    const result = items.slice(0, limit);
    
    if (this.eventBus) {
      this.eventBus.emit(runtimeState.runId, EventType.MEMORY_READ, {
        scope: 'longterm',
        query,
        count: result.length
      });
    }
    
    return result;
  }

  async writeWorkingMemory(runtimeState, item) {
    runtimeState.memory.recordWrite();
    
    const memoryItem = {
      id: item.id || generateId('mem'),
      scope: 'working',
      title: item.title,
      snippet: item.snippet,
      source: item.source,
      runId: runtimeState.runId,
      createdAt: item.createdAt || now(),
      lastUsedAt: now(),
      importance: item.importance || 0.5,
      confidence: item.confidence || 0.5,
      status: 'active',
      metadata: item.metadata || {}
    };
    
    this.workingMemory.set(memoryItem.id, memoryItem);
    
    if (this.workingMemory.size > this.config.maxWorkingItems) {
      await this._evictOldestWorking();
    }
    
    if (this.eventBus) {
      this.eventBus.emit(runtimeState.runId, EventType.MEMORY_WRITTEN, {
        scope: 'working',
        itemId: memoryItem.id,
        title: memoryItem.title
      });
    }
    
    return memoryItem;
  }

  async writeLongTermMemory(runtimeState, item) {
    runtimeState.memory.recordWrite();
    
    const memoryItem = {
      id: item.id || generateId('mem'),
      scope: 'longterm',
      title: item.title,
      snippet: item.snippet,
      source: item.source,
      runId: runtimeState.runId,
      createdAt: item.createdAt || now(),
      lastUsedAt: now(),
      importance: item.importance || 0.5,
      confidence: item.confidence || 0.5,
      status: 'active',
      metadata: item.metadata || {}
    };
    
    this.longTermMemory.set(memoryItem.id, memoryItem);
    
    if (this.longTermMemory.size > this.config.maxLongTermItems) {
      await this._evictOldestLongTerm();
    }
    
    if (this.eventBus) {
      this.eventBus.emit(runtimeState.runId, EventType.MEMORY_WRITTEN, {
        scope: 'longterm',
        itemId: memoryItem.id,
        title: memoryItem.title
      });
    }
    
    return memoryItem;
  }

  async evictMemory(runtimeState, itemId, scope) {
    const store = scope === 'working' ? this.workingMemory : this.longTermMemory;
    const item = store.get(itemId);
    
    if (item) {
      item.status = 'evicted';
      item.lastUsedAt = now();
      
      if (this.eventBus) {
        this.eventBus.emit(runtimeState.runId, EventType.MEMORY_EVICTED, {
          scope,
          itemId,
          title: item.title
        });
      }
      
      return true;
    }
    
    return false;
  }

  async searchMemory(runtimeState, query, scopes = ['working', 'longterm'], limit = 20) {
    const results = [];
    
    if (scopes.includes('working')) {
      const working = await this.readWorkingMemory(runtimeState, query, limit);
      results.push(...working.map(i => ({ ...i, scope: 'working' })));
    }
    
    if (scopes.includes('longterm')) {
      const longterm = await this.readLongTermMemory(runtimeState, query, limit);
      results.push(...longterm.map(i => ({ ...i, scope: 'longterm' })));
    }
    
    results.sort((a, b) => (b.importance * b.confidence) - (a.importance * a.confidence));
    
    return results.slice(0, limit);
  }

  getMemoryState(runtimeState) {
    return {
      working: this._visibleItems(this.workingMemory, runtimeState.runId),
      longterm: this._visibleItems(this.longTermMemory, runtimeState.runId)
    };
  }

  async _evictOldestWorking() {
    let oldest = null;
    for (const item of this.workingMemory.values()) {
      if (item.status === 'active' && (!oldest || item.lastUsedAt < oldest.lastUsedAt)) {
        oldest = item;
      }
    }
    if (oldest) {
      oldest.status = 'evicted';
    }
  }

  async _evictOldestLongTerm() {
    let oldest = null;
    for (const item of this.longTermMemory.values()) {
      if (item.status === 'active' && (!oldest || item.lastUsedAt < oldest.lastUsedAt)) {
        oldest = item;
      }
    }
    if (oldest) {
      oldest.status = 'archived';
    }
  }

  // Full dump for the /api/memory listing (redacted snippets only upstream).
  dumpAll() {
    return {
      working: Array.from(this.workingMemory.values()),
      longterm: Array.from(this.longTermMemory.values()),
    };
  }

  on(event, handler) {}

  seedMemory(working = [], longterm = []) {
    for (const item of working) {
      this.workingMemory.set(item.id, { ...item, scope: 'working', status: 'active', runId: item.runId || 'shared' });
    }
    for (const item of longterm) {
      this.longTermMemory.set(item.id, { ...item, scope: 'longterm', status: 'active', runId: item.runId || 'shared' });
    }
  }
}

module.exports = {
  InMemoryMemoryManager
};