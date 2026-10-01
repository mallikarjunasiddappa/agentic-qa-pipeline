/**
 * Real HTTP tests against a real listening Express server (createApp() -> app.listen(0) -> fetch)
 * - not a request-object mock. The only thing faked is the repository layer (in-memory
 * implementations of the exact interfaces workflowRepository.mjs/auditLogRepository.mjs/
 * readModelsRepository.mjs expose), so this suite runs without a database or a generated Prisma
 * Client - which matters here because `prisma generate` can't be run in the build sandbox (see
 * README.md). server.mjs wires the real Prisma-backed repositories into this same createApp() for
 * production; that half is verified by you against a live Postgres, the same way
 * migrate-tenant.mjs's real-DB path was.
 *
 * Run: node --test src/app.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.mjs';
import { GATE_DEFINITIONS } from './lib/workflowGates.mjs';

function createFakeWorkflowRepository(seed = []) {
  const records = new Map(seed.map((r) => [`${r.projectId}:${r.jiraKey}`, r]));
  return {
    async findByProjectAndJiraKey(projectId, jiraKey) {
      return records.get(`${projectId}:${jiraKey}`) ?? null;
    },
    async applyGate(projectId, jiraKey, patch) {
      const key = `${projectId}:${jiraKey}`;
      const existing = records.get(key);
      if (!existing) return null;
      const updated = { ...existing, ...patch };
      records.set(key, updated);
      return updated;
    },
  };
}

function createFakeAuditLogRepository() {
  const entries = [];
  return {
    async create(entry) {
      const stored = { id: `audit-${entries.length + 1}`, timestamp: new Date(), ...entry };
      entries.push(stored);
      return stored;
    },
    async listRecent(organizationId, limit = 50) {
      return entries.filter((e) => e.organizationId === organizationId).slice(0, limit);
    },
    _entries: entries,
  };
}

function createFakeReadModelsRepository(seed = {}) {
  const data = {
    traceability: seed.traceability ?? [],
    healing: seed.healing ?? [],
    flaky: seed.flaky ?? [],
    quarantine: seed.quarantine ?? [],
    cost: seed.cost ?? [],
  };
  const scoped = (rows, projectId, limit) => {
    const filtered = rows.filter((r) => r.projectId === projectId);
    return limit ? filtered.slice(0, limit) : filtered;
  };
  return {
    async listTraceability(projectId, limit) { return scoped(data.traceability, projectId, limit); },
    async listHealing(projectId, limit) { return scoped(data.healing, projectId, limit); },
    async listFlaky(projectId, limit) { return scoped(data.flaky, projectId, limit); },
    async listQuarantine(projectId) { return scoped(data.quarantine, projectId); },
    async listCost(projectId, limit) { return scoped(data.cost, projectId, limit); },
  };
}

function createFakeQueueRepository(seed = []) {
  const items = new Map(seed.map((r) => [r.id, r]));
  let nextId = seed.length + 1;
  return {
    async create(projectId, data) {
      const id = `queue-${nextId++}`;
      const stored = { id, state: 'PENDING', createdAt: new Date(), resolvedAt: null, resolvedByUserId: null, actionTaken: null, ...data, projectId };
      items.set(id, stored);
      return stored;
    },
    async listByProject(projectId, { state, type, limit } = {}) {
      let rows = [...items.values()].filter((r) => r.projectId === projectId);
      if (state) rows = rows.filter((r) => r.state === state);
      if (type) rows = rows.filter((r) => r.type === type);
      return limit ? rows.slice(0, limit) : rows;
    },
    async findById(id) {
      return items.get(id) ?? null;
    },
    async resolve(id, patch) {
      const existing = items.get(id);
      if (!existing) return null;
      const updated = { ...existing, ...patch };
      items.set(id, updated);
      return updated;
    },
    _items: items,
  };
}

/** Fake JiraClient - resolves with a canned key/url by default, or throws when told to (to
 * exercise the resolve route's "Jira call failed, item stays PENDING" path). Records every call
 * so tests can assert what was actually sent to it. */
