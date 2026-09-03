'use strict';

/**
 * Engines — singleton instances of context, memory, and cache engines.
 * Populated with seed data from data.js and ready for dynamic use by simulate.js.
 */

const { ContextManager, ContextItem, ContextItemType, ContextItemStatus } = require('./context_engine');
const { MemoryManager, MemoryScope } = require('./memory_engine');
const { CacheManager } = require('./cache_engine');
const { MODELS, TOOLS, MEMORY } = require('./data');

// ── singletons ─────────────────────────────────────────────────────────────────

const contextManager = new ContextManager();
const memoryManager  = new MemoryManager();
const cacheManager   = new CacheManager();

// ── seed context ───────────────────────────────────────────────────────────────

const defaultModel = MODELS.find(m => m.id === 'nemotron-x') || MODELS[0];
contextManager.init(defaultModel.contextWindow);

const seedContextItems = [
  { id: 'c1', type: ContextItemType.CODE_FILE, source: 'read_file', content: 'auth/service.ts', tokenCount: 8210, relevanceScore: 0.94, importanceScore: 0.90, recencyScore: 0.80, dependencyScore: 0.90, freshness: 0.90, taskId: 'run-1', status: ContextItemStatus.KEEP },
  { id: 'c2', type: ContextItemType.CODE_FILE, source: 'search_code', content: 'login controller', tokenCount: 5340, relevanceScore: 0.88, importanceScore: 0.85, recencyScore: 0.70, dependencyScore: 0.80, freshness: 0.85, taskId: 'run-1', status: ContextItemStatus.KEEP },
  { id: 'c3', type: ContextItemType.TOOL_RESULT, source: 'run_tests', content: 'recent test failure', tokenCount: 3120, relevanceScore: 0.91, importanceScore: 0.80, recencyScore: 0.90, dependencyScore: 0.70, freshness: 0.95, taskId: 'run-1', status: ContextItemStatus.KEEP },
  { id: 'c4', type: ContextItemType.USER_MESSAGE, source: 'conversation', content: 'previous debugging conversation', tokenCount: 12400, relevanceScore: 0.42, importanceScore: 0.50, recencyScore: 0.60, dependencyScore: 0.30, freshness: 0.70, taskId: 'run-1', status: ContextItemStatus.COMPRESSED },
  { id: 'c5', type: ContextItemType.LOG, source: 'ops', content: 'unrelated deployment logs', tokenCount: 9100, relevanceScore: 0.11, importanceScore: 0.20, recencyScore: 0.30, dependencyScore: 0.10, freshness: 0.40, taskId: 'run-1', status: ContextItemStatus.ARCHIVED },
];

for (const data of seedContextItems) contextManager.addItem(data);

// ── seed memory ────────────────────────────────────────────────────────────────

for (const item of MEMORY.working)  memoryManager.addToWorking(item);
for (const item of MEMORY.longterm) memoryManager.addToLongTerm(item);

// ── seed cache ─────────────────────────────────────────────────────────────────

cacheManager.storePrompt('system prompt', 'Fix authentication bug', 'nemotron-x', 'I will fix the bug.', 1000);
cacheManager.storeSemantic('auth bug', '', { result: 'auth bug info' }, 500, 0.013);

module.exports = { contextManager, memoryManager, cacheManager };
