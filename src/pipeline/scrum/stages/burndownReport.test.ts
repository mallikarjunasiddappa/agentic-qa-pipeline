import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildBurndownSprintReport } from './burndownReport';
import { buildSprintStatusReport, SprintStatusBoardSprint } from './sprintStatus';
import { SprintInfo, SprintIssueSnapshot } from '../agileClient';

function sprint(overrides: Partial<SprintInfo> = {}): SprintInfo {
  return {
    id: 100,
    name: 'Sprint 12',
    state: 'active',
    startDate: '2026-08-01T00:00:00.000Z',
    endDate: '2026-08-14T00:00:00.000Z',
    ...overrides,
  };
}

function issue(overrides: Partial<SprintIssueSnapshot> = {}): SprintIssueSnapshot {
  return {
    key: 'PROJ-1',
    summary: 'Do the thing',
    status: 'In Progress',
    statusCategory: 'indeterminate',
    assignee: 'Jane Doe',
    assigneeEmail: 'jane@example.com',
    storyPoints: 3,
    updated: '2026-08-10T00:00:00.000Z',
    ...overrides,
  };
}

function boardSprint(overrides: Partial<SprintStatusBoardSprint> = {}): SprintStatusBoardSprint {
  return {
    boardId: '35',
    sprint: sprint(),
    issues: [],
    ...overrides,
  };
}

const NOW = new Date('2026-08-20T00:00:00.000Z');

// Builds the SprintStatusSprintSection buildBurndownSprintReport() takes as input, the same way
// pipeline.ts's stageBurndownReport() will (via buildSprintStatusReport()) - not a hand-rolled
// fixture, so these tests exercise the real reuse path, not a parallel assumption about its shape.
function section(issues: SprintIssueSnapshot[], storyPointsField: string | null = 'customfield_10016') {
  const report = buildSprintStatusReport(['35'], [boardSprint({ issues })], storyPointsField, NOW);
  return report.sprints[0];
}

test('buildBurndownSprintReport splits total story points into completed vs remaining', () => {
  const report = buildBurndownSprintReport(
    section([
      issue({ key: 'PROJ-1', statusCategory: 'done', storyPoints: 5 }),
      issue({ key: 'PROJ-2', statusCategory: 'indeterminate', storyPoints: 3 }),
      issue({ key: 'PROJ-3', statusCategory: 'new', storyPoints: 2 }),
    ]),
    'customfield_10016',
    NOW,
  );
  assert.equal(report.totalStoryPoints, 10);
  assert.equal(report.completedStoryPoints, 5);
  assert.equal(report.remainingStoryPoints, 5);
  assert.equal(report.totalIssueCount, 3);
  assert.equal(report.completedIssueCount, 1);
  assert.equal(report.remainingIssueCount, 2);
});

test('buildBurndownSprintReport computes percentComplete from completed/total story points', () => {
  const report = buildBurndownSprintReport(
    section([
      issue({ key: 'PROJ-1', statusCategory: 'done', storyPoints: 3 }),
      issue({ key: 'PROJ-2', statusCategory: 'new', storyPoints: 1 }),
    ]),
    'customfield_10016',
    NOW,
  );
  assert.equal(report.percentComplete, 0.75);
});

test('buildBurndownSprintReport returns percentComplete null (not 0) when storyPointsField is unconfigured', () => {
  const report = buildBurndownSprintReport(
    section([issue({ key: 'PROJ-1', statusCategory: 'done', storyPoints: null })], null),
    null,
    NOW,
  );
  assert.equal(report.percentComplete, null);
  assert.equal(report.totalStoryPoints, 0);
});

test('buildBurndownSprintReport returns percentComplete null (not 0 or NaN) when total story points is 0 even with a configured field', () => {
  const report = buildBurndownSprintReport(
    section([issue({ key: 'PROJ-1', statusCategory: 'new', storyPoints: null })]),
    'customfield_10016',
    NOW,
  );
  assert.equal(report.percentComplete, null);
});

test('buildBurndownSprintReport counts unestimated issues separately, not as 0 points', () => {
  const report = buildBurndownSprintReport(
    section([
      issue({ key: 'PROJ-1', statusCategory: 'done', storyPoints: 2 }),
      issue({ key: 'PROJ-2', statusCategory: 'new', storyPoints: null }),
    ]),
    'customfield_10016',
    NOW,
  );
  assert.equal(report.unestimatedIssueCount, 1);
  assert.equal(report.totalStoryPoints, 2);
});

test('buildBurndownSprintReport echoes byStatusCategory straight from the sprint-status section', () => {
  const report = buildBurndownSprintReport(
    section([issue({ key: 'PROJ-1', statusCategory: 'indeterminate', storyPoints: 4 })]),
    'customfield_10016',
    NOW,
  );
  assert.equal(report.byStatusCategory.indeterminate.issueCount, 1);
  assert.equal(report.byStatusCategory.indeterminate.storyPoints, 4);
  assert.equal(report.byStatusCategory.done.issueCount, 0);
});

test('buildBurndownSprintReport echoes boardId, sprint, storyPointsField, and stamps generatedAt', () => {
  const report = buildBurndownSprintReport(
    section([issue()], 'customfield_10016'),
    'customfield_10016',
    NOW,
  );
  assert.equal(report.boardId, '35');
  assert.equal(report.sprint.id, 100);
  assert.equal(report.sprint.name, 'Sprint 12');
  assert.equal(report.storyPointsField, 'customfield_10016');
  assert.equal(report.generatedAt, NOW.toISOString());
});

test('buildBurndownSprintReport handles a sprint with zero issues without dividing by zero', () => {
  const report = buildBurndownSprintReport(section([]), 'customfield_10016', NOW);
  assert.equal(report.totalIssueCount, 0);
  assert.equal(report.totalStoryPoints, 0);
  assert.equal(report.percentComplete, null);
});
