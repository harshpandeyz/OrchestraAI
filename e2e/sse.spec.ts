import { test, expect } from '@playwright/test';
import { BASE_URL, signup, sessionCookie } from './util';

// SSE contract tests. Release-critical invariants:
//   * a run's event stream is replayable and delivers named events;
//   * a run that finished before the "browser" connected still yields its
//     authoritative terminal event (no forever-RUNNING view).

interface RunBody { run: { id: string } }
interface ProjectList { projects: { id: string }[] }
interface RunList { runs: { id: string }[] }

async function collectEvents(cookie: string, path: string, until: string[], timeoutMs = 90_000): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { Cookie: cookie },
    signal: controller.signal,
  });
  if (!res.ok || !res.body) throw new Error(`SSE request failed: ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const events: string[] = [];
  const seen = new Set<string>();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const frames = buf.split('\n\n');
      buf = frames.pop() ?? '';
      for (const frame of frames) {
        const evLine = frame.split('\n').find((l) => l.startsWith('event:'));
        const ev = evLine?.slice(6).trim();
        if (ev) {
          events.push(ev);
          if (until.includes(ev)) seen.add(ev);
        }
      }
      if (until.every((e) => seen.has(e))) { controller.abort(); break; }
    }
  } catch (e) {
    if ((e as Error).name !== 'AbortError') throw e;
  } finally {
    clearTimeout(timer);
  }
  return events;
}

async function createRunAndStart(context: import('@playwright/test').BrowserContext): Promise<string> {
  const projects = await fetch(`${BASE_URL}/api/projects`, { headers: { Cookie: await sessionCookie(context) } }).then((r) => r.json()) as ProjectList;
  const projectId = projects.projects[0].id;
  const created = await fetch(`${BASE_URL}/api/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: await sessionCookie(context) },
    body: JSON.stringify({ title: 'SSE contract run', taskMode: 'general', projectId }),
  }).then((r) => r.json()) as RunBody;
  const id = created.run.id;
  const sent = await fetch(`${BASE_URL}/api/runs/${id}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: await sessionCookie(context) },
    body: JSON.stringify({ content: 'Say hello and finish.' }),
  });
  expect(sent.status).toBe(202);
  await sent.text();
  return id;
}

test('run event stream delivers named events through to a terminal state', async ({ browser }) => {
  const a = await signup(browser);
  const cookie = await sessionCookie(a.context);
  const id = await createRunAndStart(a.context);

  const events = await collectEvents(cookie, `/api/runs/${id}/events`, ['run.completed', 'run.failed', 'run.cancelled']);
  const named = events.filter((e) => e.length > 0);
  expect(named.length).toBeGreaterThan(0);
  expect(events).toContain('run.completed');
});

test('late reconnect still receives the authoritative terminal event (no forever-RUNNING)', async ({ browser }) => {
  const a = await signup(browser);
  const cookie = await sessionCookie(a.context);
  const id = await createRunAndStart(a.context);

  // Poll the run index until terminal, as a disconnected client would on retry.
  let status = '';
  for (let i = 0; i < 90; i++) {
    const run = await fetch(`${BASE_URL}/api/runs/${id}`, { headers: { Cookie: cookie } }).then((r) => r.json()) as { run: { status: string } };
    status = run.run.status;
    if (['completed', 'failed', 'cancelled'].includes(status)) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  expect(['completed', 'failed', 'cancelled']).toContain(status);

  // Now connect the stream (replay) and require the matching terminal event.
  const events = await collectEvents(cookie, `/api/runs/${id}/events?since=0`, ['run.completed', 'run.failed', 'run.cancelled'], 30_000);
  const terminal = status === 'completed' ? 'run.completed' : status === 'failed' ? 'run.failed' : 'run.cancelled';
  expect(events).toContain(terminal);
});

test('replaying a duplicate sequence does not duplicate user-visible terminal records', async ({ browser }) => {
  const a = await signup(browser);
  const cookie = await sessionCookie(a.context);
  const id = await createRunAndStart(a.context);

  // Read the event list twice; the terminal event appears exactly once even
  // when the client reconnects (dedupe/out-of-order guard in the reducer plus
  // durable replay must not produce duplicate run.completed frames).
  const once = await collectEvents(cookie, `/api/runs/${id}/events?since=0`, ['run.completed', 'run.failed', 'run.cancelled']);
  const twice = await collectEvents(cookie, `/api/runs/${id}/events?since=0`, ['run.completed', 'run.failed', 'run.cancelled']);
  expect(twice.filter((e) => e === 'run.completed').length).toBe(1);
  expect(once.filter((e) => e === 'run.completed').length).toBe(1);
});