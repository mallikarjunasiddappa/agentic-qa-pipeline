import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCoverageReport } from './coverageReport';
import { buildSprintStatusReport, SprintStatusBoardSprint } from './sprintStatus';
import { SprintInfo, SprintIssueSnapshot } from '../agileClient';
import { DevStatusReport, DevStatusPullRequestEntry, DevStatusBranchEntry } from './devStatus';
import { TraceabilityEntry, SyncState } from '../../types/schemas';

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

function traceabilityEntry(overrides: Partial<TraceabilityEntry> = {}): TraceabilityEntry {
  return {
    jiraKey: 'PROJ-1',
    externalCaseId: 'C1',
    externalCaseHash: 'hash1',
    externalCaseUpdatedAt: '2026-08-10T00:00:00.000Z',
    tmsProvider: 'qase',
    testFilePath: 'tests/ui/proj-1.spec.ts',
    testContentHash: 'hash2',
    testLastModified: '2026-08-10T00:00:00.000Z',
    syncState: 'IN_SYNC' as SyncState,
    lastCheckedAt: '2026-08-10T00:00:00.000Z',
    ...overrides,
  };
}

function pr(overrides: Partial<DevStatusPullRequestEntry> = {}): DevStatusPullRequestEntry {
  return {
    number: 1,
    title: 'Fix PROJ-1',
    branch: 'proj-1-fix',
    baseBranch: 'main',
    state: 'open',
    reviewState: 'review_required',
    author: 'jane',
    url: 'https://github.com/org/repo/pull/1',
    createdAt: '2026-08-09T00:00:00.000Z',
    updatedAt: '2026-08-10T00:00:00.000Z',
    ticketKey: 'PROJ-1',
    ...overrides,
  };
}

function devStatusReport(overrides: Partial<DevStatusReport> = {}): DevStatusReport {
  return {
    generatedAt: '2026-08-20T00:00:00.000Z',
    repo: 'org/repo',
    pullRequests: [],
    unlinkedPullRequestCount: 0,
    branchesWithoutOpenPr: [],
    ...overrides,
  };
}

const NOW = new Date('2026-08-20T00:00:00.000Z');

test('buildCoverageReport: a story with a traceability entry is covered; one with none is not', () => {
  const section = boardSprint({
    issues: [issue({ key: 'PROJ-1' }), issue({ key: 'PROJ-2', summary: 'No tests yet' })],
  });
  const statusReport = buildSprintStatusReport(['35'], [section], null);
  const manifestEntries = [traceabilityEntry({ jiraKey: 'PROJ-1' })];

  const report = buildCoverageReport(['35'], statusReport.sprints, manifestEntries, null, NOW);

  assert.equal(report.sprints.length, 1);
  const [s] = report.sprints;
  assert.equal(s.totalStoryCount, 2);
  assert.equal(s.coveredStoryCount, 1);
  const proj1 = s.stories.find((x) => x.key === 'PROJ-1')!;
  const proj2 = s.stories.find((x) => x.key === 'PROJ-2')!;
  assert.equal(proj1.covered, true);
  assert.equal(proj2.covered, false);
  assert.deepEqual(proj2.links, []);
});

test('buildCoverageReport: covered but drifted is NOT counted as healthy', () => {
  const section = boardSprint({ issues: [issue({ key: 'PROJ-1' })] });
  const statusReport = buildSprintStatusReport(['35'], [section], null);
  const manifestEntries = [traceabilityEntry({ jiraKey: 'PROJ-1', syncState: 'TEST_DRIFTED' as SyncState })];

  const report = buildCoverageReport(['35'], statusReport.sprints, manifestEntries, null, NOW);

  const [s] = report.sprints;
  assert.equal(s.coveredStoryCount, 1);
  assert.equal(s.healthyCoverageCount, 0);
  assert.equal(s.stories[0].covered, true);
  assert.equal(s.stories[0].healthy, false);
});

test('buildCoverageReport: a story is healthy only when EVERY linked entry is IN_SYNC', () => {
  const section = boardSprint({ issues: [issue({ key: 'PROJ-1' })] });
  const statusReport = buildSprintStatusReport(['35'], [section], null);
  const manifestEntries = [
    traceabilityEntry({ jiraKey: 'PROJ-1', externalCaseId: 'C1', syncState: 'IN_SYNC' as SyncState }),
    traceabilityEntry({ jiraKey: 'PROJ-1', externalCaseId: 'C2', syncState: 'ORPHANED_CASE' as SyncState }),
  ];

  const report = buildCoverageReport(['35'], statusReport.sprints, manifestEntries, null, NOW);

  const [s] = report.sprints;
  assert.equal(s.stories[0].links.length, 2);
  assert.equal(s.stories[0].covered, true);
  assert.equal(s.stories[0].healthy, false);
});

test('buildCoverageReport: devCovered is null (not false) when VCS is not configured for this tenant', () => {
  const section = boardSprint({ issues: [issue({ key: 'PROJ-1' })] });
  const statusReport = buildSprintStatusReport(['35'], [section], null);

  const report = buildCoverageReport(['35'], statusReport.sprints, [], null, NOW);

  assert.equal(report.vcsConfigured, false);
  assert.equal(report.sprints[0].devCoveredStoryCount, null);
  assert.equal(report.sprints[0].stories[0].devCovered, null);
});

test('buildCoverageReport: devCovered is true when the ticket has an open PR', () => {
  const section = boardSprint({
    issues: [issue({ key: 'PROJ-1' }), issue({ key: 'PROJ-2', summary: 'No PR yet' })],
  });
  const statusReport = buildSprintStatusReport(['35'], [section], null);
  const devReport = devStatusReport({ pullRequests: [pr({ ticketKey: 'PROJ-1' })] });

  const report = buildCoverageReport(['35'], statusReport.sprints, [], devReport, NOW);

  assert.equal(report.vcsConfigured, true);
  const [s] = report.sprints;
  assert.equal(s.devCoveredStoryCount, 1);
  assert.equal(s.stories.find((x) => x.key === 'PROJ-1')!.devCovered, true);
  assert.equal(s.stories.find((x) => x.key === 'PROJ-2')!.devCovered, false);
});

test('buildCoverageReport: a branch with no open PR yet still counts as dev coverage', () => {
  const section = boardSprint({ issues: [issue({ key: 'PROJ-1' })] });
  const statusReport = buildSprintStatusReport(['35'], [section], null);
  const branch: DevStatusBranchEntry = {
    name: 'proj-1-wip',
    lastCommitSha: 'abc123',
    lastCommitDate: '2026-08-19T00:00:00.000Z',
    ticketKey: 'PROJ-1',
  };
  const devReport = devStatusReport({ branchesWithoutOpenPr: [branch] });

  const report = buildCoverageReport(['35'], statusReport.sprints, [], devReport, NOW);

  assert.equal(report.sprints[0].stories[0].devCovered, true);
});

test('buildCoverageReport: no active sprints -> empty sprints array, no crash', () => {
  const report = buildCoverageReport(['35'], [], [], null, NOW);
  assert.deepEqual(report.sprints, []);
  assert.equal(report.boardIds.length, 1);
});
