'use strict';
// Seed catalog + memory. Mirrors MODEL_INTELLIGENCE.md / CONTEXT_MEMORY_CACHE.md shapes.
const MODELS = [
  { id: 'nemotron-x', name: 'Nemotron X', provider: 'Provider Y', status: 'healthy', contextWindow: 128000, quality: 0.91, avgLatencyMs: 1800, reliability: 0.987, inputPer1k: 0.0009, outputPer1k: 0.0027, cachedPer1k: 0.0002, capabilities: ['coding', 'reasoning', 'tools'] },
  { id: 'helium-b', name: 'Helium B', provider: 'Provider Y', status: 'healthy', contextWindow: 64000, quality: 0.87, avgLatencyMs: 1600, reliability: 0.973, inputPer1k: 0.0007, outputPer1k: 0.0021, cachedPer1k: 0.0002, capabilities: ['coding', 'tools'] },
  { id: 'ferrite-c', name: 'Ferrite C', provider: 'Provider Z', status: 'degraded', contextWindow: 32000, quality: 0.76, avgLatencyMs: 1200, reliability: 0.941, inputPer1k: 0.0003, outputPer1k: 0.0009, cachedPer1k: 0.0001, capabilities: ['chat'] },
];

const TOOLS = [
  { name: 'search_code', description: 'Sandboxed code search over the workspace', status: 'enabled', calls: 0, avgLatencyMs: 300, successRate: 1.0, costPerCall: 0.0005, timeoutMs: 15000, permissions: ['workspace:read'], capabilities: ['search'], parameters: { type: 'object', properties: { query: { type: 'string' }, include: { type: 'string' }, maxResults: { type: 'number' } }, required: ['query'] } },
  { name: 'read_file', description: 'Read a workspace file with line ranges', status: 'enabled', calls: 0, avgLatencyMs: 60, successRate: 1.0, costPerCall: 0.0002, timeoutMs: 10000, permissions: ['workspace:read'], capabilities: ['read'], parameters: { type: 'object', properties: { path: { type: 'string' }, startLine: { type: 'number' }, endLine: { type: 'number' }, maxBytes: { type: 'number' } }, required: ['path'] } },
  { name: 'run_tests', description: 'Execute the allowlisted test command (no shell)', status: 'enabled', calls: 0, avgLatencyMs: 5000, successRate: 1.0, costPerCall: 0.002, timeoutMs: 60000, permissions: ['tests:execute'], capabilities: ['test'], parameters: { type: 'object', properties: { suite: { type: 'string' } }, required: [] } },
  { name: 'apply_patch', description: 'Apply exact-match edits to a workspace file (requires ALLOW_FILE_WRITES=true)', status: 'enabled', calls: 0, avgLatencyMs: 200, successRate: 1.0, costPerCall: 0.001, timeoutMs: 10000, permissions: ['workspace:write'], capabilities: ['edit'], parameters: { type: 'object', properties: { path: { type: 'string' }, edits: { type: 'array' } }, required: ['path', 'edits'] } },
  { name: 'deploy_preview', description: 'Build preview deployment', status: 'disabled', calls: 0, avgLatencyMs: 9000, successRate: 1.0, costPerCall: 0.01, timeoutMs: 30000, permissions: ['deploy'], capabilities: ['deploy'], parameters: { type: 'object', properties: {}, required: [] } },
];

const MEMORY = {
  working: [
    { id: 'w1', scope: 'working', title: 'Auth bug repro', snippet: 'login returns 401 when refresh token rotates', source: 'conversation', createdAt: new Date(Date.now() - 1000 * 60 * 12).toISOString(), lastUsedAt: new Date().toISOString(), importance: 0.9, confidence: 0.85, status: 'active' },
    { id: 'w2', scope: 'working', title: 'Failing test: session.spec', snippet: '2 failing assertions in session refresh flow', source: 'tool:run_tests', createdAt: new Date(Date.now() - 1000 * 60 * 9).toISOString(), lastUsedAt: new Date().toISOString(), importance: 0.8, confidence: 0.9, status: 'active' },
  ],
  longterm: [
    { id: 'l1', scope: 'longterm', title: 'Auth service ownership', snippet: 'auth/service.ts owned by identity team; rotates refresh tokens', source: 'repo-index', createdAt: new Date(Date.now() - 1000 * 60 * 60 * 26).toISOString(), lastUsedAt: new Date(Date.now() - 1000 * 60 * 40).toISOString(), importance: 0.7, confidence: 0.75, status: 'active' },
    { id: 'l2', scope: 'longterm', title: 'Deployment log noise', snippet: 'unrelated deploy logs archived last week', source: 'ops', createdAt: new Date(Date.now() - 1000 * 60 * 60 * 50).toISOString(), lastUsedAt: new Date(Date.now() - 1000 * 60 * 60 * 30).toISOString(), importance: 0.25, confidence: 0.6, status: 'archived' },
  ],
};

module.exports = { MODELS, TOOLS, MEMORY };
