import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapReleaseIssue, buildReleaseSummaryReport, buildReleaseSignOffNote, ReleaseIssueSnapshot } from './releaseSummary';
import { JiraSearchIssueRaw } from '../../jira/jiraClient';

function rawIssue(overrides: Partial<JiraSearchIssueRaw['fields']> = {}, key = 'PROJ-1'): JiraSearchIssueRaw {
  return {
    key,
    fields: {
      summary: 'summary',
      status: { name: 'Done', statusCategory: { key: 'done' } },
      assignee: { displayName: 'Alice' },
      ...overrides,
    },
  };
}

test('mapReleaseIssue maps a raw issue onto ReleaseIssueSnapshot', () => {
  const snapshot = mapReleaseIssue(rawIssue());
  assert.equal(snapshot.key, 'PROJ-1');
  assert.equal(snapshot.statusCategory, 'done');
  assert.equal(snapshot.assignee, 'Alice');
});

test('mapReleaseIssue treats a missing statusCategory as unknown, not a guess', () => {
  const snapshot = mapReleaseIssue(rawIssue({ status: { name: 'Weird Status' } }));
  assert.equal(snapshot.statusCategory, 'unknown');
});

test('mapReleaseIssue treats an unassigned issue as null, not a crash', () => {
  const snapshot = mapReleaseIssue(rawIssue({ assignee: null }));
  assert.equal(snapshot.assignee, null);
});

function snapshot(overrides: Partial<ReleaseIssueSnapshot>): ReleaseIssueSnapshot {
  return {
    key: 'PROJ-1',
    summary: 's',
    status: 'Done',
    statusCategory: 'done',
    assignee: 'Alice',
    ...overrides,
  };
}

test('buildReleaseSummaryReport reports readyForRelease when every issue is done', () => {
  const report = buildReleaseSummaryReport('2026.09', [snapshot({ key: 'A-1' }), snapshot({ key: 'A-2' })]);
  assert.equal(report.readyForRelease, true);
  assert.equal(report.zeroIssuesFound, false);
  assert.deepEqual(report.notDoneIssues, []);
  assert.equal(report.byStatusCategory.done, 2);
});

test('buildReleaseSummaryReport is NOT ready when at least one issue is not done, and lists it', () => {
  const report = buildReleaseSummaryReport('2026.09', [
    snapshot({ key: 'A-1' }),
    snapshot({ key: 'A-2', statusCategory: 'indeterminate', status: 'In Progress' }),
  ]);
  assert.equal(report.readyForRelease, false);
  assert.equal(report.notDoneIssues.length, 1);
  assert.equal(report.notDoneIssues[0].key, 'A-2');
});

test('buildReleaseSummaryReport is NOT ready when zero issues are found (not a false clean bill)', () => {
  const report = buildReleaseSummaryReport('2026.09', []);
  assert.equal(report.zeroIssuesFound, true);
  assert.equal(report.readyForRelease, false);
  assert.equal(report.totalIssueCount, 0);
});

test('buildReleaseSignOffNote flags a zero-issue fixVersion distinctly from a ready one', () => {
  const zeroReport = buildReleaseSummaryReport('2026.09', []);
  assert.match(buildReleaseSignOffNote(zeroReport), /0 issues found/);

  const readyReport = buildReleaseSummaryReport('2026.09', [snapshot({})]);
  assert.match(buildReleaseSignOffNote(readyReport), /Ready for release sign-off/);

  const notReadyReport = buildReleaseSummaryReport('2026.09', [
    snapshot({ key: 'A-1' }),
    snapshot({ key: 'A-2', statusCategory: 'new', status: 'To Do' }),
  ]);
  const note = buildReleaseSignOffNote(notReadyReport);
  assert.match(note, /NOT ready for release/);
  assert.match(note, /1\/2/);
});
