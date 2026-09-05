import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './Center.css';
import { api } from '../api/client';
import { useRuntime } from '../state/store';
import { CopyButton, elapsed, fmtTime, usd } from './ui';
import { ExecutionTimeline } from './execution/ExecutionTimeline';
import { ResourceBar } from './execution/ResourceBar';
import { OutcomeCard } from './outcome/OutcomeCard';
import { Tip } from './Tooltip';
import { IconCheck, IconRetry, IconSend, IconStop, IconX } from './icons';
import type { ChatMessage, Run, RuntimeSnapshot } from '../types';

function roleLabel(m: ChatMessage) {
  if (m.role === 'user') return 'You';
  if (m.role === 'tool') return 'Tool';
  if (m.role === 'system') return 'System';
  return 'Agent';
}

// ---------- Safe text helpers (no raw HTML execution) ----------
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function inlineFmt(s: string): string {
  let out = esc(s);
  out = out.replace(/`([^`\n]+)`/g, '<code class="inline">$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  out = out.replace(/(^|[\s(])_([^_\n]+)_/g, '$1<em>$2</em>');
  out = out.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>');
  return out;
}
function isTableSep(line: string): boolean {
  return /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes('-');
}
function splitRow(line: string): string[] {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  return t.split('|').map(c => c.trim());
}
/** Back-compat string markdown renderer (safe: escaped, no raw HTML). */
export function renderMarkdown(src: string): string {
  const lines = String(src || '').split('\n');
  let html = '';
  let i = 0;
  let inCode = false;
  let codeLang = '';
  let codeBuf: string[] = [];
  const flushCode = () => {
    html += `<pre><code>${esc(codeBuf.join('\n'))}</code></pre>`;
    codeBuf = [];
  };
  let para: string[] = [];
  const flushPara = () => {
    if (!para.length) return;
    html += `<p>${para.map(inlineFmt).join('<br />')}</p>`;
    para = [];
  };
  let list: { ordered: boolean; items: string[] } | null = null;
  const flushList = () => {
    if (!list) return;
    const tag = list.ordered ? 'ol' : 'ul';
    html += `<${tag}>${list.items.map(it => `<li>${inlineFmt(it)}</li>`).join('')}</${tag}>`;
    list = null;
  };
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^```([A-Za-z0-9_+-]*)\s*$/);
    if (fence) {
      if (!inCode) { flushPara(); flushList(); inCode = true; codeLang = fence[1] || ''; codeBuf = []; if (codeLang) html += `<div class="codehead">${esc(codeLang)}</div>`; }
      else { flushCode(); inCode = false; }
      i++; continue;
    }
    if (inCode) { codeBuf.push(line); i++; continue; }
    if (/^\s*$/.test(line)) { flushPara(); flushList(); i++; continue; }
    if (/^#{1,4}\s+/.test(line)) {
      flushPara(); flushList();
      const m = line.match(/^(#{1,4})\s+(.*)$/)!;
      const lvl = m[1].length;
      html += `<h${lvl + 1}>${inlineFmt(m[2])}</h${lvl + 1}>`;
      i++; continue;
    }
    if (/^>\s?/.test(line)) {
      flushPara(); flushList();
      html += `<blockquote>${inlineFmt(line.replace(/^>\s?/, ''))}</blockquote>`;
      i++; continue;
    }
    if (/^\s*---+\s*$/.test(line)) { flushPara(); flushList(); html += '<hr />'; i++; continue; }
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flushPara(); flushList();
      const head = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') { rows.push(splitRow(lines[i])); i++; }
      html += `<div class="tblwrap"><table><thead><tr>${head.map(c => `<th>${inlineFmt(c)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${head.map((_, k) => `<td>${inlineFmt(r[k] || '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
      continue;
    }
    const ulm = line.match(/^\s*[-*•]\s+(.*)$/);
    const olm = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ulm || olm) {
      flushPara();
      const ordered = !!olm;
      const item = (ulm ? ulm[1] : olm![1]);
      if (!list || list.ordered !== ordered) { flushList(); list = { ordered, items: [] }; }
      list.items.push(item);
      i++; continue;
    }
    para.push(line.trim());
    i++;
  }
  if (inCode) flushCode();
  flushPara(); flushList();
  return html || '<p></p>';
}

// ---------- React markdown (code copy, safe links, no layout breakage) ----------
type Block =
  | { kind: 'code'; lang: string; code: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'quote'; text: string }
  | { kind: 'hr' }
  | { kind: 'table'; head: string[]; rows: string[][] }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'para'; text: string };

function parseBlocks(src: string): Block[] {
  const lines = String(src || '').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  let inCode = false;
  let codeLang = '';
  let codeBuf: string[] = [];
  let para: string[] = [];
  const flushPara = () => {
    if (!para.length) return;
    blocks.push({ kind: 'para', text: para.join('\n') });
    para = [];
  };
  let list: { ordered: boolean; items: string[] } | null = null;
  const flushList = () => {
    if (!list) return;
    blocks.push({ kind: 'list', ordered: list.ordered, items: list.items });
    list = null;
  };
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^```([A-Za-z0-9_+-]*)\s*$/);
    if (fence) {
      if (!inCode) { flushPara(); flushList(); inCode = true; codeLang = fence[1] || ''; codeBuf = []; }
      else { blocks.push({ kind: 'code', lang: codeLang, code: codeBuf.join('\n') }); inCode = false; codeBuf = []; }
      i++; continue;
    }
    if (inCode) { codeBuf.push(line); i++; continue; }
    if (/^\s*$/.test(line)) { flushPara(); flushList(); i++; continue; }
    const hm = line.match(/^(#{1,4})\s+(.*)$/);
    if (hm) { flushPara(); flushList(); blocks.push({ kind: 'heading', level: hm[1].length, text: hm[2] }); i++; continue; }
    if (/^>\s?/.test(line)) { flushPara(); flushList(); blocks.push({ kind: 'quote', text: line.replace(/^>\s?/, '') }); i++; continue; }
    if (/^\s*---+\s*$/.test(line)) { flushPara(); flushList(); blocks.push({ kind: 'hr' }); i++; continue; }
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flushPara(); flushList();
      const head = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') { rows.push(splitRow(lines[i])); i++; }
      blocks.push({ kind: 'table', head, rows });
      continue;
    }
    const ulm = line.match(/^\s*[-*•]\s+(.*)$/);
    const olm = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ulm || olm) {
      flushPara();
      const ordered = !!olm;
      const item = (ulm ? ulm[1] : olm![1]);
      if (!list || list.ordered !== ordered) { flushList(); list = { ordered, items: [] }; }
      list.items.push(item);
      i++; continue;
    }
    para.push(line.trim());
    i++;
  }
  if (inCode) blocks.push({ kind: 'code', lang: codeLang, code: codeBuf.join('\n') });
  flushPara(); flushList();
  return blocks;
}

function renderBoldItalic(text: string, kp: string): React.ReactNode[] {
  if (!text) return [];
  const out: React.ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|\*[^*\n]+\*|_[^_\n]+_)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(<React.Fragment key={`${kp}-t${k++}`}>{text.slice(last, m.index)}</React.Fragment>);
    const tok = m[0];
    if (tok.startsWith('**')) out.push(<strong key={`${kp}-b${k++}`}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith('*')) out.push(<em key={`${kp}-e${k++}`}>{tok.slice(1, -1)}</em>);
    else out.push(<em key={`${kp}-e${k++}`}>{tok.slice(1, -1)}</em>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(<React.Fragment key={`${kp}-t${k++}`}>{text.slice(last)}</React.Fragment>);
  return out;
}

function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const codeParts = text.split(/(`[^`\n]+`)/g);
  codeParts.forEach((part, ci) => {
    if (/^`[^`\n]+`$/.test(part)) {
      nodes.push(<code key={`${keyPrefix}-c${ci}`} className="inline">{part.slice(1, -1)}</code>);
      return;
    }
    const linkParts = part.split(/(\[[^\]]+\]\(https?:[^)\s]+\))/g);
    linkParts.forEach((lp, li) => {
      const lm = lp.match(/^\[([^\]]+)\]\((https?:[^)\s]+)\)$/);
      if (lm) {
        nodes.push(
          <a key={`${keyPrefix}-p${ci}-l${li}`} href={lm[2]} target="_blank" rel="noreferrer noopener">
            {renderBoldItalic(lm[1], `${keyPrefix}-p${ci}-l${li}`)}
          </a>
        );
        return;
      }
      renderBoldItalic(lp, `${keyPrefix}-p${ci}-s${li}`).forEach((n, k) =>
        nodes.push(<React.Fragment key={`${keyPrefix}-p${ci}-s${li}-${k}`}>{n}</React.Fragment>)
      );
    });
  });
  return nodes;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);
  const onCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const ok = await copyText(code);
    if (ok) {
      setCopied(true);
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1400);
    }
  };
  return (
    <div className="oa-codeblock">
      <div className="oa-codehead">
        <span className="oa-codelang" title={lang || 'code'}>{lang || 'code'}</span>
        <button
          type="button"
          className="oa-copybtn"
          onClick={onCopy}
          aria-label={copied ? 'Code copied to clipboard' : `Copy ${lang || 'code'} block to clipboard`}
          title="Copy code"
        >
          {copied ? 'COPIED' : 'COPY'}
        </button>
      </div>
      <pre tabIndex={0} aria-label={lang ? `${lang} code block` : 'Code block'}><code>{code}</code></pre>
    </div>
  );
}

