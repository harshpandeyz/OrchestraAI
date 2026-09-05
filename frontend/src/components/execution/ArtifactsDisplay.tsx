import React from 'react';
import { useRuntime } from '../../state/store';
import { api } from '../../api/client';
import { Empty } from '../ui';
import type { ArtifactView, RuntimeSnapshot } from '../../types';

function artifactBadge({ type, name, size, mimeType }: { type: string; name: string; size: number; mimeType: string }) {
  const sizeKb = (size / 1024).toFixed(1);
  const typeShort = type.substring(0, 3).toUpperCase();
  return (
    <span className="o2-kv" title={`${name} · ${sizeKb} KB · ${mimeType}`}>
      <span className="o2-k">{typeShort}</span><span className="o2-v">{name}</span>
    </span>
  );
}

export function ArtifactsDisplay({ runId }: { runId: string }) {
  const { state } = useRuntime();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loaded, setLoaded] = React.useState<ArtifactView[] | null>(null);
  const snap = state.server.snapshot;

  const fetchArtifacts = async () => {
    if (!runId) return;
    setBusy('loading');
    try {
      const response = await api.getExecution(runId);
      setError(null);
      const artifacts = response.execution?.artifacts || [];
      setLoaded(artifacts);
      return artifacts;
    } catch (e: unknown) {
      setError((e instanceof Error ? e.message : String(e)).slice(0, 200));
      return [];
    } finally {
      setBusy(null);
    }
  };

  React.useEffect(() => {
    if (runId) void fetchArtifacts();
  }, [runId]);

  if (!runId) {
    return (
      <div className="oa-artifacts" role="region" aria-label="Run artifacts">
        <Empty what="Artifacts" hint="Select a run to view artifacts." />
      </div>
    );
  }

  const artifacts = loaded || snap?.execution?.artifacts || [];

  return (
    <div className="oa-artifacts" role="region" aria-label="Run artifacts">
      {busy && <span className="o2-muted">Loading artifacts…</span>}
      {error && <p className="o2-muted">Could not load artifacts.</p>}
      {!busy && !error && artifacts.length === 0 && (
        <Empty what="Artifacts" hint="No artifacts recorded for this run." />
      )}
      {artifacts.length > 0 && (
        <div className="oa-artifacts-list" role="list" aria-label={artifacts.length === 1 ? '1 artifact' : `${artifacts.length} artifacts`}>
          {artifacts.map((a) => (
            <div
              key={a.artifactId || a.id}
              className="oa-artifact-item"
              role="listitem"
              title={`${a.name || ' unnamed'}: ${a.type || 'log'}, ${a.size} bytes`}
            >
              <div className="oa-artifact-meta">
                <span className="o2-eyebrow">{a.type || 'log'}</span>
                <span className="o2-subtle">{a.name || 'unnamed'}</span>
                <span className="o2-subtle">· {a.size} bytes · {a.mimeType || 'text/plain'}</span>
              </div>
              <details className="oa-artifact-details" open>
                <summary className="o2-details-summary">Show content</summary>
                <pre className="oa-artifact-output o2-raw">{a.inline || '—'}</pre>
              </details>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
