import assert from 'node:assert/strict';
import { test } from 'node:test';
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

test('buildSprintStatusReport returns an empty sprints array when there are no active sprints (not an error)', () => {
  const report = buildSprintStatusReport(['35'], [], 'customfield_10016', new Date('2026-08-15T00:00:00.000Z'));
  assert.equal(report.generatedAt, '2026-08-15T00:00:00.000Z');
  assert.deepEqual(report.boardIds, ['35']);
  assert.equal(report.storyPointsField, 'customfield_10016');
  assert.deepEqual(report.sprints, []);
});

test('buildSprintStatusReport echoes storyPointsField as null when scrum.json has none configured', () => {
  const report = buildSprintStatusReport([], [], null);
  assert.equal(report.storyPointsField, null);
});

test('buildSprintStatusReport creates one section per (board, sprint) pair, not just the first', () => {
  // The flagged design decision: a board with more than one currently-active sprint (e.g. an
  // overlapping maintenance sprint) gets every sprint as its own section, not just the first one.
  const report = buildSprintStatusReport(
    ['35'],
    [
      boardSprint({ sprint: sprint({ id: 1, name: 'Feature Sprint' }) }),
      boardSprint({ sprint: sprint({ id: 2, name: 'Maintenance Sprint' }) }),
    ],
    'customfield_10016',
  );
  assert.equal(report.sprints.length, 2);
  assert.deepEqual(
    report.sprints.map((s) => s.sprint.name),
    ['Feature Sprint', 'Maintenance Sprint'],
  );
});

test('buildSprintStatusReport aggregates issue counts and story points by status category', () => {
  const report = buildSprintStatusReport(
    ['35'],
    [
      boardSprint({
        issues: [
          issue({ key: 'PROJ-1', statusCategory: 'new', storyPoints: 2 }),
          issue({ key: 'PROJ-2', statusCategory: 'indeterminate', storyPoints: 5 }),
          issue({ key: 'PROJ-3', statusCategory: 'indeterminate', storyPoints: 1 }),
          issue({ key: 'PROJ-4', statusCategory: 'done', storyPoints: 3 }),
        ],
      }),
    ],
    'customfield_10016',
  );
  const section = report.sprints[0];
  assert.equal(section.byStatusCategory.new.issueCount, 1);
  assert.equal(section.byStatusCategory.new.storyPoints, 2);
  assert.equal(section.byStatusCategory.indeterminate.issueCount, 2);
  assert.equal(section.byStatusCategory.indeterminate.storyPoints, 6);
  assert.equal(section.byStatusCategory.done.issueCount, 1);
  assert.equal(section.byStatusCategory.done.storyPoints, 3);
  assert.equal(section.byStatusCategory.unknown.issueCount, 0);
  assert.equal(section.byStatusCategory.unknown.storyPoints, 0);
  assert.equal(section.totalStoryPoints, 11);
  assert.equal(section.unestimatedIssueCount, 0);
});

test('buildSprintStatusReport excludes null storyPoints from sums and counts them as unestimated, not zero', () => {
  const report = buildSprintStatusReport(
    ['35'],
    [
      boardSprint({
        issues: [
          issue({ key: 'PROJ-1', storyPoints: 5 }),
          issue({ key: 'PROJ-2', storyPoints: null }),
          issue({ key: 'PROJ-3', storyPoints: 0 }),
        ],
      }),
    ],
    'customfield_10016',
  );
  const section = report.sprints[0];
  assert.equal(section.totalStoryPoints, 5); // the genuine 0 counts toward the sum, null does not
  assert.equal(section.unestimatedIssueCount, 1);
});

test('buildSprintStatusReport groups by assignee, sorted alphabetically with unassigned last', () => {
  const report = buildSprintStatusReport(
    ['35'],
    [
      boardSprint({
        issues: [
          issue({ key: 'PROJ-1', assignee: 'Zack', storyPoints: 2 }),
          issue({ key: 'PROJ-2', assignee: null, storyPoints: 1 }),
          issue({ key: 'PROJ-3', assignee: 'Amy', storyPoints: 3 }),
          issue({ key: 'PROJ-4', assignee: 'Amy', storyPoints: 2 }),
        ],
      }),
    ],
    'customfield_10016',
  );
  const names = report.sprints[0].byAssignee.map((a) => a.assignee);
  assert.deepEqual(names, ['Amy', 'Zack', null]);
  const amy = report.sprints[0].byAssignee.find((a) => a.assignee === 'Amy');
  assert.equal(amy?.issueCount, 2);
  assert.equal(amy?.storyPoints, 5);
  const unassigned = report.sprints[0].byAssignee.find((a) => a.assignee === null);
  assert.equal(unassigned?.issueCount, 1);
});

test('buildSprintStatusReport per-assignee byStatusCategory mirrors the sprint-wide breakdown for that assignee only', () => {
  const report = buildSprintStatusReport(
    ['35'],
    [
      boardSprint({
        issues: [
          issue({ key: 'PROJ-1', assignee: 'Amy', statusCategory: 'new' }),
          issue({ key: 'PROJ-2', assignee: 'Amy', statusCategory: 'done' }),
          issue({ key: 'PROJ-3', assignee: 'Zack', statusCategory: 'done' }),
        ],
      }),
    ],
    'customfield_10016',
  );
  const amy = report.sprints[0].byAssignee.find((a) => a.assignee === 'Amy');
  assert.equal(amy?.byStatusCategory.new, 1);
  assert.equal(amy?.byStatusCategory.done, 1);
  assert.equal(amy?.byStatusCategory.indeterminate, 0);
  const zack = report.sprints[0].byAssignee.find((a) => a.assignee === 'Zack');
  assert.equal(zack?.byStatusCategory.done, 1);
  assert.equal(zack?.byStatusCategory.new, 0);
});

test('buildSprintStatusReport keeps sprints from different boards as separate sections with their own boardId', () => {
  const report = buildSprintStatusReport(
    ['35', '40'],
    [
      boardSprint({ boardId: '35', sprint: sprint({ id: 1, name: 'Board 35 Sprint' }) }),
      boardSprint({ boardId: '40', sprint: sprint({ id: 2, name: 'Board 40 Sprint' }) }),
    ],
    'customfield_10016',
  );
  assert.deepEqual(
    report.sprints.map((s) => [s.boardId, s.sprint.name]),
    [
      ['35', 'Board 35 Sprint'],
      ['40', 'Board 40 Sprint'],
    ],
  );
});
