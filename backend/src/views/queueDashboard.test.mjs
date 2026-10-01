/**
 * Unit tests for buildQueueDashboardHtml() - pure function, no server/database needed. IO-level
 * coverage (the actual route serving this HTML) lives in src/app.test.mjs.
 *
 * Run: node --test src/views/queueDashboard.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildQueueDashboardHtml } from './queueDashboard.mjs';

test('renders an empty state when there are no pending items', () => {
  const html = buildQueueDashboardHtml([], { projectId: 'proj1', organizationId: 'org1' });
  assert.match(html, /Nothing pending review right now/);
});

test('embeds projectId/organizationId for the client-side fetch calls', () => {
  const html = buildQueueDashboardHtml([], { projectId: 'proj1', organizationId: 'org1' });
  assert.match(html, /const PROJECT_ID = "proj1"/);
  assert.match(html, /const ORGANIZATION_ID = "org1"/);
});

test('renders a test-case item with its jiraKey-derived summary', () => {
  const items = [
    {
      id: 'q1',
      type: 'NEEDS_SESSION',
      sourceStage: 'test-cases',
      state: 'PENDING',
      createdAt: '2026-08-25T00:00:00.000Z',
      payload: { jiraKey: 'SCRUM-9', note: 'Gate 1 cleared; test cases ready for Gate 2 review.' },
    },
  ];
  const html = buildQueueDashboardHtml(items, { projectId: 'proj1', organizationId: 'org1' });
  assert.match(html, /data-item-id="q1"/);
  assert.match(html, /NEEDS_SESSION/);
  assert.match(html, /Gate 1 cleared; test cases ready for Gate 2 review\./);
  // No "File Jira Bug" button for a non-defects item.
  assert.doesNotMatch(html, /File Jira Bug/);
});

test('renders a defects item with its draftBugReport summary and a File Jira Bug button', () => {
  const items = [
    {
      id: 'q2',
      type: 'ESCALATED',
      sourceStage: 'defects',
      state: 'PENDING',
      createdAt: '2026-08-25T00:00:00.000Z',
      payload: {
        healingEventId: 'h1',
        draftBugReport: { summary: 'Healer escalation: checkout.spec.ts failed', description: 'details', labels: ['healer-escalation'] },
      },
    },
  ];
  const html = buildQueueDashboardHtml(items, { projectId: 'proj1', organizationId: 'org1' });
  assert.match(html, /Healer escalation: checkout\.spec\.ts failed/);
  assert.match(html, /File Jira Bug/);
  assert.match(html, /resolveItem\('q2', 'approved_as_is', 'RESOLVED', true, false\)/);
  // No "File Jira Story" button for a defects item.
  assert.doesNotMatch(html, /File Jira Story/);
});

test('renders a stories item with its title as the summary and a File Jira Story button', () => {
  const items = [
    {
      id: 'q4',
      type: 'SUGGESTED',
      sourceStage: 'stories',
      state: 'PENDING',
      createdAt: '2026-08-25T00:00:00.000Z',
      payload: {
        epicKey: 'EPIC-1',
        title: 'Allow guest checkout',
        description: 'As a shopper, I want to check out without an account.',
        acceptanceCriteria: ['Guest can complete checkout without registering'],
      },
    },
  ];
  const html = buildQueueDashboardHtml(items, { projectId: 'proj1', organizationId: 'org1' });
  assert.match(html, /Allow guest checkout/);
  assert.match(html, /File Jira Story/);
  assert.match(html, /resolveItem\('q4', 'approved_as_is', 'RESOLVED', false, true\)/);
  // No "File Jira Bug" button for a stories item.
  assert.doesNotMatch(html, /File Jira Bug/);
});

test('escapes payload content that could otherwise break the page', () => {
  const items = [
    {
      id: 'q3',
      type: 'SUGGESTED',
      sourceStage: 'sprint-plan',
      state: 'PENDING',
      createdAt: '2026-08-25T00:00:00.000Z',
      payload: { note: '<script>alert(1)</script>' },
    },
  ];
  const html = buildQueueDashboardHtml(items, { projectId: 'proj1', organizationId: 'org1' });
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});