function createFakeJiraClient({ shouldFail = false } = {}) {
  const calls = [];
  const storyCalls = [];
  return {
    async createBug(bugReport) {
      calls.push(bugReport);
      if (shouldFail) throw new Error('simulated Jira API failure');
      return { key: 'BUG-42', url: 'https://example.atlassian.net/browse/BUG-42' };
    },
    async createStory(storyDraft) {
      storyCalls.push(storyDraft);
      if (shouldFail) throw new Error('simulated Jira API failure');
      return { key: 'STORY-7', url: 'https://example.atlassian.net/browse/STORY-7' };
    },
    _calls: calls,
    _storyCalls: storyCalls,
  };
}

function createRepos(overrides = {}) {
  return {
    workflowRepository: overrides.workflowRepository ?? createFakeWorkflowRepository(),
    auditLogRepository: overrides.auditLogRepository ?? createFakeAuditLogRepository(),
    readModelsRepository: overrides.readModelsRepository ?? createFakeReadModelsRepository(),
    queueRepository: overrides.queueRepository ?? createFakeQueueRepository(),
    jiraClient: overrides.jiraClient,
  };
}

async function withServer(app, fn) {
  const server = app.listen(0);
  const { port } = server.address();
  try {
    await fn(`http://localhost:${port}`);
  } finally {
    server.close();
  }
}

test('GET /health returns ok', async () => {
  const app = createApp(createRepos());
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'ok' });
  });
});

test('GET workflow record returns 404 when not found', async () => {
  const app = createApp(createRepos());
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/organizations/org1/projects/proj1/workflow/SCRUM-1`);
    assert.equal(res.status, 404);
  });
});

test('GET workflow record returns the record when found', async () => {
  const workflowRepository = createFakeWorkflowRepository([
    { id: 'wf1', projectId: 'proj1', jiraKey: 'SCRUM-1' },
  ]);
  const app = createApp(createRepos({ workflowRepository }));
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/organizations/org1/projects/proj1/workflow/SCRUM-1`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.jiraKey, 'SCRUM-1');
  });
});

// Each of the three gates should behave identically - same validation, same 404 handling, same
// "update record + write exactly one correctly-shaped audit entry" contract. Table-driven so
// adding a fourth gate later (there isn't one, but if the schema grows) doesn't mean writing a new
// copy of this whole test block by hand.
for (const [gateKey, gate] of Object.entries(GATE_DEFINITIONS)) {
  test(`POST ${gate.routeSegment} rejects a missing userId with 400`, async () => {
    const workflowRepository = createFakeWorkflowRepository([{ id: 'wf1', projectId: 'proj1', jiraKey: 'SCRUM-1' }]);
    const app = createApp(createRepos({ workflowRepository }));
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/api/organizations/org1/projects/proj1/workflow/SCRUM-1/${gate.routeSegment}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 400);
    });
  });

  test(`POST ${gate.routeSegment} returns 404 for an unknown WorkflowRecord`, async () => {
    const app = createApp(createRepos());
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/api/organizations/org1/projects/proj1/workflow/NOPE-1/${gate.routeSegment}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'user1' }),
      });
      assert.equal(res.status, 404);
    });
  });

  test(`POST ${gate.routeSegment} updates the record and writes a real audit log entry`, async () => {
    const workflowRepository = createFakeWorkflowRepository([{ id: 'wf1', projectId: 'proj1', jiraKey: 'SCRUM-1' }]);
    const auditLogRepository = createFakeAuditLogRepository();
    const app = createApp(createRepos({ workflowRepository, auditLogRepository }));
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/api/organizations/org1/projects/proj1/workflow/SCRUM-1/${gate.routeSegment}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'user1' }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body[gate.clearedByField], 'user1');
      assert.ok(body[gate.clearedAtField]);

      assert.equal(auditLogRepository._entries.length, 1);
      const entry = auditLogRepository._entries[0];
      assert.equal(entry.organizationId, 'org1');
      assert.equal(entry.userId, 'user1');
      assert.equal(entry.action, gate.action);
      assert.equal(entry.entityType, 'WorkflowRecord');
      assert.equal(entry.entityId, 'wf1');
      assert.deepEqual(entry.metadata, { jiraKey: 'SCRUM-1' });
    });
  });
}

