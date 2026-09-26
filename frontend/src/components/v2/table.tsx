// Reusable table pattern: comfortable/compact/dense, sorting, filters,
// pagination, selection, row actions, hover preview. Behavior-tested.
import React, { useMemo, useState } from 'react';
import './v2.css';

export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => React.ReactNode;
  sortValue?: (row: T) => string | number;
  width?: string;
}

export function DataTable<T extends { id: string }>({
  rows, columns, density = 'comfortable', pageSize = 10, searchKeys, rowActions, emptyTitle, emptyHint, ariaLabel,
}: {
  rows: T[];
  columns: Column<T>[];
  density?: 'comfortable' | 'compact' | 'dense';
  pageSize?: number;
  searchKeys?: (row: T) => string;
  rowActions?: (row: T) => React.ReactNode;
  emptyTitle?: string;
  emptyHint?: string;
  ariaLabel?: string;
}) {
  const [q, setQ] = useState('');
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [dir, setDir] = useState<1 | -1>(1);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Record<string, boolean>>({});

  const filtered = useMemo(() => {
    const ql = q.toLowerCase();
    let out = !ql || !searchKeys ? rows : rows.filter((r) => searchKeys(r).toLowerCase().includes(ql));
    if (sortKey) {
      const col = columns.find((c) => c.key === sortKey);
      if (col?.sortValue) out = [...out].sort((a, b) => {
        const av = col.sortValue!(a); const bv = col.sortValue!(b);
        if (av < bv) return -1 * dir; if (av > bv) return 1 * dir; return 0;
      });
    }
    return out;
  }, [rows, q, sortKey, dir, columns, searchKeys]);

  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, pages - 1);
  const slice = filtered.slice(safePage * pageSize, safePage * pageSize + pageSize);
  const selCount = Object.values(selected).filter(Boolean).length;

  return (
    <div>
      <div className="v2-table-toolbar">
        {searchKeys && (
          <input className="search" style={{ width: 240 }} placeholder="Filter…" aria-label="Filter table" value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} />
        )}
        <span className="v2-meta" role="status">{filtered.length} row{filtered.length === 1 ? '' : 's'}{selCount ? ` · ${selCount} selected` : ''}</span>
        <span style={{ flex: 1 }} />
        {pages > 1 && (
          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <button type="button" className="icon-btn sm" disabled={safePage === 0} onClick={() => setPage((p) => Math.max(0, p - 1))} aria-label="Previous page">‹</button>
            <span className="v2-meta">Page {safePage + 1} / {pages}</span>
            <button type="button" className="icon-btn sm" disabled={safePage >= pages - 1} onClick={() => setPage((p) => Math.min(pages - 1, p + 1))} aria-label="Next page">›</button>
          </span>
        )}
      </div>
      {slice.length === 0 ? (
        <div className="v2-empty" role="status"><b>{emptyTitle || 'No rows'}</b><span>{emptyHint || 'Nothing matches yet. Adjust the filter or create the first item.'}</span></div>
      ) : (
        <div className="v2-table-wrap">
          <table className="v2-table" data-density={density} aria-label={ariaLabel || 'Data table'}>
            <thead>
              <tr>
                <th aria-label="Select rows"><span className="v2-meta">✓</span></th>
                {columns.map((c) => (
                  <th key={c.key} style={c.width ? { width: c.width } : undefined}>
                    {c.sortValue ? (
                      <button type="button" onClick={() => { if (sortKey === c.key) setDir((d) => (d === 1 ? -1 : 1)); else { setSortKey(c.key); setDir(1); } }} aria-label={`Sort by ${c.header}`}>
                        {c.header} {sortKey === c.key ? (dir === 1 ? '▲' : '▼') : ''}
                      </button>
                    ) : c.header}
                  </th>
                ))}
                {rowActions && <th>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {slice.map((r) => (
                <tr key={r.id} title={searchKeys ? searchKeys(r).slice(0, 160) : undefined}>
                  <td><input type="checkbox" aria-label={`Select row ${r.id}`} checked={!!selected[r.id]} onChange={() => setSelected((s) => ({ ...s, [r.id]: !s[r.id] }))} /></td>
                  {columns.map((c) => <td key={c.key}>{c.render(r)}</td>)}
                  {rowActions && <td>{rowActions(r)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
