import { test, expect } from '@playwright/test';
import { signup, apiRequest } from './util';

// Tenant isolation E2E. Creates two tenants (A and B), places A's data, and
// proves B cannot read A's run/project/list data. Cross-tenant leakage is a
// release blocker (P0/P1).

interface RunBody { run: { id: string } }
interface ProjectList { projects: { id: string }[] }
interface RunList { runs: { id: string }[] }

test('tenant B cannot read tenant A run, project, or list data', async ({ browser }) => {
  const a = await signup(browser, 'Tenant A');
  const b = await signup(browser, 'Tenant B');

  // Tenant A: default project + a private run.
  const aProjects = await apiRequest<ProjectList>(a.context, 'GET', '/api/projects');
  expect(aProjects.status).toBe(200);
  const projectId = aProjects.json?.projects[0].id;
  expect(projectId).toBeTruthy();

  const created = await apiRequest<RunBody>(a.context, 'POST', '/api/runs', {
    title: 'A private run',
    taskMode: 'general',
    projectId,
  });
  expect(created.status).toBe(201);
  const runId = created.json?.run.id;
  expect(runId).toBeTruthy();

  // Tenant B: direct access to A's run is denied (403, no run data returned).
  const runAccess = await apiRequest<{ run?: unknown }>(b.context, 'GET', `/api/runs/${runId}`);
  expect(runAccess.status).toBe(403);
  expect(runAccess.json?.run).toBeUndefined();

  // Tenant B: direct access to A's project is concealed (404).
  const projectAccess = await apiRequest(b.context, 'GET', `/api/projects/${projectId}`);
  expect(projectAccess.status).toBe(404);

  // Tenant B's list endpoints never contain A's data.
  const bRuns = await apiRequest<RunList>(b.context, 'GET', '/api/runs');
  expect(bRuns.status).toBe(200);
  expect((bRuns.json?.runs ?? []).map((r) => r.id)).not.toContain(runId);

  const bProjects = await apiRequest<ProjectList>(b.context, 'GET', '/api/projects');
  expect(bProjects.status).toBe(200);
  expect((bProjects.json?.projects ?? []).map((p) => p.id)).not.toContain(projectId);
});

test('tenant A sees its own data (control — no false negative)', async ({ browser }) => {
  const a = await signup(browser, 'Tenant A Control');
  const aProjects = await apiRequest<ProjectList>(a.context, 'GET', '/api/projects');
  const projectId = aProjects.json?.projects[0].id;
  const created = await apiRequest<RunBody>(a.context, 'POST', '/api/runs', {
    title: 'A own run',
    taskMode: 'general',
    projectId,
  });
  const runId = created.json?.run.id;

  const own = await apiRequest<{ run: { id: string } }>(a.context, 'GET', `/api/runs/${runId}`);
  expect(own.status).toBe(200);
  expect(own.json?.run.id).toBe(runId);
});