const Markdown = memo(function Markdown({ source }: { source: string }) {
  const blocks = useMemo(() => parseBlocks(source), [source]);
  if (!source) return <p></p>;
  return (
    <>
      {blocks.map((b, bi) => {
        if (b.kind === 'code') return <CodeBlock key={bi} lang={b.lang} code={b.code} />;
        if (b.kind === 'heading') {
          const Tag = `h${Math.min(4, b.level + 1)}` as 'h2' | 'h3' | 'h4' | 'h5';
          return <Tag key={bi}>{renderInline(b.text, `h${bi}`)}</Tag>;
        }
        if (b.kind === 'quote') return <blockquote key={bi}>{renderInline(b.text, `q${bi}`)}</blockquote>;
        if (b.kind === 'hr') return <hr key={bi} />;
        if (b.kind === 'table') {
          return (
            <div className="tblwrap" key={bi}>
              <table>
                <thead><tr>{b.head.map((c, k) => <th key={k}>{renderInline(c, `th${bi}-${k}`)}</th>)}</tr></thead>
                <tbody>
                  {b.rows.map((r, ri) => (
                    <tr key={ri}>{b.head.map((_, k) => <td key={k}>{renderInline(r[k] || '', `td${bi}-${ri}-${k}`)}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        if (b.kind === 'list') {
          const Tag = b.ordered ? 'ol' : 'ul';
          return <Tag key={bi}>{b.items.map((it, k) => <li key={k}>{renderInline(it, `li${bi}-${k}`)}</li>)}</Tag>;
        }
        const parts = b.text.split('\n');
        return (
          <p key={bi}>
            {parts.map((ln, li) => (
              <React.Fragment key={li}>
                {li > 0 && <br />}
                {renderInline(ln, `p${bi}-${li}`)}
              </React.Fragment>
            ))}
          </p>
        );
      })}
    </>
  );
});

// ---------- Runtime journey ----------
// Five honest milestones, each derived from real snapshot state only:
// Task (a user message exists) → Context (tokens built) → Model (selected) →
// Execute (assistant responded) → Done (terminal). Never invented.
export function journeySteps(snap: RuntimeSnapshot): { label: string; state: 'done' | 'active' | 'todo' | 'failed' }[] {
  const status = String(snap.status || '');
  const terminal = status === 'completed' || status === 'failed' || status === 'cancelled';
  const msgs = snap.messages;
  const hasUser = msgs.some((m) => m.role === 'user');
  const hasAssistant = msgs.some((m) => m.role === 'assistant' && String(m.content || '').trim());
  const hasContext = snap.context.usedTokens > 0;
  const hasModel = !!snap.activeModelId;
  const busy = status === 'running' || status === 'planning' || status === 'waiting';
  const steps = [
    { label: 'Task', done: hasUser },
    { label: 'Context', done: hasContext },
    { label: 'Model', done: hasModel },
    { label: 'Execute', done: hasAssistant },
    { label: 'Done', done: status === 'completed' },
  ];
  if (status === 'failed' || status === 'cancelled') {
    return steps.map((s, i) => ({
      label: s.label,
      state: i === 4 ? 'failed' : s.done ? 'done' : i === steps.findIndex(x => !x.done) ? 'active' : 'todo',
    }));
  }
  if (terminal) return steps.map(s => ({ label: s.label, state: 'done' as const }));
  const firstOpen = steps.findIndex(s => !s.done);
  return steps.map((s, i) => ({
    label: s.label,
    state: s.done ? 'done' : i === firstOpen && (busy || hasUser) ? 'active' : 'todo',
  }));
}

function RunJourney({ snap }: { snap: RuntimeSnapshot }) {
  const steps = journeySteps(snap);
  return (
    <div className="journey" role="list" aria-label="Runtime progress">
      {steps.map((s, i) => (
        <React.Fragment key={s.label}>
          {i > 0 && <span className={`jlink ${steps[i - 1].state === 'done' ? 'done' : ''}`} aria-hidden="true" />}
          <span
            role="listitem"
            aria-current={s.state === 'active' ? 'step' : undefined}
            aria-label={`${s.label}: ${s.state}`}
            className={`jstep ${s.state}`}
            title={`${s.label} — ${s.state}`}
          >
            <span className="jdot" aria-hidden="true">{s.state === 'done' ? <IconCheck size={12} /> : s.state === 'failed' ? <IconX size={12} /> : i + 1}</span>
            <span className="jlabel">{s.label}</span>
          </span>
        </React.Fragment>
      ))}
    </div>
  );
}

// ---------- Run status ----------
// One primary runtime status. Secondary technical states live in the inspector.
type RunKey = 'READY' | 'RUNNING' | 'STOPPING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'RETRYING' | 'UNKNOWN';
const RUN_META: Record<RunKey, { pill: string }> = {
  READY: { pill: 'neutral' },
  RUNNING: { pill: 'info' },
  STOPPING: { pill: 'warn' },
  COMPLETED: { pill: 'ok' },
  FAILED: { pill: 'err' },
  CANCELLED: { pill: 'neutral' },
  RETRYING: { pill: 'warn' },
  UNKNOWN: { pill: 'neutral' },
};
function resolveStatus(raw: string | undefined | null, stopping: boolean, retrying: boolean): RunKey {
  if (stopping) return 'STOPPING';
  if (retrying) return 'RETRYING';
  const s = String(raw || '').toLowerCase();
  if (s === 'idle') return 'READY';
  if (s === 'planning' || s === 'running' || s === 'waiting') return 'RUNNING';
  if (s === 'completed') return 'COMPLETED';
  if (s === 'failed') return 'FAILED';
  if (s === 'cancelled') return 'CANCELLED';
  if (!s) return 'READY';
  return 'UNKNOWN';
}
const BUSY = new Set(['running', 'planning', 'waiting']);

// ---------- Tool parsing ----------
type ToolState = 'RUNNING' | 'SUCCESS' | 'FAILED' | 'CANCELLED' | 'UNKNOWN';
const TOOL_META: Record<ToolState, { pill: string; label: string }> = {
  RUNNING: { pill: 'warn', label: 'Running' },
  SUCCESS: { pill: 'ok', label: 'Completed' },
  FAILED: { pill: 'err', label: 'Failed' },
  CANCELLED: { pill: 'neutral', label: 'Cancelled' },
  UNKNOWN: { pill: 'neutral', label: 'Tool' },
};
function parseTool(content: string): { name: string; state: ToolState; duration: string | null; detail: string } {
  const text = String(content || '');
  const colon = text.indexOf(':');
  let name = 'tool';
  let detail = text;
  if (colon > 0 && colon < 64) {
    name = text.slice(0, colon).trim().split(/\s+/)[0] || 'tool';
    detail = text.slice(colon + 1).trim();
  } else {
    name = (text.split(/\s+/)[0] || 'tool').slice(0, 48);
  }
  let state: ToolState = 'UNKNOWN';
  if (/RUNNING/i.test(text)) state = 'RUNNING';
  else if (/CANCEL/i.test(text)) state = 'CANCELLED';
  else if (/FAIL|ERROR/i.test(text)) state = 'FAILED';
  else if (/SUCCESS|COMPLETED|\bDONE\b|\bOK\b/i.test(text)) state = 'SUCCESS';
  const dm = text.match(/\((\d+(?:\.\d+)?\s*(?:ms|s))\)/i);
  return { name, state, duration: dm ? dm[1].replace(/\s+/g, '') : null, detail };
}

function RunningElapsed({ sinceTs }: { sinceTs: string }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick(n => n + 1), 500);
    return () => clearInterval(t);
  }, []);
  let label = '…';
  try {
    const ms = Math.max(0, Date.now() - new Date(sinceTs).getTime());
    label = ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)}s`;
  } catch { /* keep … */ }
  return <span className="oa-mono" aria-label={`Elapsed ${label}`}>{label}</span>;
}

// ---------- Message items ----------
const MsgItem = memo(function MsgItem({ m }: { m: ChatMessage }) {
  const meta = m.meta || {};
  const streaming = !!meta.streaming;
  if (m.role === 'user') {
    return (
      <div className="msg user oa-user" data-testid={`msg-${m.id}`}>
        <span className="who">
          {roleLabel(m)} · <time dateTime={m.ts}>{fmtTime(m.ts)}</time>
          <CopyButton text={m.content} label="Copy user message" />
        </span>
        <div className="md-plain oa-user-body">{m.content}</div>
      </div>
    );
  }
  if (m.role === 'tool') {
    const parsed = parseTool(m.content);
    const tm = TOOL_META[parsed.state];
    const long = m.content.length > 220;
    return (
      <div className={`msg tool oa-tool oa-tool-${parsed.state.toLowerCase()}`} data-testid={`msg-${m.id}`}>
        <span className="who">
          Tool · <time dateTime={m.ts}>{fmtTime(m.ts)}</time>
          <CopyButton text={m.content} label={`Copy tool output from ${parsed.name}`} />
        </span>
        <div className="oa-tool-row">
          <span className="oa-tool-name" title={parsed.name}>{parsed.name}</span>
          <span className={`pill sm ${tm.pill}`} title={`Tool ${tm.label}`}>
            {parsed.state}
          </span>
          {parsed.state === 'RUNNING' ? (
            <RunningElapsed sinceTs={m.ts} />
          ) : parsed.duration ? (
            <span className="oa-mono" title="Tool duration">{parsed.duration}</span>
          ) : null}
          {streaming && <span className="pill sm info">LIVE</span>}
        </div>
        {parsed.state === 'RUNNING' && parsed.detail ? (
          <div className="oa-tool-detail">{parsed.detail.slice(0, 160)}</div>
        ) : null}
        {parsed.state !== 'RUNNING' && (
          long ? (
            <details className="oa-details">
              <summary>Details</summary>
              <pre className="oa-tool-output">{m.content}</pre>
            </details>
          ) : (
            <div className="oa-tool-output-inline">{m.content}</div>
          )
        )}
        {parsed.state === 'RUNNING' && long ? (
          <details className="oa-details">
            <summary>Raw output</summary>
            <pre className="oa-tool-output">{m.content}</pre>
          </details>
        ) : null}
      </div>
    );
  }
  if (m.role === 'system') {
    return (
      <div className="msg system oa-system" role="note" data-testid={`msg-${m.id}`}>
        <span className="who">
          Runtime · <time dateTime={m.ts}>{fmtTime(m.ts)}</time>
          <CopyButton text={m.content} label="Copy runtime notice" />
        </span>
        <div className="oa-sys-body">{m.content}</div>
      </div>
    );
  }
  // assistant (primary content)
  return (
    <article className="msg assistant oa-assistant" aria-busy={streaming || undefined} data-testid={`msg-${m.id}`}>
      <span className="who">
        {roleLabel(m)} · <time dateTime={m.ts}>{fmtTime(m.ts)}</time>
        {typeof meta.model === 'string' && meta.model ? (
          <span className="oa-meta-model" title={`Model ${meta.model}`}>{String(meta.model).split('/').pop()}</span>
        ) : null}
        {typeof meta.durationMs === 'number' ? (
          <span className="oa-mono" title="Step duration">{(meta.durationMs / 1000).toFixed(1)}s</span>
        ) : null}
        {typeof meta.tokens === 'number' ? (
          <span className="oa-mono" title="Tokens">{meta.tokens} tok</span>
        ) : null}
        {streaming && <span className="pill sm info"><span className="oa-livedot" aria-hidden="true" /> STREAMING</span>}
        <CopyButton text={m.content} label="Copy assistant message" />
      </span>
      <div className="md oa-md">
        <Markdown source={m.content} />
      </div>
      {streaming && <span className="oa-cursor" aria-hidden="true" />}
      {streaming && <span className="sr-only" role="status">Assistant is generating…</span>}
    </article>
  );
});

export function MessageList({ messages }: { messages: ChatMessage[] }) {
  const { state } = useRuntime();
  const snap = state.server.snapshot;
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const last = messages[messages.length - 1];
  const lastLen = last?.content.length || 0;
  const lastId = last?.id;

  const updatePinned = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    pinned.current = nearBottom;
    setShowJump(!nearBottom && messages.length > 0);
  }, [messages.length]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.addEventListener('scroll', updatePinned, { passive: true } as AddEventListenerOptions);
    return () => el.removeEventListener('scroll', updatePinned);
  }, [updatePinned]);

  useEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, lastLen, lastId]);

  const jumpToLatest = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    pinned.current = true;
    setShowJump(false);
    el.scrollTop = el.scrollHeight;
  }, []);

  const streaming = useMemo(() => messages.some(m => !!m.meta?.streaming), [messages]);
  const runningTool = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === 'tool' && /RUNNING/i.test(m.content)) return parseTool(m.content).name;
      if (m.role === 'assistant' && !m.meta?.streaming) break;
    }
    return null;
  }, [messages]);

  const snapBusy = !!snap && BUSY.has(String(snap.status));
  const activity = streaming
    ? (runningTool ? `Running ${runningTool}…` : 'Generating…')
    : runningTool
      ? `Running ${runningTool}…`
      : snapBusy && /planning/i.test(String(snap?.status))
        ? 'Planning…'
        : snapBusy
          ? 'Waiting for provider…'
          : null;

  if (!messages.length) {
    const mode = String(snap?.meta?.mode || '').toLowerCase();
    return (
      <div className="feed oa-feed" role="log" aria-label="Agent conversation" aria-live="polite">
        <div className="welcome" role="status">
          <span className="w-badge">OrchestraAI runtime</span>
          <h2>What should we work on?</h2>
          <p>Describe a task below. Your runtime will gather context, pick the right model, use tools when needed — and show its work at every step.</p>
          <div className="w-steps">
            <div className="w-step"><span className="w-num" aria-hidden="true">1</span><div><b>Describe your task</b><span>Debug, code, research — pick a mode in the composer.</span></div></div>
            <div className="w-step"><span className="w-num" aria-hidden="true">2</span><div><b>Watch it think</b><span>Follow Task → Context → Model → Execute above.</span></div></div>
            <div className="w-step"><span className="w-num" aria-hidden="true">3</span><div><b>Inspect every decision</b><span>Open the inspector to see why this model, what it cost, what changed.</span></div></div>
          </div>
          <div className="w-mode">
            {mode === 'live'
              ? 'LIVE mode — talking to your real configured provider.'
              : mode === 'demo'
                ? 'DEMO mode — a labelled mock provider so you can explore offline. Nothing here calls a real model.'
                : 'Waiting for runtime state…'}
          </div>
        </div>
      </div>
    );
  }
  const visible = messages.slice(-150);
  const snapStatus = String(snap?.status || '');
  const showError = snapStatus === 'failed';
  const showCancelled = snapStatus === 'cancelled';
  const showTimeline = !!snap && Array.isArray(snap.trace) && snap.trace.length > 0;

  return (
    <div className="oa-feedwrap">
      <div className="feed oa-feed" ref={ref} role="log" aria-label="Agent conversation" aria-live="polite">
        {showTimeline && (
          <details className="oa-timeline-wrap" open={snapStatus !== 'completed'}>
            <summary>Execution timeline — {snap!.trace.length} step{snap!.trace.length === 1 ? '' : 's'}</summary>
            <ExecutionTimeline trace={snap!.trace} status={snapStatus} />
          </details>
        )}
        {messages.length > visible.length && (
          <div className="banner info oa-range" role="note">Showing latest {visible.length} of {messages.length} messages.</div>
        )}
        {visible.map(m => <MsgItem key={m.id} m={m} />)}
        {showError && (
          <div className="oa-inline-error" role="alert" data-testid="run-error-card">
            <div className="oa-inline-error-head"><b>Provider unavailable</b></div>
            <p>The model provider did not respond. Your conversation is preserved — review the last step, then retry when ready.</p>
            <div className="oa-inline-error-actions">
              <button
                type="button"
                className="icon-btn sm"
                onClick={() => snap && state.server.activeRunId && api.retryRun(state.server.activeRunId).catch(() => {})}
                aria-label="Retry run"
              >
                <IconRetry size={14} /> Retry
              </button>
              <details className="oa-details">
                <summary>Technical details</summary>
                <pre className="oa-tool-output">status: failed · run {snap?.runId || state.server.activeRunId || 'unknown'} · updated {snap?.updatedAt || 'unknown'}</pre>
              </details>
            </div>
          </div>
        )}
        {showCancelled && !showError && (
          <div className="oa-inline-cancel" role="status" data-testid="run-cancelled-card">
            <b>Cancelled.</b><span> State is preserved — press New Run to start another task.</span>
          </div>
        )}
        {snapStatus === 'completed' && snap && (
          <>
            <OutcomeCard
              snap={snap}
              onReviewChanges={() => document.getElementById('sec-changes')?.scrollIntoView({ behavior: 'smooth' })}
              onViewEvidence={() => document.getElementById('sec-evidence')?.scrollIntoView({ behavior: 'smooth' })}
            />
            <RunOutcome snap={snap} run={state.server.runs.find(r => r.id === state.server.activeRunId)} />
          </>
        )}
      </div>
      {activity && (
        <div className="oa-activity" role="status" aria-label={activity} data-testid="execution-activity">
          <span className="oa-livedot" aria-hidden="true" />
          <span>{activity}</span>
          {streaming && <span className="oa-mono oa-activity-hint">{visible.length} msgs</span>}
        </div>
      )}
      {showJump && (
        <button type="button" className="oa-jump" onClick={jumpToLatest} aria-label="Jump to latest messages">
          Jump to latest
        </button>
      )}
    </div>
  );
}

export function RunHeader() {
  const { state } = useRuntime();
  const snap = state.server.snapshot;
  const [stopping, setStopping] = useState(false);
  const [retrying, setRetrying] = useState(false);

  const rawStatus = String(snap?.status || '');
  const busy = !!snap && BUSY.has(rawStatus);
  useEffect(() => { if (!busy) setStopping(false); }, [busy]);
  useEffect(() => { if (rawStatus === 'running' || rawStatus === 'planning' || rawStatus === 'waiting') setRetrying(false); }, [rawStatus]);

  if (!snap) {
    return (
      <div className="run-header oa-run-header" role="status" aria-label="No runtime state">
        <div className="rh-title oa-rh-title">
          <h1>Agent Run</h1>
          <span className="sub">UNKNOWN — waiting for runtime</span>
        </div>
        <span className="pill neutral">UNKNOWN</span>
      </div>
    );
  }

  const run = state.server.runs.find(r => r.id === state.server.activeRunId);
  const key = resolveStatus(snap.status, stopping, retrying);
  const meta = RUN_META[key];
  const label = key === 'UNKNOWN' ? (String(snap.status || 'UNKNOWN').toUpperCase() || 'UNKNOWN') : key;

  const canStop = busy && !stopping;
  const canRetry = !busy && !retrying && (rawStatus === 'failed' || rawStatus === 'completed' || rawStatus === 'cancelled');

  const doStop = async () => {
    const id = state.server.activeRunId;
    if (!id || stopping) return;
    setStopping(true);
    try { await api.cancelRun(id); } catch { setStopping(false); }
  };
  const doRetry = async () => {
    const id = state.server.activeRunId;
    if (!id || retrying) return;
    setRetrying(true);
    try { await api.retryRun(id); } catch { setRetrying(false); }
  };

  // Center answers WHAT AM I WORKING ON: title + one status + progress.
  // A secondary resource line (cost/time/tokens) stays subtle and never
  // competes with the outcome; full detail lives in the inspector.
  const preset = snap.meta?.preset;
  const mode = snap.meta?.mode;
  return (
    <div className="run-header oa-run-header">
      <div className="rh-title oa-rh-title">
        <h1 title={run?.title || 'Agent Run'}>{run?.title || 'Agent Run'}</h1>
        <span className="sub">{run ? `${relRunMeta(run)}` : 'runtime session'}{preset ? ` · ${preset}` : ''}{mode ? ` · ${mode}` : ''}</span>
        <ResourceBar snap={snap} run={run} />
      </div>
      <span className={`pill ${meta.pill}`} role="status" aria-label={`Run status ${label}`} title={label === 'RUNNING' ? 'Agent is executing' : label}>
        {label === 'RUNNING' && <span className="oa-livedot" aria-hidden="true" />}
        {label === 'COMPLETED' && <IconCheck size={13} />}
        {label === 'FAILED' && <IconX size={13} />}
        {label}
      </span>
      <span className="sr-only" role="status">Run {label}</span>
      <div className="run-actions oa-run-actions">
        {canStop && (
          <Tip label="Interrupt this run" shortcut="Esc">
            <button className="icon-btn danger" onClick={doStop} disabled={stopping} aria-label="Stop run">
              <IconStop size={14} /> Stop
            </button>
          </Tip>
        )}
        {stopping && busy && (
          <button className="icon-btn danger" disabled aria-label="Stopping run">
            Stopping…
          </button>
        )}
        {canRetry && (
          <Tip label="Resume from the last checkpoint">
            <button className="icon-btn" onClick={doRetry} disabled={retrying} aria-label="Retry run">
              <IconRetry size={14} /> {retrying ? 'Retrying…' : 'Retry'}
            </button>
          </Tip>
        )}
      </div>
      <RunJourney snap={snap} />
    </div>
  );
}

function relRunMeta(run: { taskMode: string; createdAt: string }): string {
  try { return `${run.taskMode} · started ${new Date(run.createdAt).toLocaleString()}`; }
  catch { return run.taskMode; }
}

const COMPOSER_PLACEHOLDER = 'What do you want OrchestraAI to do?';
const TASK_MODE_HINTS: Record<string, string> = {
  auto: 'Auto: let OrchestraAI choose the approach',
  debug: 'Debug: diagnose failures and trace causes',
  code: 'Code: implement and edit with runtime context',
  research: 'Research: investigate across code and docs',
  general: 'General: open-ended agent assistance',
};

export function Composer() {
  const { state, dispatch } = useRuntime();
  const [text, setText] = useState('');
  const [stopping, setStopping] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const snap = state.server.snapshot;
  const status = String(snap?.status || '');
  const busy = !!snap && BUSY.has(status);
  const terminal = status === 'completed' || status === 'failed' || status === 'cancelled';
  const failed = status === 'failed';
  const terminalHint = status === 'failed'
    ? 'This run failed — use Retry above to resume from the last checkpoint.'
    : status === 'cancelled'
      ? 'This run was cancelled — press New Run above to start another task.'
      : 'This run is complete — press New Run above to start another task.';

  useEffect(() => { if (!busy) setStopping(false); }, [busy]);

  // Auto-grow textarea up to the CSS max-height.
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    const next = Math.min(200, Math.max(52, ta.scrollHeight));
    ta.style.height = `${next}px`;
  }, [text]);

  const submit = useCallback(async () => {
    const id = state.server.activeRunId;
    const content = text.trim();
    if (!id || !content || state.server.sending || busy || terminal) return;
    dispatch({ type: 'send/set', sending: true });
    setSendError(null);
    dispatch({ type: 'msg/add', msg: { id: `u-${Date.now()}`, role: 'user', content, ts: new Date().toISOString() } });
    setText('');
    try {
      await api.sendMessage(id, content);
      requestAnimationFrame(() => taRef.current?.focus());
    }
    catch (e) {
      const msg = e instanceof Error ? e.message : 'backend unavailable';
      setSendError(msg);
      setText(content);
      dispatch({ type: 'msg/add', msg: { id: `e-${Date.now()}`, role: 'system', content: `Failed to send (${msg}).`, ts: new Date().toISOString() } });
      requestAnimationFrame(() => taRef.current?.focus());
    }
    finally { dispatch({ type: 'send/set', sending: false }); }
  }, [busy, terminal, dispatch, state.server.activeRunId, state.server.sending, text]);

  const stop = async () => {
    const id = state.server.activeRunId;
    if (!id || stopping) return;
    setStopping(true);
    try {
      await api.cancelRun(id);
      requestAnimationFrame(() => taRef.current?.focus());
    } catch { setStopping(false); }
  };

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === '/' && !state.ui.paletteOpen && (document.activeElement === document.body)) {
        e.preventDefault();
        taRef.current?.focus();
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [state.ui.paletteOpen]);

  // Composer stays simple: task + primary action. Model, cost, tokens and
  // latency live in the inspector — never duplicated here. Task mode shapes
  // routing for a fresh task, so it stays as one compact contextual control.
  return (
    <div className="composer oa-composer">
      <div className="composer-box oa-composer-box">
        <label className="sr-only" htmlFor="prompt">Message the agent</label>
        <textarea
          id="prompt"
          ref={taRef}
          placeholder={busy ? 'Agent is running — Stop to interrupt…' : terminal ? terminalHint : COMPOSER_PLACEHOLDER}
          value={text}
          disabled={busy || terminal || !snap}
          rows={2}
          aria-label="Message the agent"
          aria-describedby="composer-hint"
          onChange={e => setText(e.target.value)}
          onKeyDown={e => {
            const ne = e.nativeEvent as unknown as { isComposing?: boolean };
            if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
              if (ne.isComposing || e.keyCode === 229) return;
              e.preventDefault();
              void submit();
            } else if (e.key === 'Escape') {
              (e.target as HTMLTextAreaElement).blur();
            }
          }}
        />
        <span id="composer-hint" className="sr-only">Press Enter to send, Shift Enter for a new line, Escape to leave the input.</span>
        <div className="composer-row oa-composer-row">
          <label className="sr-only" htmlFor="taskmode">Task mode</label>
          <Tip label={TASK_MODE_HINTS[state.ui.taskMode] || 'How the agent should approach your request'}>
            <select
              id="taskmode"
              className="icon-btn oa-taskmode"
              aria-label="Task mode"
              value={state.ui.taskMode}
              disabled={busy || terminal}
              onChange={e => dispatch({ type: 'ui/set', patch: { taskMode: e.target.value } })}
            >
              <option value="auto">auto</option><option value="debug">debug</option><option value="code">code</option><option value="research">research</option><option value="general">general</option>
            </select>
          </Tip>
          {sendError && (
            <button type="button" className="oa-retry-link" role="alert" title={sendError} onClick={() => void submit()} aria-label={`Send failed: ${sendError}. Activate to retry.`}>
              Send failed — retry
            </button>
          )}
          <span style={{ flex: 1 }} />
          {busy ? (
            <Tip label="Interrupt this run" shortcut="Esc">
              <button className="icon-btn danger" onClick={stop} disabled={stopping} aria-label="Stop run"><IconStop size={14} /> {stopping ? 'Stopping…' : 'Stop'}</button>
            </Tip>
          ) : failed ? (
            <button
              className="icon-btn"
              onClick={() => state.server.activeRunId && api.retryRun(state.server.activeRunId).catch(() => {})}
              aria-label="Retry run"
            >
              <IconRetry size={14} /> Retry
            </button>
          ) : (
            <Tip label="Send to OrchestraAI" shortcut="Enter">
              <button className="send-btn" onClick={() => void submit()} disabled={!text.trim() || state.server.sending || !snap || terminal} aria-label="Send message">
                {state.server.sending ? 'Sending…' : (<><IconSend size={15} /> Send</>)}
              </button>
            </Tip>
          )}
        </div>
      </div>
    </div>
  );
}

/** End-of-run outcome: concise, real numbers only. Never invented. */
export function RunOutcome({ snap, run }: { snap: RuntimeSnapshot | null; run?: Pick<Run, 'createdAt'> | null }) {
  if (!snap || String(snap.status) !== 'completed') return null;
  const parts: string[] = [];
  try {
    if (run?.createdAt && snap.updatedAt) parts.push(elapsed(run.createdAt, snap.updatedAt));
  } catch { /* omit */ }
  const spent = typeof snap.cost?.spentUsd === 'number' && Number.isFinite(snap.cost.spentUsd) ? usd(snap.cost.spentUsd) : null;
  if (spent && spent !== '—') parts.push(spent);
  const toolCalls = snap.tools.reduce((a, t) => a + (t.calls || 0), 0);
  if (toolCalls > 0) parts.push(`${toolCalls} tool${toolCalls === 1 ? '' : 's'}`);
  const switches = snap.decisions.filter((d) => d.kind === 'model_switch').length;
  if (switches > 0) parts.push(`${switches} model switch${switches === 1 ? '' : 'es'}`);
  if (!parts.length) return null;
  return (
    <div className="oa-outcome" role="status" aria-label={`Run completed: ${parts.join(', ')}`}>
      <IconCheck size={15} />
      <b>Completed</b>
      <span>{parts.join(' · ')}</span>
    </div>
  );
}
