import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBoardVelocityReport } from './velocityReport';
import { SprintStatusSprintSection } from './sprintStatus';

function section(overrides: Partial<SprintStatusSprintSection> = {}): SprintStatusSprintSection {
  return {
    boardId: 'BOARD-1',
    sprint: { id: 10, name: 'Sprint 10', state: 'closed' },
    issues: [],
    byStatusCategory: {
      new: { issueCount: 0, storyPoints: 0 },
      indeterminate: { issueCount: 0, storyPoints: 0 },
      done: { issueCount: 3, storyPoints: 13 },
      unknown: { issueCount: 0, storyPoints: 0 },
    },
    byAssignee: [],
    totalStoryPoints: 15,
    unestimatedIssueCount: 1,
    ...overrides,
  };
}

test('buildBoardVelocityReport averages completed points across closed sprints', () => {
  const sections = [
    section({ sprint: { id: 12, name: 'Sprint 12', state: 'closed' } }), // done: 13
    section({
      sprint: { id: 11, name: 'Sprint 11', state: 'closed' },
      byStatusCategory: {
        new: { issueCount: 0, storyPoints: 0 },
        indeterminate: { issueCount: 0, storyPoints: 0 },
        done: { issueCount: 2, storyPoints: 7 },
        unknown: { issueCount: 0, storyPoints: 0 },
      },
    }), // done: 7
  ];
  const report = buildBoardVelocityReport('BOARD-1', sections, 'customfield_10016');
  assert.equal(report.closedSprints.length, 2);
  assert.equal(report.closedSprints[0].completedStoryPoints, 13);
  assert.equal(report.closedSprints[1].completedStoryPoints, 7);
  assert.equal(report.averageVelocity, 10); // (13 + 7) / 2
});

test('buildBoardVelocityReport returns null averageVelocity when storyPointsField is unconfigured', () => {
  const report = buildBoardVelocityReport('BOARD-1', [section()], null);
  assert.equal(report.averageVelocity, null);
});

test('buildBoardVelocityReport returns null averageVelocity when there are no closed sprints', () => {
  const report = buildBoardVelocityReport('BOARD-1', [], 'customfield_10016');
  assert.equal(report.averageVelocity, null);
  assert.deepEqual(report.closedSprints, []);
});
