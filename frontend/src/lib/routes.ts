// Real route semantics for major surfaces. Deep links + Back/Forward work.
// Legacy ?view= and bare /console continue to function (migration fallback).
import type { View } from '../state/store';

export const ROUTE_PREFIX = '/console';

const VIEW_TO_PATH: Record<string, string> = {
  overview: '/console',
  run: '/console/runs',
  models: '/console/models',
  agents: '/console/agents',
  tools: '/console/tools',
  skills: '/console/skills',
  workflows: '/console/workflows',
  workspaces: '/console/workspaces',
  intelligence: '/console/intelligence',
  evals: '/console/evaluations',
  memory: '/console/memory',
  approvals: '/console/approvals',
  alerts: '/console/alerts',
  deployments: '/console/deployments',
  incidents: '/console/incidents',
  savings: '/console/savings',
  projects: '/console/projects',
  billing: '/console/billing',
  settings: '/console/settings',
  cache: '/console/cache',
  conversations: '/console/conversations',
  traces: '/console/traces',
  api: '/console/api',
};

const PATH_TO_VIEW: Record<string, View> = {
  '': 'overview',
  '/': 'overview',
  '/runs': 'run',
  '/models': 'models',
  '/agents': 'agents',
  '/tools': 'tools',
  '/skills': 'skills',
  '/workflows': 'workflows',
  '/workspaces': 'workspaces',
  '/intelligence': 'intelligence',
  '/evaluations': 'evals',
  '/evals': 'evals',
  '/memory': 'memory',
  '/approvals': 'approvals',
  '/alerts': 'alerts',
  '/deployments': 'deployments',
  '/incidents': 'incidents',
  '/savings': 'savings',
  '/projects': 'projects',
  '/billing': 'billing',
  '/settings': 'settings',
  '/cache': 'cache',
  '/conversations': 'conversations',
  '/traces': 'traces',
  '/api': 'api',
};

export function parseRoute(pathname: string, search: string): { view: View; runId: string | null } {
  // /console/runs/:id → run view with active run
  const runMatch = pathname.match(/^\/console\/runs\/([^/]+)\/?$/);
  if (runMatch) return { view: 'run', runId: decodeURIComponent(runMatch[1]) };
  if (pathname === '/console' || pathname.startsWith('/console/')) {
    const rest = pathname.slice('/console'.length);
    // Bare /console defers to legacy ?view= when present (migration fallback).
    if (rest === '' || rest === '/') {
      try {
        const v = new URLSearchParams(search).get('view');
        if (v && (Object.values(PATH_TO_VIEW) as string[]).includes(v)) return { view: v as View, runId: null };
      } catch { /* ignore */ }
      return { view: 'overview', runId: null };
    }
    const base = rest.split('?')[0].replace(/\/$/, '') || '/';
    const key = rest.startsWith('/runs') && (base === '/runs' || base === '/runs/') ? '/runs' : base === '/' ? '/' : base;
    const mapped = PATH_TO_VIEW[key] || PATH_TO_VIEW[base];
    if (mapped) return { view: mapped, runId: null };
  }
  try {
    const v = new URLSearchParams(search).get('view');
    if (v && (Object.values(PATH_TO_VIEW) as string[]).includes(v)) return { view: v as View, runId: null };
  } catch { /* ignore */ }
  return { view: 'overview', runId: null };
}

export function buildRoute(view: View, runId?: string | null): string {
  if (view === 'run' && runId) return `/console/runs/${encodeURIComponent(runId)}`;
  return VIEW_TO_PATH[view] || '/console';
}

export function currentRoute(): { view: View; runId: string | null } {
  if (typeof window === 'undefined') return { view: 'overview', runId: null };
  return parseRoute(window.location.pathname, window.location.search);
}

export function navigateRoute(view: View, runId?: string | null) {
  if (typeof window === 'undefined') return;
  const url = buildRoute(view, runId);
  if (window.location.pathname + window.location.search !== url) {
    window.history.pushState({}, '', url);
  }
}
