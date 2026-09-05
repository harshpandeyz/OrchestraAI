// Centralized typed API layer. No raw fetch calls outside this module.
import type { AlertRecord, AnalyticsOverview, ApprovalRecord, BillingResponse, CacheOverview, ChangeSetView, CompareResponse, EpisodeView, EvaluationRecord, ExecutionView, HealthResponse, MemoryItem, ModelChange, ModelInfo, NewRunOptions, PrincipalInfo, ProjectCreateOptions, ProjectInfo, ProviderInfo, Run, RuntimeConfigResponse, RuntimePreset, RuntimeSettings, RuntimeSnapshot, SavingsRunRow, SessionRecord, UserInfo, VerificationRecord, WaterfallRow } from '../types';

const BASE = '';
const TOKEN_KEY = 'orchestra-api-token';
const REQUEST_ID_KEY = 'orchestra-request-id';
// Runtime API token for backends with authentication enabled. Stored only in
// this browser, sent as a Bearer header, never rendered or logged. The
// Local development may be open; production uses a session cookie or this
// optional operator token. Tokens are only sent as Authorization headers.

export function getApiToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}
export function setApiToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* private mode — session only */ }
}
export function generateRequestId(): string {
  return 'req-' + Math.random().toString(36).substring(2, 18);
}
// Cached request ID per browser session, so consecutive calls correlate.
export function getRequestId(): string | null {
  try { return localStorage.getItem(REQUEST_ID_KEY); } catch { return null; }
}
export function setRequestId(id: string | null): void {
  try {
    if (id) localStorage.setItem(REQUEST_ID_KEY, id);
    else localStorage.removeItem(REQUEST_ID_KEY);
  } catch { /* private mode — session only */ }
}

export class ApiError extends Error {
  readonly status: number;
  readonly path: string;
  readonly requestId: string;
  constructor(message: string, status: number, path: string, requestId: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.path = path;
    this.requestId = requestId;
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...((init?.headers || {}) as Record<string, string>) };
  try {
    const token = localStorage.getItem(TOKEN_KEY);
    if (token && !headers['Authorization']) headers['Authorization'] = `Bearer ${token}`;
    const rid = localStorage.getItem(REQUEST_ID_KEY) || generateRequestId();
    headers['X-Request-Id'] = rid;
    localStorage.setItem(REQUEST_ID_KEY, rid);
  } catch { /* private mode — unauthenticated */ }
  const res = await fetch(`${BASE}${path}`, { credentials: 'include', ...init, headers });
  if (!res.ok) {
    let detail = '';
    let parsedBody: unknown;
    try {
      parsedBody = await res.json();
      if ((parsedBody as { error?: string }).error) detail = `: ${(parsedBody as { error?: string }).error}`;
      else if ((parsedBody as { code?: string }).code) detail = ` (${(parsedBody as { code?: string }).code})`;
    } catch { /* ignore */ }
    // 401/403 surface explicitly (never silent): callers show the message,
    // and the Settings API-access row explains the token requirement.
    throw new ApiError(`API ${res.status} ${path}${detail}`, res.status, path, localStorage.getItem(REQUEST_ID_KEY) || generateRequestId());
  }
  return res.json() as Promise<T>;
}

