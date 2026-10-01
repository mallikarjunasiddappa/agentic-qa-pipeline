import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchBranchToTicket, buildDevStatusReport, DevStatusPullRequestEntry } from './devStatus';
import { PullRequestInfo, BranchInfo } from '../vcsClient';

function pr(overrides: Partial<PullRequestInfo> = {}): PullRequestInfo {
  return {
    number: 12,
    title: 'Fix the widget',
    branch: 'fix/proj-123-widget',
    baseBranch: 'master',
    state: 'open',
    reviewState: 'approved',
    author: 'janedoe',
    url: 'https://github.com/acme/widgets/pull/12',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-02T00:00:00.000Z',
    ...overrides,
  };
}

function branch(overrides: Partial<BranchInfo> = {}): BranchInfo {
  return {
    name: 'fix/proj-123-widget',
    lastCommitSha: 'abc123',
    lastCommitDate: '2026-08-02T00:00:00.000Z',
    ...overrides,
  };
}

test('matchBranchToTicket finds a ticket key anywhere in the branch name, case-insensitively', () => {
  assert.equal(matchBranchToTicket('fix/proj-123-widget', 'PROJ'), 'PROJ-123');
  assert.equal(matchBranchToTicket('PROJ-456-hotfix', 'proj'), 'PROJ-456');
  assert.equal(matchBranchToTicket('feature/nested/proj-789', 'PROJ'), 'PROJ-789');
});

test('matchBranchToTicket returns null when the branch has no matching ticket key', () => {
  assert.equal(matchBranchToTicket('chore/bump-deps', 'PROJ'), null);
  assert.equal(matchBranchToTicket('master', 'PROJ'), null);
});

test('matchBranchToTicket returns null when projectKey is empty rather than matching every hyphenated branch', () => {
  assert.equal(matchBranchToTicket('feature/some-thing-123', ''), null);
});

test('matchBranchToTicket does not match a different project\'s key', () => {
  assert.equal(matchBranchToTicket('fix/other-123-widget', 'PROJ'), null);
});

test('matchBranchToTicket treats special regex characters in projectKey literally', () => {
  // Defensive - real Jira project keys are alphanumeric, but this must not throw or behave like a
  // regex metacharacter if one ever contains one.
  assert.equal(matchBranchToTicket('fix/pro.j-123-widget', 'PRO.J'), 'PRO.J-123');
  assert.equal(matchBranchToTicket('fix/projx123-widget', 'PRO.J'), null);
});

test('buildDevStatusReport maps a fully-populated PR and marks it linked', () => {
  const report = buildDevStatusReport([pr()], [], 'acme/widgets', 'PROJ', new Date('2026-08-03T00:00:00.000Z'));
  assert.equal(report.repo, 'acme/widgets');
  assert.equal(report.generatedAt, '2026-08-03T00:00:00.000Z');
  assert.equal(report.pullRequests.length, 1);
  assert.equal(report.unlinkedPullRequestCount, 0);
  const entry: DevStatusPullRequestEntry = report.pullRequests[0];
  assert.equal(entry.ticketKey, 'PROJ-123');
  assert.equal(entry.number, 12);
  assert.equal(entry.reviewState, 'approved');
});

test('buildDevStatusReport counts and keeps PRs whose branch matches no ticket key', () => {
  const report = buildDevStatusReport(
    [pr({ number: 1, branch: 'fix/proj-1-a' }), pr({ number: 2, branch: 'chore/bump-deps' })],
    [],
    'acme/widgets',
    'PROJ',
  );
  assert.equal(report.pullRequests.length, 2);
  assert.equal(report.unlinkedPullRequestCount, 1);
  const unlinked = report.pullRequests.find((p) => p.number === 2);
  assert.equal(unlinked?.ticketKey, null);
});

test('buildDevStatusReport excludes branches that already have an open PR from branchesWithoutOpenPr', () => {
  const report = buildDevStatusReport(
    [pr({ branch: 'fix/proj-123-widget' })],
    [branch({ name: 'fix/proj-123-widget' }), branch({ name: 'feature/proj-456-other' })],
    'acme/widgets',
    'PROJ',
  );
  assert.equal(report.branchesWithoutOpenPr.length, 1);
  assert.equal(report.branchesWithoutOpenPr[0].name, 'feature/proj-456-other');
  assert.equal(report.branchesWithoutOpenPr[0].ticketKey, 'PROJ-456');
});

test('buildDevStatusReport excludes any branch used as a baseBranch (e.g. trunk) from branchesWithoutOpenPr', () => {
  const report = buildDevStatusReport(
    [pr({ branch: 'fix/proj-123-widget', baseBranch: 'master' })],
    [branch({ name: 'master', lastCommitSha: 'trunk-sha' }), branch({ name: 'feature/proj-456-other' })],
    'acme/widgets',
    'PROJ',
  );
  const names = report.branchesWithoutOpenPr.map((b) => b.name);
  assert.equal(names.includes('master'), false);
  assert.equal(names.includes('feature/proj-456-other'), true);
});

test('buildDevStatusReport marks an unlinked branch (no matching ticket key) the same way as an unlinked PR', () => {
  const report = buildDevStatusReport(
    [],
    [branch({ name: 'spike/experiment', lastCommitSha: 'sha1' })],
    'acme/widgets',
    'PROJ',
  );
  assert.equal(report.branchesWithoutOpenPr.length, 1);
  assert.equal(report.branchesWithoutOpenPr[0].ticketKey, null);
});

test('buildDevStatusReport returns empty sections (not an error) when there is no PR and no branch activity', () => {
  const report = buildDevStatusReport([], [], 'acme/widgets', 'PROJ');
  assert.deepEqual(report.pullRequests, []);
  assert.equal(report.unlinkedPullRequestCount, 0);
  assert.deepEqual(report.branchesWithoutOpenPr, []);
});
