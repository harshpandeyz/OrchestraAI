// Shared Intelligence data hook: one fetch, memoized derived data,
// no aggressive polling. Backend is authoritative.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Intelligence, IntelligenceFilters } from './types';

export const DEFAULT_FILTERS: IntelligenceFilters = {
  granularity: 'daily', range: '30d', model: null, provider: null, taskCategory: null, scale: 'linear',
};

function queryOf(f: IntelligenceFilters): string {
  const p = new URLSearchParams();
  p.set('granularity', f.granularity);
  p.set('range', f.range);
  if (f.model) p.set('model', f.model);
  if (f.provider) p.set('provider', f.provider);
  if (f.taskCategory) p.set('taskCategory', f.taskCategory);
  return `?${p.toString()}`;
}

async function fetchJson<T>(path: string): Promise<T> {
  // Same auth model as the shared API client: HttpOnly session cookie via
  // credentialed fetch. No bearer token is ever read from localStorage.
  const res = await fetch(path, { credentials: 'include' });
  if (!res.ok) {
    let detail = '';
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) detail = `: ${body.error}`;
    } catch { /* ignore */ }
    throw new Error(`API ${res.status} ${path}${detail}`);
  }
  return res.json() as Promise<T>;
}

export function useIntelligence(filters: IntelligenceFilters) {
  const [data, setData] = useState<Intelligence | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const query = useMemo(() => queryOf(filters), [filters.granularity, filters.range, filters.model, filters.provider, filters.taskCategory]);

  const reload = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchJson<{ intelligence: Intelligence }>(`/api/analytics/intelligence${query}`)
      .then((r) => { if (!cancelled) { setData(r.intelligence); setLoading(false); } })
      .catch((e) => { if (!cancelled) { setError(e instanceof Error ? e.message : 'Unable to load intelligence'); setLoading(false); } });
    return () => { cancelled = true; };
  }, [query]);

  useEffect(() => {
    const cancel = reload();
    return cancel;
  }, [reload]);

  return { data, error, loading, reload, query };
}
