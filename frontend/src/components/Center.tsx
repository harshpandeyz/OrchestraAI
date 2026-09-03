import React, { memo, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';
import { useRuntime } from '../state/store';
import { CopyButton, elapsed, fmtTime, statusPill, usd } from './ui';
import type { ChatMessage } from '../types';

function roleLabel(m: ChatMessage) {
  if (m.role === 'user') return 'You';
  if (m.role === 'tool') return 'Tool';
  if (m.role === 'system') return 'System';
  return 'Agent';
}

// ---------- Minimal safe markdown (no deps, no raw HTML) ----------
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
    const fence = line.match(/^```(\w*)\s*$/);
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
    if (/^&gt;/.test(esc(line)) || /^>\s?/.test(line)) {
      flushPara(); flushList();
      html += `<blockquote>${inlineFmt(line.replace(/^>\s?/, ''))}</blockquote>`;
      i++; continue;
    }
    if (/^\s*---+\s*$/.test(line)) { flushPara(); flushList(); html += '<hr />'; i++; continue; }
    // table: header + separator + rows
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

const MsgItem = memo(function MsgItem({ m }: { m: ChatMessage }) {
  const streaming = (m.meta as any)?.streaming;
  const isTool = m.role === 'tool';
  const fail = /FAIL/i.test(m.content);
  const ok = /SUCCESS/i.test(m.content);
  const cls = m.role === 'user' ? 'user' : isTool ? `tool ${fail ? 'fail' : ok ? 'ok' : ''}` : m.role === 'system' ? 'system' : 'assistant';
  const body = useMemo(() => {
    if (m.role === 'user' || isTool) return null;
    try { return renderMarkdown(m.content); } catch { return null; }
  }, [m.content, m.role, isTool]);
  return (
    <div className={`msg ${cls}`}>
      <span className="who">
        {roleLabel(m)} · <time dateTime={m.ts}>{fmtTime(m.ts)}</time>
        {streaming && <span className="pill info" style={{ fontSize: 10 }}>STREAMING</span>}
        <CopyButton text={m.content} label={`Copy ${roleLabel(m)} message`} />
      </span>
      {m.role === 'assistant' || m.role === 'system' ? (
        <div className="md" dangerouslySetInnerHTML={{ __html: body || esc(m.content) }} />
      ) : (
        <div className="md-plain">{m.content}</div>
      )}
      {streaming && <span className="cursor" aria-hidden="true" />}
    </div>
  );
});

export function MessageList({ messages }: { messages: ChatMessage[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const last = messages[messages.length - 1];
  const lastLen = last?.content.length || 0;
  const lastId = last?.id;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, lastLen, lastId]);

  if (!messages.length) {
    return (
      <div className="feed" role="log" aria-label="Agent conversation" aria-live="polite">
        <div className="empty" role="status">
          <b>No messages yet</b>
          <span>Send a message below to start this runtime session.</span>
        </div>
      </div>
    );
  }
  const visible = messages.slice(-150);
  return (
    <div className="feed" ref={ref} role="log" aria-label="Agent conversation" aria-live="polite">
      {messages.length > visible.length && (
        <div className="banner info" role="note">Showing latest {visible.length} of {messages.length} messages.</div>
      )}
      {visible.map(m => <MsgItem key={m.id} m={m} />)}
    </div>
  );
}

export function RunHeader() {
  const { state } = useRuntime();
  const snap = state.server.snapshot!;
  const run = state.server.runs.find(r => r.id === state.server.activeRunId);
  const model = state.server.models.find(m => m.id === snap.activeModelId);
  const pct = Math.min(1, snap.cost.spentUsd / Math.max(1e-9, snap.cost.budgetUsd));
  const busy = ['running', 'planning', 'waiting'].includes(String(snap.status));
  const failed = snap.status === 'failed';
  const [, tick] = useState(0);
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => tick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, [busy]);
  const pillCls = statusPill(snap.status);
  const barCls = pct >= 1 ? 'crit' : pct >= 0.8 ? 'hot' : '';
  return (
    <div className="run-header">
      <div className="rh-title">
        <h1 title={run?.title || 'Agent Run'}>{run?.title || 'Agent Run'}</h1>
        <span className="sub">{run ? `${relRunMeta(run)}` : ''}</span>
      </div>
      <span className={`pill ${pillCls}`}>{String(snap.status).toUpperCase()}</span>
      {snap.meta && (
        <span className={`pill ${snap.meta.mode === 'live' ? 'ok' : 'neutral'}`}
          title={snap.meta.mode === 'live' ? `Live provider${snap.meta.provider ? `: ${snap.meta.provider}` : ''}` : 'Demo mode: mock provider, no real model calls'}>
          {snap.meta.mode === 'live' ? 'LIVE' : 'DEMO'}
        </span>
      )}
      {model ? (
        <span className="pill info" title={`${model.provider} · ${(model.contextWindow / 1000).toFixed(0)}k context · ${model.status}`}>{model.name}</span>
      ) : snap.activeModelId ? (
        <span className="pill neutral" title={snap.activeModelId}>{snap.activeModelId}</span>
      ) : null}
      <div className="budget-wrap" title={`Spent ${usd(snap.cost.spentUsd)} of ${usd(snap.cost.budgetUsd)} · projected ${usd(snap.cost.projectedUsd)}`}>
        <div className={`budget-bar ${barCls}`} role="img" aria-label={`Budget spent ${usd(snap.cost.spentUsd)} of ${usd(snap.cost.budgetUsd)}`}>
          <i style={{ width: `${pct * 100}%` }} />
        </div>
        <span className="budget-txt">{usd(snap.cost.spentUsd)} / {usd(snap.cost.budgetUsd)}</span>
      </div>
      <div className="run-stats" aria-label="Run statistics">
        <span title={run?.createdAt ? `Started ${new Date(run.createdAt).toLocaleString()}` : 'Elapsed'}>
          ⏱ {run?.createdAt ? elapsed(run.createdAt, ['completed', 'failed', 'cancelled'].includes(String(snap.status)) ? snap.updatedAt : undefined) : '—'}
        </span>
      </div>
      <div className="run-actions">
        {busy && (
          <button className="icon-btn danger" onClick={() => state.server.activeRunId && api.cancelRun(state.server.activeRunId).catch(() => {})} aria-label="Stop run">
            ■ Stop
          </button>
        )}
        {(failed || snap.status === 'completed' || snap.status === 'cancelled') && (
          <button className="icon-btn" onClick={() => state.server.activeRunId && api.retryRun(state.server.activeRunId).catch(() => {})} aria-label="Retry run">
            ↻ Retry
          </button>
        )}
      </div>
    </div>
  );
}

function relRunMeta(run: { taskMode: string; createdAt: string }): string {
  try { return `${run.taskMode} · started ${new Date(run.createdAt).toLocaleString()}`; }
  catch { return run.taskMode; }
}

type ComposerState = 'READY' | 'RUNNING' | 'STOPPING' | 'ERROR' | 'COMPLETED';
export function Composer() {
  const { state, dispatch } = useRuntime();
  const [text, setText] = useState('');
  const [stopping, setStopping] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const snap = state.server.snapshot;
  const status = String(snap?.status || '');
  const busy = !!snap && ['running', 'planning', 'waiting'].includes(status);
  const cstate: ComposerState = !snap ? 'READY' : sendError ? 'ERROR' : stopping && busy ? 'STOPPING' : busy ? 'RUNNING' : status === 'failed' ? 'ERROR' : ['completed', 'cancelled'].includes(status) ? 'COMPLETED' : 'READY';
  const model = state.server.models.find(m => m.id === snap?.activeModelId);

  useEffect(() => { if (!busy) setStopping(false); }, [busy]);

  const submit = async () => {
    const id = state.server.activeRunId;
    const content = text.trim();
    if (!id || !content || state.server.sending || busy) return;
    dispatch({ type: 'send/set', sending: true });
    setSendError(null);
    dispatch({ type: 'msg/add', msg: { id: `u-${Date.now()}`, role: 'user', content, ts: new Date().toISOString() } });
    setText('');
    try { await api.sendMessage(id, content); }
    catch (e) {
      const msg = e instanceof Error ? e.message : 'backend unavailable';
      setSendError(msg);
      dispatch({ type: 'msg/add', msg: { id: `e-${Date.now()}`, role: 'system', content: `Failed to send (${msg}).`, ts: new Date().toISOString() } });
    }
    finally { dispatch({ type: 'send/set', sending: false }); }
  };

  const stop = async () => {
    const id = state.server.activeRunId;
    if (!id) return;
    setStopping(true);
    try { await api.cancelRun(id); } catch { setStopping(false); }
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

  return (
    <div className="composer">
      <div className="composer-box">
        <label className="sr-only" htmlFor="prompt">Message the agent</label>
        <textarea id="prompt" ref={taRef} placeholder={busy ? 'Agent is running — Stop to interrupt…' : 'Ask the agent to do something…  (Enter to send, Shift+Enter for newline)'}
          value={text} disabled={busy || !snap}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }} />
        <div className="composer-row">
          <span className="pill neutral" title={model ? `${model.provider} · ${(model.contextWindow / 1000).toFixed(0)}k` : 'No model selected'}>{model ? model.name : 'no model'}</span>
          <span className="pill neutral" title={`Spent ${usd(snap?.cost.spentUsd)} of ${usd(snap?.cost.budgetUsd)}`}>💰 {usd(snap?.cost.spentUsd)} / {usd(snap?.cost.budgetUsd)}</span>
          <label className="sr-only" htmlFor="taskmode">Task mode</label>
          <select id="taskmode" className="icon-btn" aria-label="Task mode" value={state.ui.taskMode} disabled={busy}
            onChange={e => dispatch({ type: 'ui/set', patch: { taskMode: e.target.value } })}>
            <option value="debug">debug</option><option value="code">code</option><option value="research">research</option><option value="general">general</option>
          </select>
          <span className={`composer-status ${cstate.toLowerCase()}`} role="status" aria-label={`Composer ${cstate}`}>
            <span className="sdot" aria-hidden="true" />{cstate}
          </span>
          {sendError && <span className="composer-err" role="alert" title={sendError}>Send failed — retry</span>}
          <span style={{ flex: 1 }} />
          {busy ? (
            <button className="icon-btn danger" onClick={stop} disabled={stopping} aria-label="Stop run">{stopping ? 'Stopping…' : '■ Stop'}</button>
          ) : (
            <button className="send-btn" onClick={submit} disabled={!text.trim() || state.server.sending || !snap} aria-label="Send message">
              {state.server.sending ? 'Sending…' : 'Send ⏎'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
