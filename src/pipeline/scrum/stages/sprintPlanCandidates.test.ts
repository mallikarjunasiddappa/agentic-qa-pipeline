import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectSprintPlanCandidates } from './sprintPlanCandidates';
import { SprintIssueSnapshot } from '../agileClient';

function issue(overrides: Partial<SprintIssueSnapshot>): SprintIssueSnapshot {
  return {
    key: 'PROJ-1',
    summary: 'summary',
    status: 'To Do',
    statusCategory: 'new',
    assignee: null,
    storyPoints: 3,
    updated: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

test('selectSprintPlanCandidates fills the budget greedily in given order', () => {
  const candidates = [
    issue({ key: 'PROJ-1', storyPoints: 5 }),
    issue({ key: 'PROJ-2', storyPoints: 3 }),
    issue({ key: 'PROJ-3', storyPoints: 4 }),
  ];
  const result = selectSprintPlanCandidates(candidates, 8);
  assert.deepEqual(result.selected.map((i) => i.key), ['PROJ-1', 'PROJ-2']);
  assert.deepEqual(result.deferred.map((i) => i.key), ['PROJ-3']);
  assert.equal(result.selectedStoryPoints, 8);
  assert.equal(result.pointBudget, 8);
});

test('selectSprintPlanCandidates never auto-selects an unestimated issue, and counts it separately', () => {
  const candidates = [issue({ key: 'PROJ-1', storyPoints: null }), issue({ key: 'PROJ-2', storyPoints: 2 })];
  const result = selectSprintPlanCandidates(candidates, 20);
  assert.deepEqual(result.selected.map((i) => i.key), ['PROJ-2']);
  assert.deepEqual(result.deferred.map((i) => i.key), ['PROJ-1']);
  assert.equal(result.unestimatedCandidateCount, 1);
});

test('selectSprintPlanCandidates defers everything when the budget is 0', () => {
  const candidates = [issue({ key: 'PROJ-1', storyPoints: 1 })];
  const result = selectSprintPlanCandidates(candidates, 0);
  assert.deepEqual(result.selected, []);
  assert.deepEqual(result.deferred.map((i) => i.key), ['PROJ-1']);
  assert.equal(result.selectedStoryPoints, 0);
});

test('selectSprintPlanCandidates selects every candidate when the budget comfortably covers all of them', () => {
  const candidates = [issue({ key: 'PROJ-1', storyPoints: 1 }), issue({ key: 'PROJ-2', storyPoints: 2 })];
  const result = selectSprintPlanCandidates(candidates, 100);
  assert.deepEqual(result.selected.map((i) => i.key), ['PROJ-1', 'PROJ-2']);
  assert.deepEqual(result.deferred, []);
  assert.equal(result.selectedStoryPoints, 3);
});
