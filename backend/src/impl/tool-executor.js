'use strict';

// Real tool execution (Session 5).
//
// One execution path — no mock results, no random failures. Every call goes
// through: registry lookup -> status check -> parameter validation -> timeout
// race -> real handler -> latency/cost measurement -> run-state recording.
//
// Safety:
//   - `read_file` / `search_code` are sandboxed to WORKSPACE_ROOT (or cwd).
//   - `run_tests` executes ONE allowlisted command (default: the backend unit
//     test file) via execFile with timeout + output caps. No shell, no args
//     from the model beyond `suite` selection.
//   - `apply_patch` requires ALLOW_FILE_WRITES=true and applies atomically.
//   - Arbitrary shell execution is NOT exposed as a tool.
//
// Reliability:
//   - idempotencyKey (default: derived from run/step/tool/params hash) — a
//     completed key returns the stored result instead of re-executing, so a
//     retry never duplicates an irreversible operation.
//   - AbortSignal support — cancellation returns code 'cancelled' and kills
//     child processes.
//   - Outcomes: success | failure | timeout | cancelled | disabled.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { ToolExecutor } = require('../interfaces');
const { EventType } = require('../core/types');
const { generateId, now } = require('../state/runtime-state');

function hashParams(params) {
  return crypto.createHash('sha256').update(JSON.stringify(params || {})).digest('hex').slice(0, 12);
}

function resolveWorkspace() {
  const root = process.env.WORKSPACE_ROOT || process.cwd();
  return path.resolve(root);
}

function sandboxPath(workspace, requested) {
  const rel = String(requested || '').replace(/^\/+/, '');
  const abs = path.resolve(workspace, rel);
  if (abs !== workspace && !abs.startsWith(workspace + path.sep)) {
    throw new Error(`Path escapes workspace: ${requested}`);
  }
  return abs;
}

const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.runtime-data', 'coverage']);

async function handleReadFile(params, ctx) {
  const abs = sandboxPath(ctx.workspace, params.path);
  const stat = await fs.promises.stat(abs).catch(() => null);
  if (!stat || !stat.isFile()) throw Object.assign(new Error(`File not found: ${params.path}`), { code: 'not_found' });
  const maxBytes = Math.min(Number(params.maxBytes) || 20000, 100000);
  const content = await fs.promises.readFile(abs, 'utf8').catch(() => null);
  if (content === null) throw Object.assign(new Error(`Cannot read file as text: ${params.path}`), { code: 'unreadable' });
  const lines = content.split('\n');
  const start = Math.max(1, Number(params.startLine) || 1);
  const end = Math.min(lines.length, Number(params.endLine) || lines.length);
  const slice = lines.slice(start - 1, end).join('\n').slice(0, maxBytes);
  return { path: params.path, startLine: start, endLine: end, totalLines: lines.length, content: slice, truncated: slice.length < content.length };
}

async function handleSearchCode(params, ctx) {
  const query = String(params.query || '').slice(0, 200);
  if (!query) throw Object.assign(new Error('query is required'), { code: 'bad_params' });
  const maxResults = Math.min(Number(params.maxResults) || 20, 50);
  let includeRe = /\.(js|ts|tsx|jsx|json|md|py|go|rs)$/;
  if (params.include) {
    try {
      includeRe = new RegExp(String(params.include).slice(0, 120));
    } catch {
      includeRe = /\.(js|ts|tsx|jsx|json|md|py|go|rs)$/;
    }
  }
  const results = [];
  const ql = query.toLowerCase();

  async function walk(dir, depth) {
    if (results.length >= maxResults || depth > 8) return;
    if (ctx.signal && ctx.signal.aborted) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      if (results.length >= maxResults) break;
      if (e.name.startsWith('.') && e.name !== '.env.example' || IGNORED_DIRS.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { await walk(abs, depth + 1); }
      else if (e.isFile() && includeRe.test(e.name)) {
        let content;
        try {
          const stat = await fs.promises.stat(abs);
          if (stat.size > 500000) continue;
          content = await fs.promises.readFile(abs, 'utf8');
        } catch { continue; }
        const lines = content.split('\n');
        for (let i = 0; i < lines.length && results.length < maxResults; i++) {
          if (lines[i].toLowerCase().includes(ql)) {
            results.push({ file: path.relative(ctx.workspace, abs), line: i + 1, text: lines[i].slice(0, 240) });
          }
        }
      }
    }
  }

  await walk(ctx.workspace, 0);
  return { query, matches: results.length, results };
}