export const api = {
  getApiToken,
  setApiToken,
  health: () => req<HealthResponse>(`/api/health`),
  config: () => req<RuntimeConfigResponse>(`/api/config`),
  getRuns: () => req<{ runs: Run[] }>(`/api/runs`),
  createRun: (title: string, taskMode: string, opts?: NewRunOptions) => req<{ run: Run; preset?: string }>(`/api/runs`, { method: 'POST', body: JSON.stringify({ title, taskMode, ...(opts || {}) }) }),
  getRun: (id: string) => req<{ run: Run }>(`/api/runs/${id}`),
  getState: (id: string) => req<{ state: RuntimeSnapshot }>(`/api/runs/${id}/state`),
  sendMessage: (id: string, content: string) => req<{ accepted: boolean }>(`/api/runs/${id}/messages`, { method: 'POST', body: JSON.stringify({ content }) }),
  cancelRun: (id: string) => req<{ run: Run }>(`/api/runs/${id}/cancel`, { method: 'POST' }),
  retryRun: (id: string) => req<{ accepted: boolean }>(`/api/runs/${id}/retry`, { method: 'POST' }),
  forkRun: (id: string) => req<{ accepted: boolean; newRunId?: string }>(`/api/runs/${id}/fork`, { method: 'POST' }),
  duplicateRun: (id: string) => req<{ accepted: boolean; newRunId?: string }>(`/api/runs/${id}/duplicate`, { method: 'POST' }),
  compareRuns: (a: string, b: string) => req<CompareResponse>(`/api/runs/${a}/compare/${b}`),
  getModels: () => req<{ models: ModelInfo[]; meta?: { updatedAt: string | null; discoveryEnabled: boolean; mode: string } }>(`/api/models`),
  refreshModels: (provider?: string) => req<{ ok: boolean; discovered?: number; updated?: number; prices?: number; at?: string; skipped?: string; error?: string; changes?: ModelChange[] }>(`/api/models/refresh`, { method: 'POST', body: JSON.stringify(provider ? { provider } : {}) }),
  getModelChanges: (limit = 30) => req<{ changes: ModelChange[] }>(`/api/models/changes?limit=${limit}`),
  getTools: () => req<{ tools: RuntimeSnapshot['tools'] }>(`/api/tools`),
  getMemory: (scope?: string, q?: string) => req<{ items: MemoryItem[] }>(`/api/memory${scope || q ? `?${new URLSearchParams({ ...(scope ? { scope } : {}), ...(q ? { q } : {}) })}` : ''}`),
  getEvaluations: () => req<{ evaluations: EvaluationRecord[]; note?: string }>(`/api/evaluations`),
  // Providers (backend-mediated; keys are write-only and never readable).
  getProviders: () => req<{ mode: string; providers: ProviderInfo[] }>(`/api/providers`),
  getProvider: (id: string) => req<{ provider: ProviderInfo; mode: string }>(`/api/providers/${id}/status`),
  connectProvider: (id: string, apiKey: string) => req<{ ok: boolean; latencyMs?: number; modelCount?: number | null; provider: ProviderInfo; mode: string }>(`/api/providers/${id}/connect`, { method: 'POST', body: JSON.stringify({ apiKey }) }),
  testProvider: (id: string, apiKey?: string) => req<{ ok: boolean; latencyMs?: number; modelCount?: number | null; provider: ProviderInfo; mode?: string }>(`/api/providers/${id}/test`, { method: 'POST', body: JSON.stringify(apiKey ? { apiKey } : {}) }),
  disconnectProvider: (id: string) => req<{ ok: boolean; removedStored: boolean; provider: ProviderInfo; mode: string }>(`/api/providers/${id}`, { method: 'DELETE' }),
  // Runtime presets + defaults.
  getPresets: () => req<{ presets: RuntimePreset[] }>(`/api/runtime/presets`),
  getRuntimeSettings: () => req<{ settings: RuntimeSettings; presets: RuntimePreset[] }>(`/api/runtime/settings`),
  saveRuntimeSettings: (patch: Partial<RuntimeSettings>) => req<{ settings: RuntimeSettings }>(`/api/runtime/settings`, { method: 'PUT', body: JSON.stringify(patch) }),
  // Session 3 execution (approvals / plan / changesets / episodes / verify).
  // These endpoints exist on the backend; the client only forwards user
  // decisions — nothing is auto-approved client-side.
  getExecution: (id: string) => req<{ execution: ExecutionView }>(`/api/runs/${id}/execution`),
  listApprovals: (id: string) => req<{ approvals: ApprovalRecord[] }>(`/api/runs/${id}/approvals`),
  decideApproval: (id: string, approvalId: string, decision: 'approve' | 'deny' | 'cancel') => req<{ ok: boolean; approval?: ApprovalRecord; error?: string }>(`/api/runs/${id}/approvals/${approvalId}/${decision}`, { method: 'POST' }),
  continueRun: (id: string, content: string) => req<{ ok: boolean; episode?: EpisodeView; error?: string }>(`/api/runs/${id}/continue`, { method: 'POST', body: JSON.stringify({ content }) }),
  getPlan: (id: string) => req<{ plan: ExecutionView['plan'] }>(`/api/runs/${id}/plan`),
  getChangesets: (id: string) => req<{ changesets: ChangeSetView[] }>(`/api/runs/${id}/changesets`),
  verifyRun: (id: string) => req<{ ok: boolean; records?: VerificationRecord[] }>(`/api/runs/${id}/verify`, { method: 'POST', body: JSON.stringify({}) }),
  streamUrl: (id: string, since?: number) => `/api/runs/${id}/events${since ? `?since=${since}` : ''}`,
  getSavings: (query = '') => req<{ summary: AnalyticsOverview['summary']; runs: SavingsRunRow[]; waterfall: WaterfallRow[]; note: string }>(`/api/savings${query}`),
  getOverview: (query = '') => req<{ analytics: AnalyticsOverview }>(`/api/analytics/overview${query}`),
  getBilling: (query = '') => req<BillingResponse>(`/api/billing${query}`),
  getIntelligence: (query = '') => req<{ intelligence: import('../analytics/types').Intelligence }>(`/api/analytics/intelligence${query}`),
  getIntelligenceSection: (section: string, query = '') => req<{ meta: import('../analytics/types').IntelligenceMeta; section: string; data: unknown }>(`/api/analytics/${section}${query}`),
  getSessions: () => req<{ sessions: SessionRecord[] }>(`/api/sessions`),
  getCache: () => req<{ cache: CacheOverview; note: string }>(`/api/cache`),
  getAlerts: () => req<{ alerts: AlertRecord[]; note: string }>(`/api/alerts`),
  signup: (email: string, password: string, name?: string) => req<{ user: UserInfo; project: ProjectInfo }>(`/api/auth/signup`, { method: 'POST', body: JSON.stringify({ email, password, name }) }),
  login: (email: string, password: string) => req<{ user: UserInfo }>(`/api/auth/login`, { method: 'POST', body: JSON.stringify({ email, password }) }),
  logout: () => req<{ ok: boolean }>(`/api/auth/logout`, { method: 'POST' }),
  me: () => req<{ authenticated: boolean; principal: PrincipalInfo | null }>(`/api/auth/me`),
  getProjects: () => req<{ projects: ProjectInfo[] }>(`/api/projects`),
  createProject: (name: string, options: ProjectCreateOptions = {}) => req<{ project: ProjectInfo }>(`/api/projects`, { method: 'POST', body: JSON.stringify({ name, ...options }) }),
};
