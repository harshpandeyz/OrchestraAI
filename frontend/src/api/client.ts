// Centralized typed API layer. No raw fetch calls outside this module.
import type { MemoryItem, ModelInfo, Run, RuntimeSnapshot } from '../types';

const BASE = '';
async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) } });
  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json() as { error?: string; code?: string };
      if (body?.error) detail = `: ${body.error}`;
    } catch { /* ignore */ }
    throw new Error(`API ${res.status} ${path}${detail}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  health: () => req<{ ok: boolean }>(`/api/health`),
  getRuns: () => req<{ runs: Run[] }>(`/api/runs`),
  createRun: (title: string, taskMode: string) => req<{ run: Run }>(`/api/runs`, { method: 'POST', body: JSON.stringify({ title, taskMode }) }),
  getRun: (id: string) => req<{ run: Run }>(`/api/runs/${id}`),
  getState: (id: string) => req<{ state: RuntimeSnapshot }>(`/api/runs/${id}/state`),
  sendMessage: (id: string, content: string) => req<{ accepted: boolean }>(`/api/runs/${id}/messages`, { method: 'POST', body: JSON.stringify({ content }) }),
  cancelRun: (id: string) => req<{ run: Run }>(`/api/runs/${id}/cancel`, { method: 'POST' }),
  retryRun: (id: string) => req<{ accepted: boolean }>(`/api/runs/${id}/retry`, { method: 'POST' }),
  getModels: () => req<{ models: ModelInfo[] }>(`/api/models`),
  getTools: () => req<{ tools: RuntimeSnapshot['tools'] }>(`/api/tools`),
  getMemory: (scope?: string, q?: string) => req<{ items: MemoryItem[] }>(`/api/memory${scope || q ? `?${new URLSearchParams({ ...(scope ? { scope } : {}), ...(q ? { q } : {}) })}` : ''}`),
  getEvaluations: () => req<{ evaluations: any[]; note?: string }>(`/api/evaluations`),
  streamUrl: (id: string, since?: number) => `/api/runs/${id}/events${since ? `?since=${since}` : ''}`,
};