function runTestsCommand() {
  // Strict allowlist: `node <path-inside-workspace> [args...]`.
  const raw = (process.env.TOOL_RUN_TESTS_CMD || 'node backend/test/runtime.test.js').trim();
  const parts = raw.split(/\s+/);
  if (parts[0] !== 'node') throw Object.assign(new Error('run_tests command must start with `node`'), { code: 'disabled' });
  const workspace = resolveWorkspace();
  const target = sandboxPath(workspace, parts[1] || '');
  return { cmd: 'node', args: [target, ...parts.slice(2)] };
}

function handleRunTests(params, ctx) {
  return new Promise((resolve, reject) => {
    let spec;
    try { spec = runTestsCommand(); }
    catch (e) { return reject(e); }
    const child = execFile(spec.cmd, spec.args, {
      cwd: ctx.workspace, timeout: ctx.timeLeftMs, maxBuffer: 512 * 1024, windowsHide: true,
    }, (error, stdout, stderr) => {
      const out = String(stdout || '').slice(-4000);
      const err = String(stderr || '').slice(-2000);
      if (error) {
        const timeout = error.killed && error.signal === 'SIGTERM';
        const e = new Error(timeout ? `Test command timed out` : `Tests failed (exit ${error.code ?? '?'}): ${(out + err).slice(-500)}`);
        e.code = timeout ? 'timeout' : 'test_failure';
        e.details = { stdout: out, stderr: err, code: error.code };
        return reject(e);
      }
      resolve({ suite: params.suite || 'default', passed: true, stdout: out, stderr: err });
    });
    if (ctx.signal) {
      if (ctx.signal.aborted) { try { child.kill('SIGKILL'); } catch {} }
      else ctx.signal.addEventListener('abort', () => { try { child.kill('SIGKILL'); } catch {} }, { once: true });
    }
  });
}

async function handleApplyPatch(params, ctx) {
  if (!/^(1|true|yes)$/i.test(process.env.ALLOW_FILE_WRITES || '')) {
    throw Object.assign(new Error('apply_patch is disabled (set ALLOW_FILE_WRITES=true to enable)'), { code: 'disabled' });
  }
  const abs = sandboxPath(ctx.workspace, params.path);
  const edits = Array.isArray(params.edits) ? params.edits : null;
  if (!edits || !edits.length) throw Object.assign(new Error('edits[] is required'), { code: 'bad_params' });
  let content = await fs.promises.readFile(abs, 'utf8').catch(() => null);
  if (content === null) throw Object.assign(new Error(`File not found: ${params.path}`), { code: 'not_found' });
  for (const ed of edits.slice(0, 20)) {
    if (typeof ed.oldText !== 'string' || typeof ed.newText !== 'string' || !ed.oldText) {
      throw Object.assign(new Error('Each edit needs oldText/newText strings'), { code: 'bad_params' });
    }
    if (!content.includes(ed.oldText)) {
      throw Object.assign(new Error(`Patch context not found in ${params.path}; no changes applied`), { code: 'patch_conflict' });
    }
    content = content.replace(ed.oldText, ed.newText);
  }
  await fs.promises.writeFile(abs, content, 'utf8');
  return { path: params.path, editsApplied: edits.length };
}

const HANDLERS = {
  read_file: handleReadFile,
  search_code: handleSearchCode,
  run_tests: handleRunTests,
  apply_patch: handleApplyPatch,
};

class InMemoryToolExecutor extends ToolExecutor {
  constructor(toolRegistry, eventBus = null, options = {}) {
    super();
    this.toolRegistry = toolRegistry;
    this.eventBus = eventBus;
    this.executionHistory = [];
    // idempotencyKey -> completed result (per process; keyed by run in keygen)
    this.completedKeys = new Map();
    this.workspace = options.workspace || resolveWorkspace();
    this.config = {
      timeoutMs: options.timeoutMs || 30000,
      maxParallel: options.maxParallel || 3,
      ...options
    };
  }

