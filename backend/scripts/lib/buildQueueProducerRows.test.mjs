/**
 * Unit tests for the pure row-shaping logic in buildQueueProducerRows.mjs - no database, same
 * node:test convention as backend/src/app.test.mjs. End-to-end behavior against a real Postgres
 * (constraints, idempotency across two real runs) is covered separately by
 * verify-enqueue-from-pipeline-output.mjs.
 *
 * Run: node --test scripts/lib/buildQueueProducerRows.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  selectNewTestCaseReviews,
  buildTestCaseQueueItemRow,
  selectNewEscalatedDefects,
  buildDefectQueueItemRow,
} from './buildQueueProducerRows.mjs';

test('selectNewTestCaseReviews picks only Gate 1 cleared / Gate 2 pending records', () => {
  const workflowRecords = [
    { id: 'wf-pending', jiraKey: 'A-1', scenariosApprovedAt: new Date(), testCasesApprovedAt: null },
    { id: 'wf-done', jiraKey: 'A-2', scenariosApprovedAt: new Date(), testCasesApprovedAt: new Date() },
    { id: 'wf-early', jiraKey: 'A-3', scenariosApprovedAt: null, testCasesApprovedAt: null },
  ];
  const selected = selectNewTestCaseReviews(workflowRecords, []);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].id, 'wf-pending');
});

test('selectNewTestCaseReviews excludes a record already queued', () => {
  const workflowRecords = [
    { id: 'wf-pending', jiraKey: 'A-1', scenariosApprovedAt: new Date(), testCasesApprovedAt: null },
  ];
  const existingQueueItems = [
    { sourceStage: 'test-cases', payload: { workflowRecordId: 'wf-pending' } },
  ];
  const selected = selectNewTestCaseReviews(workflowRecords, existingQueueItems);
  assert.equal(selected.length, 0);
});

test('buildTestCaseQueueItemRow builds a NEEDS_SESSION item pointing at the WorkflowRecord', () => {
  const row = buildTestCaseQueueItemRow('proj1', {
    id: 'wf-pending',
    jiraKey: 'A-1',
    scenariosApprovedAt: '2026-08-20T00:00:00.000Z',
  });
  assert.equal(row.projectId, 'proj1');
  assert.equal(row.type, 'NEEDS_SESSION');
  assert.equal(row.sourceStage, 'test-cases');
  assert.equal(row.payload.workflowRecordId, 'wf-pending');
  assert.equal(row.payload.jiraKey, 'A-1');
});

test('selectNewEscalatedDefects picks only escalated HealingEvents', () => {
  const healingEvents = [
    { id: 'h-escalated', outcome: 'escalated', testFilePath: 'a.spec.ts', suite: 's', attemptNumber: 2, category: 'locator_drift' },
    { id: 'h-healed', outcome: 'healed', testFilePath: 'a.spec.ts', suite: 's', attemptNumber: 1 },
    { id: 'h-passed', outcome: 'passed_no_heal_needed', testFilePath: 'a.spec.ts', suite: 's', attemptNumber: 1 },
  ];
  const selected = selectNewEscalatedDefects(healingEvents, []);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].id, 'h-escalated');
});

test('selectNewEscalatedDefects excludes an event already queued', () => {
  const healingEvents = [
    { id: 'h-escalated', outcome: 'escalated', testFilePath: 'a.spec.ts', suite: 's', attemptNumber: 2 },
  ];
  const existingQueueItems = [
    { sourceStage: 'defects', payload: { healingEventId: 'h-escalated' } },
  ];
  const selected = selectNewEscalatedDefects(healingEvents, existingQueueItems);
  assert.equal(selected.length, 0);
});

test('buildDefectQueueItemRow builds an ESCALATED item with a BugReport-shaped draft', () => {
  const row = buildDefectQueueItemRow('proj1', {
    id: 'h-escalated',
    jiraKey: 'A-1',
    externalCaseId: 'TC-9',
    testFilePath: 'tests/checkout/checkout.spec.ts',
    testTitle: 'completes checkout',
    suite: 'checkout',
    attemptNumber: 3,
    category: 'ui_restructure',
    timestamp: '2026-08-20T00:00:00.000Z',
  });
  assert.equal(row.projectId, 'proj1');
  assert.equal(row.type, 'ESCALATED');
  assert.equal(row.sourceStage, 'defects');
  assert.equal(row.payload.healingEventId, 'h-escalated');
  assert.equal(row.payload.jiraKey, 'A-1');
  const bug = row.payload.draftBugReport;
  assert.equal(typeof bug.summary, 'string');
  assert.ok(bug.summary.includes('checkout.spec.ts'));
  assert.equal(typeof bug.description, 'string');
  assert.deepEqual(bug.labels, ['healer-escalation', 'ui_restructure']);
});

test('buildDefectQueueItemRow omits a null category from labels without erroring', () => {
  const row = buildDefectQueueItemRow('proj1', {
    id: 'h-escalated',
    testFilePath: 'a.spec.ts',
    suite: 's',
    attemptNumber: 1,
    category: null,
    timestamp: '2026-08-20T00:00:00.000Z',
  });
  assert.deepEqual(row.payload.draftBugReport.labels, ['healer-escalation']);
});