test('GET audit-log returns entries scoped to the organization', async () => {
  const auditLogRepository = createFakeAuditLogRepository();
  await auditLogRepository.create({ organizationId: 'org1', userId: 'u1', action: 'requirements_cleared', entityType: 'WorkflowRecord', entityId: 'wf1', metadata: {} });
  await auditLogRepository.create({ organizationId: 'org2', userId: 'u2', action: 'requirements_cleared', entityType: 'WorkflowRecord', entityId: 'wf2', metadata: {} });
  const app = createApp(createRepos({ auditLogRepository }));
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/organizations/org1/audit-log`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.length, 1);
    assert.equal(body[0].organizationId, 'org1');
  });
});

// Read-only endpoints - table-driven across the five resources since they share an identical
// "scoped by projectId, optional ?limit=" contract.
const READ_RESOURCES = [
  ['traceability', 'traceability'],
  ['healing', 'healing'],
  ['flaky', 'flaky'],
  ['quarantine', 'quarantine'],
  ['cost', 'cost'],
];
for (const [segment, seedKey] of READ_RESOURCES) {
  test(`GET /api/projects/:projectId/${segment} returns rows scoped to the project`, async () => {
    const readModelsRepository = createFakeReadModelsRepository({
      [seedKey]: [
        { projectId: 'proj1', marker: 'in-scope' },
        { projectId: 'proj2', marker: 'other-project' },
      ],
    });
    const app = createApp(createRepos({ readModelsRepository }));
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/api/projects/proj1/${segment}`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.length, 1);
      assert.equal(body[0].marker, 'in-scope');
    });
  });

  test(`GET /api/projects/:projectId/${segment} respects ?limit=`, async () => {
    const readModelsRepository = createFakeReadModelsRepository({
      [seedKey]: [
        { projectId: 'proj1', n: 1 },
        { projectId: 'proj1', n: 2 },
        { projectId: 'proj1', n: 3 },
      ],
    });
    const app = createApp(createRepos({ readModelsRepository }));
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/api/projects/proj1/${segment}?limit=2`);
      assert.equal(res.status, 200);
      const body = await res.json();
      // quarantine's repository function ignores limit (current-state table, see
      // readModelsRepository.mjs) - every other resource should respect it.
      if (segment === 'quarantine') {
        assert.equal(body.length, 3);
      } else {
        assert.equal(body.length, 2);
      }
    });
  });
}

// AI Queue (Phase A) - create/list/resolve.

test('POST /api/projects/:projectId/queue rejects an invalid type with 400', async () => {
  const app = createApp(createRepos());
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/projects/proj1/queue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'NOT_A_TYPE', sourceStage: 'test-cases', payload: { foo: 'bar' } }),
    });
    assert.equal(res.status, 400);
  });
});

test('POST /api/projects/:projectId/queue rejects a missing payload with 400', async () => {
  const app = createApp(createRepos());
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/projects/proj1/queue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'SUGGESTED', sourceStage: 'test-cases' }),
    });
    assert.equal(res.status, 400);
  });
});

test('POST /api/projects/:projectId/queue creates a PENDING item scoped to the project', async () => {
  const app = createApp(createRepos());
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/projects/proj1/queue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'SUGGESTED', sourceStage: 'test-cases', payload: { draft: 'scenario text' } }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.projectId, 'proj1');
    assert.equal(body.type, 'SUGGESTED');
    assert.equal(body.sourceStage, 'test-cases');
    assert.equal(body.state, 'PENDING');
    assert.deepEqual(body.payload, { draft: 'scenario text' });
  });
});

test('GET /api/projects/:projectId/queue scopes by project and filters by state/type', async () => {
  const queueRepository = createFakeQueueRepository([
    { id: 'q1', projectId: 'proj1', type: 'SUGGESTED', sourceStage: 'test-cases', payload: {}, state: 'PENDING' },
    { id: 'q2', projectId: 'proj1', type: 'ESCALATED', sourceStage: 'defects', payload: {}, state: 'RESOLVED' },
    { id: 'q3', projectId: 'proj2', type: 'SUGGESTED', sourceStage: 'stories', payload: {}, state: 'PENDING' },
  ]);
  const app = createApp(createRepos({ queueRepository }));
  await withServer(app, async (base) => {
    const all = await (await fetch(`${base}/api/projects/proj1/queue`)).json();
    assert.equal(all.length, 2);

    const pendingOnly = await (await fetch(`${base}/api/projects/proj1/queue?state=PENDING`)).json();
    assert.equal(pendingOnly.length, 1);
    assert.equal(pendingOnly[0].id, 'q1');

    const escalatedOnly = await (await fetch(`${base}/api/projects/proj1/queue?type=ESCALATED`)).json();
    assert.equal(escalatedOnly.length, 1);
    assert.equal(escalatedOnly[0].id, 'q2');
  });
});

test('POST .../queue/:queueItemId/resolve rejects a missing actionTaken with 400', async () => {
  const queueRepository = createFakeQueueRepository([
    { id: 'q1', projectId: 'proj1', type: 'SUGGESTED', sourceStage: 'test-cases', payload: {}, state: 'PENDING' },
  ]);
  const app = createApp(createRepos({ queueRepository }));
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/organizations/org1/projects/proj1/queue/q1/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user1' }),
    });
    assert.equal(res.status, 400);
  });
});

test('POST .../queue/:queueItemId/resolve returns 404 for an unknown QueueItem', async () => {
  const app = createApp(createRepos());
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/organizations/org1/projects/proj1/queue/nope/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user1', actionTaken: 'approved_as_is' }),
    });
    assert.equal(res.status, 404);
  });
});

test('POST .../queue/:queueItemId/resolve resolves the item and writes a real audit log entry', async () => {
  const queueRepository = createFakeQueueRepository([
    { id: 'q1', projectId: 'proj1', type: 'SUGGESTED', sourceStage: 'test-cases', payload: {}, state: 'PENDING' },
  ]);
  const auditLogRepository = createFakeAuditLogRepository();
  const app = createApp(createRepos({ queueRepository, auditLogRepository }));
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/organizations/org1/projects/proj1/queue/q1/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user1', actionTaken: 'approved_as_is' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.state, 'RESOLVED');
    assert.equal(body.resolvedByUserId, 'user1');
    assert.equal(body.actionTaken, 'approved_as_is');
    assert.ok(body.resolvedAt);

    assert.equal(auditLogRepository._entries.length, 1);
    const entry = auditLogRepository._entries[0];
    assert.equal(entry.organizationId, 'org1');
    assert.equal(entry.userId, 'user1');
    assert.equal(entry.action, 'queue_item_resolved');
    assert.equal(entry.entityType, 'QueueItem');
    assert.equal(entry.entityId, 'q1');
    assert.deepEqual(entry.metadata, { sourceStage: 'test-cases', actionTaken: 'approved_as_is' });
  });
});

test('POST .../queue/:queueItemId/resolve accepts an explicit DISMISSED state', async () => {
  const queueRepository = createFakeQueueRepository([
    { id: 'q1', projectId: 'proj1', type: 'ESCALATED', sourceStage: 'defects', payload: {}, state: 'PENDING' },
  ]);
  const app = createApp(createRepos({ queueRepository }));
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/organizations/org1/projects/proj1/queue/q1/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user1', actionTaken: 'dismissed_no_action', state: 'DISMISSED' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.state, 'DISMISSED');
  });
});

// AI Queue resolve + real Jira bug filing (fileJiraBug: true).

test('POST .../resolve with fileJiraBug:true returns 503 when no jiraClient is configured', async () => {
  const queueRepository = createFakeQueueRepository([
    {
      id: 'q1', projectId: 'proj1', type: 'ESCALATED', sourceStage: 'defects', state: 'PENDING',
      payload: { draftBugReport: { summary: 's', description: 'd', labels: [] } },
    },
  ]);
  const app = createApp(createRepos({ queueRepository })); // no jiraClient override -> undefined
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/organizations/org1/projects/proj1/queue/q1/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user1', actionTaken: 'approved_as_is', fileJiraBug: true }),
    });
    assert.equal(res.status, 503);
    // Item must remain untouched - a 503 must not silently resolve it.
    assert.equal((await queueRepository.findById('q1')).state, 'PENDING');
  });
});

test('POST .../resolve with fileJiraBug:true rejects a non-defects item with 400', async () => {
  const queueRepository = createFakeQueueRepository([
    { id: 'q1', projectId: 'proj1', type: 'NEEDS_SESSION', sourceStage: 'test-cases', state: 'PENDING', payload: { jiraKey: 'A-1' } },
  ]);
  const jiraClient = createFakeJiraClient();
  const app = createApp(createRepos({ queueRepository, jiraClient }));
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/organizations/org1/projects/proj1/queue/q1/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user1', actionTaken: 'approved_as_is', fileJiraBug: true }),
    });
    assert.equal(res.status, 400);
    assert.equal(jiraClient._calls.length, 0);
  });
});

test('POST .../resolve with fileJiraBug:true returns 404 for an unknown QueueItem', async () => {
  const jiraClient = createFakeJiraClient();
  const app = createApp(createRepos({ jiraClient }));
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/organizations/org1/projects/proj1/queue/nope/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user1', actionTaken: 'approved_as_is', fileJiraBug: true }),
    });
    assert.equal(res.status, 404);
  });
});

test('POST .../resolve with fileJiraBug:true files the real bug, merges it into payload, and audits the Jira key', async () => {
  const queueRepository = createFakeQueueRepository([
    {
      id: 'q1', projectId: 'proj1', type: 'ESCALATED', sourceStage: 'defects', state: 'PENDING',
      payload: { healingEventId: 'h1', draftBugReport: { summary: 'Healer escalation', description: 'details', labels: ['healer-escalation'] } },
    },
  ]);
  const jiraClient = createFakeJiraClient();
  const auditLogRepository = createFakeAuditLogRepository();
  const app = createApp(createRepos({ queueRepository, jiraClient, auditLogRepository }));
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/organizations/org1/projects/proj1/queue/q1/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user1', actionTaken: 'approved_as_is', fileJiraBug: true }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.state, 'RESOLVED');
    assert.equal(body.payload.filedBug.key, 'BUG-42');
    assert.equal(body.payload.filedBug.url, 'https://example.atlassian.net/browse/BUG-42');
    // Original draft is preserved, not overwritten.
    assert.equal(body.payload.draftBugReport.summary, 'Healer escalation');

    assert.equal(jiraClient._calls.length, 1);
    assert.equal(jiraClient._calls[0].summary, 'Healer escalation');

    const entry = auditLogRepository._entries[0];
    assert.equal(entry.metadata.jiraIssueKey, 'BUG-42');
    assert.equal(entry.metadata.jiraIssueUrl, 'https://example.atlassian.net/browse/BUG-42');
  });
});

test('POST .../resolve with fileJiraBug:true accepts a human-edited bugReport override', async () => {
  const queueRepository = createFakeQueueRepository([
    {
      id: 'q1', projectId: 'proj1', type: 'ESCALATED', sourceStage: 'defects', state: 'PENDING',
      payload: { draftBugReport: { summary: 'original draft', description: 'd', labels: [] } },
    },
  ]);
  const jiraClient = createFakeJiraClient();
  const app = createApp(createRepos({ queueRepository, jiraClient }));
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/organizations/org1/projects/proj1/queue/q1/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: 'user1', actionTaken: 'edited_and_approved', fileJiraBug: true,
        bugReport: { summary: 'human-edited summary', description: 'human-edited description', labels: ['p1'] },
      }),
    });
    assert.equal(res.status, 200);
    assert.equal(jiraClient._calls[0].summary, 'human-edited summary');
    assert.equal(jiraClient._calls[0].labels[0], 'p1');
  });
});

test('POST .../resolve with fileJiraBug:true returns 502 and leaves the item PENDING when Jira fails', async () => {
  const queueRepository = createFakeQueueRepository([
    {
      id: 'q1', projectId: 'proj1', type: 'ESCALATED', sourceStage: 'defects', state: 'PENDING',
      payload: { draftBugReport: { summary: 's', description: 'd', labels: [] } },
    },
  ]);
  const jiraClient = createFakeJiraClient({ shouldFail: true });
  const app = createApp(createRepos({ queueRepository, jiraClient }));
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/organizations/org1/projects/proj1/queue/q1/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user1', actionTaken: 'approved_as_is', fileJiraBug: true }),
    });
    assert.equal(res.status, 502);
    const stored = await queueRepository.findById('q1');
    assert.equal(stored.state, 'PENDING');
    assert.equal(stored.resolvedAt, undefined);
  });
});

// AI Queue resolve + real Jira story filing (fileJiraStory: true) - Phase D.

test('POST .../resolve with fileJiraStory:true returns 503 when no jiraClient is configured', async () => {
  const queueRepository = createFakeQueueRepository([
    {
      id: 'q1', projectId: 'proj1', type: 'SUGGESTED', sourceStage: 'stories', state: 'PENDING',
      payload: { epicKey: 'EPIC-1', title: 't', description: 'd', acceptanceCriteria: ['a'] },
    },
  ]);
  const app = createApp(createRepos({ queueRepository })); // no jiraClient override -> undefined
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/organizations/org1/projects/proj1/queue/q1/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user1', actionTaken: 'approved_as_is', fileJiraStory: true }),
    });
    assert.equal(res.status, 503);
    assert.equal((await queueRepository.findById('q1')).state, 'PENDING');
  });
});

test('POST .../resolve with fileJiraStory:true rejects a non-stories item with 400', async () => {
  const queueRepository = createFakeQueueRepository([
    { id: 'q1', projectId: 'proj1', type: 'NEEDS_SESSION', sourceStage: 'test-cases', state: 'PENDING', payload: { jiraKey: 'A-1' } },
  ]);
  const jiraClient = createFakeJiraClient();
  const app = createApp(createRepos({ queueRepository, jiraClient }));
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/organizations/org1/projects/proj1/queue/q1/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user1', actionTaken: 'approved_as_is', fileJiraStory: true }),
    });
    assert.equal(res.status, 400);
    assert.equal(jiraClient._storyCalls.length, 0);
  });
});

test('POST .../resolve with fileJiraStory:true returns 404 for an unknown QueueItem', async () => {
  const jiraClient = createFakeJiraClient();
  const app = createApp(createRepos({ jiraClient }));
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/organizations/org1/projects/proj1/queue/nope/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user1', actionTaken: 'approved_as_is', fileJiraStory: true }),
    });
    assert.equal(res.status, 404);
  });
});

test('POST .../resolve with fileJiraStory:true files the real story, merges it into payload, and audits the Jira key', async () => {
  const queueRepository = createFakeQueueRepository([
    {
      id: 'q1', projectId: 'proj1', type: 'SUGGESTED', sourceStage: 'stories', state: 'PENDING',
      payload: { epicKey: 'EPIC-1', title: 'Allow guest checkout', description: 'd', acceptanceCriteria: ['a', 'b'] },
    },
  ]);
  const jiraClient = createFakeJiraClient();
  const auditLogRepository = createFakeAuditLogRepository();
  const app = createApp(createRepos({ queueRepository, jiraClient, auditLogRepository }));
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/organizations/org1/projects/proj1/queue/q1/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user1', actionTaken: 'approved_as_is', fileJiraStory: true }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.state, 'RESOLVED');
    assert.equal(body.payload.filedStory.key, 'STORY-7');
    assert.equal(body.payload.filedStory.url, 'https://example.atlassian.net/browse/STORY-7');
    // Original draft is preserved, not overwritten.
    assert.equal(body.payload.title, 'Allow guest checkout');

    assert.equal(jiraClient._storyCalls.length, 1);
    assert.equal(jiraClient._storyCalls[0].title, 'Allow guest checkout');

    const entry = auditLogRepository._entries[0];
    assert.equal(entry.metadata.jiraIssueKey, 'STORY-7');
    assert.equal(entry.metadata.jiraIssueUrl, 'https://example.atlassian.net/browse/STORY-7');
  });
});

test('POST .../resolve with fileJiraStory:true accepts a human-edited storyDraft override', async () => {
  const queueRepository = createFakeQueueRepository([
    {
      id: 'q1', projectId: 'proj1', type: 'SUGGESTED', sourceStage: 'stories', state: 'PENDING',
      payload: { epicKey: 'EPIC-1', title: 'original draft title', description: 'd', acceptanceCriteria: [] },
    },
  ]);
  const jiraClient = createFakeJiraClient();
  const app = createApp(createRepos({ queueRepository, jiraClient }));
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/organizations/org1/projects/proj1/queue/q1/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: 'user1', actionTaken: 'edited_and_approved', fileJiraStory: true,
        storyDraft: { title: 'human-edited title', description: 'human-edited description', acceptanceCriteria: ['c'] },
      }),
    });
    assert.equal(res.status, 200);
    assert.equal(jiraClient._storyCalls[0].title, 'human-edited title');
  });
});

test('POST .../resolve with fileJiraStory:true returns 502 and leaves the item PENDING when Jira fails', async () => {
  const queueRepository = createFakeQueueRepository([
    {
      id: 'q1', projectId: 'proj1', type: 'SUGGESTED', sourceStage: 'stories', state: 'PENDING',
      payload: { epicKey: 'EPIC-1', title: 't', description: 'd', acceptanceCriteria: [] },
    },
  ]);
  const jiraClient = createFakeJiraClient({ shouldFail: true });
  const app = createApp(createRepos({ queueRepository, jiraClient }));
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/organizations/org1/projects/proj1/queue/q1/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user1', actionTaken: 'approved_as_is', fileJiraStory: true }),
    });
    assert.equal(res.status, 502);
    const stored = await queueRepository.findById('q1');
    assert.equal(stored.state, 'PENDING');
    assert.equal(stored.resolvedAt, undefined);
  });
});

// AI Queue dashboard (GET .../queue/dashboard).

test('GET .../queue/dashboard requires an organizationId query param', async () => {
  const app = createApp(createRepos());
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/projects/proj1/queue/dashboard`);
    assert.equal(res.status, 400);
  });
});

test('GET .../queue/dashboard renders only PENDING items scoped to the project, as real HTML', async () => {
  const queueRepository = createFakeQueueRepository([
    { id: 'q1', projectId: 'proj1', type: 'NEEDS_SESSION', sourceStage: 'test-cases', state: 'PENDING', payload: { jiraKey: 'A-1' } },
    { id: 'q2', projectId: 'proj1', type: 'ESCALATED', sourceStage: 'defects', state: 'RESOLVED', payload: {} },
    { id: 'q3', projectId: 'proj2', type: 'NEEDS_SESSION', sourceStage: 'test-cases', state: 'PENDING', payload: { jiraKey: 'B-1' } },
  ]);
  const app = createApp(createRepos({ queueRepository }));
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/api/projects/proj1/queue/dashboard?organizationId=org1`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    const html = await res.text();
    assert.match(html, /data-item-id="q1"/);
    assert.doesNotMatch(html, /data-item-id="q2"/); // RESOLVED, not shown
    assert.doesNotMatch(html, /data-item-id="q3"/); // different project, not shown
    assert.match(html, /const ORGANIZATION_ID = "org1"/);
  });
});