  idempotencyKeyFor(runId, toolName, params, step) {
    return `${runId}:${toolName}:${step}:${hashParams(params)}`;
  }

  async execute(toolName, params, runtimeState, options = {}) {
    const runId = runtimeState.runId;
    const tool = await this.toolRegistry.getTool(toolName);

    if (!tool) {
      return this._createResult(toolName, false, null, `Tool ${toolName} not found`, 0, { code: 'not_found' });
    }
    if (tool.status !== 'enabled') {
      return this._createResult(toolName, false, null, `Tool ${toolName} is disabled`, 0, { code: 'disabled' });
    }

    const validation = await this.validateParams(toolName, params || {});
    if (!validation.valid) {
      return this._createResult(toolName, false, null, validation.error, 0, { code: 'bad_params' });
    }

    const idempotencyKey = options.idempotencyKey || this.idempotencyKeyFor(runId, toolName, params, runtimeState.execution.currentStep);
    if (this.completedKeys.has(idempotencyKey)) {
      const cached = this.completedKeys.get(idempotencyKey);
      if (this.eventBus) {
        this.eventBus.emit(runId, EventType.TOOL_COMPLETED, {
          executionId: cached.executionId, tool: toolName, status: 'success',
          durationMs: 0, cost: 0, deduped: true, idempotencyKey,
        });
      }
      return { ...cached, deduped: true };
    }

    if (options.signal && options.signal.aborted) {
      return this._createResult(toolName, false, null, 'Tool execution cancelled', 0, { code: 'cancelled' });
    }

    const handler = HANDLERS[toolName];
    if (!handler) {
      return this._createResult(toolName, false, null, `No handler registered for tool ${toolName}`, 0, { code: 'not_found' });
    }

    const executionId = generateId('exec');
    const startTime = Date.now();
    const timeoutMs = Math.min(options.timeoutMs || tool.timeoutMs || this.config.timeoutMs, this.config.timeoutMs * 4);

    if (this.eventBus) {
      this.eventBus.emit(runId, EventType.TOOL_STARTED, {
        executionId, tool: toolName, params: this._sanitizeParams(params), idempotencyKey,
      });
    }

    const ctx = {
      workspace: this.workspace,
      signal: options.signal || null,
      timeLeftMs: timeoutMs,
      runId,
    };

    let timeoutTimer = null;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutTimer = setTimeout(() => {
        const e = new Error(`Tool ${toolName} timed out after ${timeoutMs}ms`);
        e.code = 'timeout';
        reject(e);
      }, timeoutMs);
      if (timeoutTimer.unref) timeoutTimer.unref();
    });
    const abortPromise = options.signal ? new Promise((_, reject) => {
      if (options.signal.aborted) {
        const e = new Error('Tool execution cancelled');
        e.code = 'cancelled';
        reject(e);
      } else {
        options.signal.addEventListener('abort', () => {
          const e = new Error('Tool execution cancelled');
          e.code = 'cancelled';
          reject(e);
        }, { once: true });
      }
    }) : null;

    try {
      const result = await Promise.race([
        handler(params || {}, ctx),
        timeoutPromise,
        ...(abortPromise ? [abortPromise] : []),
      ]);
      clearTimeout(timeoutTimer);
      const latencyMs = Date.now() - startTime;
      const cost = tool.costPerCall || 0.001;
      const executionResult = this._createResult(toolName, true, result, null, latencyMs, cost, { executionId, idempotencyKey });

      this.completedKeys.set(idempotencyKey, executionResult);
      if (this.completedKeys.size > 500) {
        const first = this.completedKeys.keys().next().value;
        this.completedKeys.delete(first);
      }

      if (this.eventBus) {
        this.eventBus.emit(runId, EventType.TOOL_COMPLETED, {
          executionId, tool: toolName, status: 'success', durationMs: latencyMs, cost,
          result: this._sanitizeResult(result), idempotencyKey,
        });
      }

      this.executionHistory.push({ ...executionResult, executionId, timestamp: now() });
      if (this.executionHistory.length > 100) this.executionHistory.shift();

      runtimeState.tools.recordCall(toolName, { success: true, latencyMs, cost, result });
      runtimeState.budget.addCost('tool_execution', cost, { tool: toolName });

      return executionResult;
    } catch (error) {
      clearTimeout(timeoutTimer);
      const latencyMs = Date.now() - startTime;
      const code = (error && error.code) || (String(error && error.message || '').includes('timed out') ? 'timeout' : 'failure');
      const executionResult = this._createResult(toolName, false, null, String((error && error.message) || error), latencyMs, 0, { executionId, idempotencyKey, code });

      if (this.eventBus) {
        this.eventBus.emit(runId, EventType.TOOL_FAILED, {
          executionId, tool: toolName, status: code === 'cancelled' ? 'cancelled' : 'failed',
          durationMs: latencyMs, error: String((error && error.message) || error), code, idempotencyKey,
        });
      }

      this.executionHistory.push({ ...executionResult, executionId, timestamp: now() });
      if (this.executionHistory.length > 100) this.executionHistory.shift();

      runtimeState.tools.recordCall(toolName, { success: false, latencyMs, error: String((error && error.message) || error) });

      return executionResult;
    }
  }

  async executeParallel(toolCalls, runtimeState, options = {}) {
    const maxParallel = options.maxParallel || this.config.maxParallel;
    const results = [];
    const executing = [];

    for (const call of toolCalls) {
      const promise = this.execute(call.toolName, call.params, runtimeState, options);
      executing.push(promise);

      if (executing.length >= maxParallel) {
        const completed = await Promise.all(executing);
        results.push(...completed);
        executing.length = 0;
      }
    }

    if (executing.length > 0) {
      const completed = await Promise.all(executing);
      results.push(...completed);
    }

    return results;
  }

  async validateParams(toolName, params) {
    const tool = await this.toolRegistry.getTool(toolName);
    if (!tool) return { valid: false, error: `Tool ${toolName} not found` };

    if (tool.parameters && tool.parameters.required) {
      for (const required of tool.parameters.required) {
        if (params[required] === undefined) {
          return { valid: false, error: `Missing required parameter: ${required}` };
        }
      }
    }
    if (tool.parameters && tool.parameters.properties) {
      for (const [key, schema] of Object.entries(tool.parameters.properties)) {
        const v = params[key];
        if (v === undefined) continue;
        if (schema.type === 'string' && typeof v !== 'string') return { valid: false, error: `Parameter ${key} must be a string` };
        if (schema.type === 'number' && typeof v !== 'number') return { valid: false, error: `Parameter ${key} must be a number` };
        if (schema.type === 'array' && !Array.isArray(v)) return { valid: false, error: `Parameter ${key} must be an array` };
      }
    }

    return { valid: true };
  }

  _createResult(toolName, success, result, error, latencyMs, cost = 0, extra = {}) {
    return {
      toolName,
      success,
      result,
      error,
      latencyMs,
      cost,
      timestamp: now(),
      code: extra.code || (success ? 'success' : 'failure'),
      executionId: extra.executionId || null,
      idempotencyKey: extra.idempotencyKey || null,
    };
  }

  _sanitizeParams(params) {
    const sanitized = {};
    for (const [key, value] of Object.entries(params || {})) {
      if (typeof value === 'string' && value.length > 100) {
        sanitized[key] = value.slice(0, 100) + '...';
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }

  _sanitizeResult(result) {
    if (!result) return null;
    if (typeof result === 'string' && result.length > 200) {
      return result.slice(0, 200) + '...';
    }
    if (typeof result === 'object') {
      return JSON.stringify(result).slice(0, 500);
    }
    return result;
  }

  getToolState(runtimeState) {
    return runtimeState.tools.toJSON();
  }

  getExecutionHistory(limit = 20) {
    return this.executionHistory.slice(-limit);
  }

  on(event, handler) {}
}

module.exports = {
  InMemoryToolExecutor,
  HANDLERS,
};
