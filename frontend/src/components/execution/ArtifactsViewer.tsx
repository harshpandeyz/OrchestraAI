// Consistent artifact viewer: code / diff / markdown / JSON / CSV /
// images / PDF / logs / video share one chrome. Unsupported previews render
// an honest note with hash + size — never a fake rendering.
import React from 'react';
import type { ArtifactView } from '../../types';

function isImage(a: ArtifactView): boolean {
  return /image\//.test(a.mimeType || '') || /\.(png|jpe?g|gif|webp|svg)$/i.test(a.name || '');
}

function renderBody(a: ArtifactView): React.ReactNode {
  const text = a.inline || '';
  const type = String(a.type || '').toLowerCase();
  const mime = String(a.mimeType || '').toLowerCase();
  if (isImage(a) && text.startsWith('data:image')) {
    return <img src={text} alt={a.name || 'artifact image'} style={{ maxWidth: '100%', borderRadius: 8 }} />;
  }
  if (/pdf/.test(mime) || /video\//.test(mime)) {
    return <p className="v2-meta">Preview not available in-console for {mime || type}. Verify by hash below — nothing is faked.</p>;
  }
  if (/json/.test(mime) || type === 'json') {
    try {
      const pretty = JSON.stringify(JSON.parse(text), null, 2);
      return <pre className="o2-raw">{pretty.slice(0, 8000)}</pre>;
    } catch { return <pre className="o2-raw">{text.slice(0, 8000)}</pre>; }
  }
  if (/csv/.test(mime) || type === 'csv') {
    const rows = text.split('\n').slice(0, 12).map((r) => r.split(','));
    if (rows.length < 2) return <pre className="o2-raw">{text.slice(0, 4000)}</pre>;
    return (
      <div className="v2-table-wrap"><table className="v2-table" data-density="compact">
        <thead><tr>{rows[0].map((c, i) => <th key={i}>{c}</th>)}</tr></thead>
        <tbody>{rows.slice(1).map((r, i) => <tr key={i}>{rows[0].map((_, k) => <td key={k}>{r[k] || ''}</td>)}</tr>)}</tbody>
      </table></div>
    );
  }
  return <pre className="o2-raw">{text ? text.slice(0, 8000) : 'Empty artifact body.'}</pre>;
}

export function ArtifactViewer({ artifact }: { artifact: ArtifactView }) {
  const [open, setOpen] = React.useState(false);
  const name = String(artifact.name || artifact.artifactId || artifact.id || 'artifact');
  return (
    <div className="v2-decision" style={{ marginTop: 8 }}>
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer', textAlign: 'left', width: '100%', color: 'inherit' }}>
        <b>{name}</b> <span className="v2-meta">· {artifact.type} · {artifact.size} bytes{artifact.hash ? ` · ${String(artifact.hash).slice(0, 12)}…` : ''}</span>
      </button>
      {open && (
        <div style={{ marginTop: 8 }}>
          {renderBody(artifact)}
          {artifact.hash && <p className="v2-meta">hash {artifact.hash}</p>}
        </div>
      )}
    </div>
  );
}

export function ArtifactList({ artifacts }: { artifacts: ArtifactView[] }) {
  if (!artifacts.length) {
    return <div className="v2-empty" role="status"><b>No artifacts</b><span>Generated files, images, and reports appear here when the run produces them.</span></div>;
  }
  return (
    <div>
      {artifacts.map((a) => <ArtifactViewer key={String(a.artifactId || a.id)} artifact={a} />)}
    </div>
  );
}
