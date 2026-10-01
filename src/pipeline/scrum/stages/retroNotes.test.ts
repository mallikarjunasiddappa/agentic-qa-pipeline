import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildRetroNotesFetchReport,
  findVcsActivityForTicket,
  buildRetroNotesFile,
  RetroNotesTicket,
} from './retroNotes';
import { buildDevStatusReport, DevStatusPullRequestEntry } from './devStatus';
import { PullRequestInfo, BranchInfo } from '../vcsClient';

const NOW = new Date('2026-08-20T00:00:00.000Z');

function pr(overrides: Partial<PullRequestInfo> = {}): PullRequestInfo {
  return {
    number: 12,
    title: 'Fix the widget',
    branch: 'fix/proj-1-widget',
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
    name: 'chore/proj-2-cleanup',
    lastCommitSha: 'abc123',
    lastCommitDate: '2026-08-05T00:00:00.000Z',
    ...overrides,
  };
}

function devStatusPr(overrides: Partial<DevStatusPullRequestEntry> = {}): DevStatusPullRequestEntry {
  return {
    number: 12,
    title: 'Fix the widget',
    branch: 'fix/proj-2-widget',
    baseBranch: 'master',
    state: 'open',
    reviewState: 'approved',
    author: 'janedoe',
    url: 'https://github.com/acme/widgets/pull/12',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-02T00:00:00.000Z',
    ticketKey: 'PROJ-2',
    ...overrides,
  };
}

function ticket(overrides: Partial<RetroNotesTicket> = {}): RetroNotesTicket {
  return {
    key: 'PROJ-1',
    summary: 'Do the thing',
    status: 'Done',
    statusCategory: 'done',
    boardId: '35',
    sprintName: 'Sprint 12',
    pullRequests: [],
    branchesWithoutOpenPr: [],
    ...overrides,
  };
}

test('findVcsActivityForTicket filters an already-built DevStatusReport down to one ticket', () => {
  // Real reuse path, not a hand-rolled DevStatusReport - exercises the same
  // matchBranchToTicket()-driven ticketKey tagging pipeline.ts's stageRetroNotesFetch() will use.
  const devStatusReport = buildDevStatusReport(
    [pr({ branch: 'fix/proj-1-widget' }), pr({ number: 13, branch: 'fix/proj-9-other' })],
    [branch({ name: 'chore/proj-2-cleanup' }), branch({ name: 'chore/unrelated-cleanup' })],
    'acme/widgets',
    'PROJ',
    NOW,
  );

  const proj1 = findVcsActivityForTicket('PROJ-1', devStatusReport);
  assert.equal(proj1.pullRequests.length, 1);
  assert.equal(proj1.pullRequests[0].number, 12);
  assert.equal(proj1.branchesWithoutOpenPr.length, 0);

  const proj2 = findVcsActivityForTicket('PROJ-2', devStatusReport);
  assert.equal(proj2.pullRequests.length, 0);
  assert.equal(proj2.branchesWithoutOpenPr.length, 1);
  assert.equal(proj2.branchesWithoutOpenPr[0].name, 'chore/proj-2-cleanup');

  const proj404 = findVcsActivityForTicket('PROJ-404', devStatusReport);
  assert.equal(proj404.pullRequests.length, 0);
  assert.equal(proj404.branchesWithoutOpenPr.length, 0);
});

test('buildRetroNotesFetchReport sorts tickets by key and stamps generatedAt', () => {
  const report = buildRetroNotesFetchReport(
    ['35'],
    [ticket({ key: 'PROJ-9' }), ticket({ key: 'PROJ-1' })],
    true,
    NOW,
  );
  assert.equal(report.generatedAt, NOW.toISOString());
  assert.deepEqual(
    report.tickets.map((t) => t.key),
    ['PROJ-1', 'PROJ-9'],
  );
  assert.equal(report.ticketCount, 2);
});

test('buildRetroNotesFetchReport passes vcsConfigured through unchanged, in both directions', () => {
  const configured = buildRetroNotesFetchReport(['35'], [ticket()], true, NOW);
  assert.equal(configured.vcsConfigured, true);

  const unconfigured = buildRetroNotesFetchReport(['35'], [ticket()], false, NOW);
  assert.equal(unconfigured.vcsConfigured, false);
});

test('buildRetroNotesFetchReport counts only tickets with at least one linked PR or branch', () => {
  const report = buildRetroNotesFetchReport(
    ['35'],
    [ticket({ key: 'PROJ-1' }), ticket({ key: 'PROJ-2', pullRequests: [devStatusPr()] })],
    true,
    NOW,
  );
  assert.equal(report.ticketsWithVcsActivityCount, 1);
});

test('buildRetroNotesFetchReport handles zero tickets', () => {
  const report = buildRetroNotesFetchReport(['35'], [], true, NOW);
  assert.equal(report.ticketCount, 0);
  assert.equal(report.ticketsWithVcsActivityCount, 0);
  assert.deepEqual(report.tickets, []);
});

test('buildRetroNotesFetchReport still returns a full ticket list when VCS is not configured - tickets are not dropped, just VCS-empty', () => {
  const report = buildRetroNotesFetchReport(
    ['35'],
    [ticket({ key: 'PROJ-1' }), ticket({ key: 'PROJ-2' })],
    false,
    NOW,
  );
  assert.equal(report.vcsConfigured, false);
  assert.equal(report.ticketCount, 2);
  assert.equal(report.ticketsWithVcsActivityCount, 0);
});

test('buildRetroNotesFile wraps live-synthesized notes with a minimal standard header', () => {
  const content = buildRetroNotesFile(1, '## What went well\n- Shipped burndown-report\n', NOW);
  assert.match(content, /^# Retro Notes - Sprint 1\n/);
  assert.match(content, new RegExp(`Generated: ${NOW.toISOString()}`));
  assert.match(content, /## What went well/);
  assert.match(content, /Shipped burndown-report/);
});

test('buildRetroNotesFile does not re-derive or drop the notes text - it is passed through verbatim', () => {
  const notes = 'Line one\nLine two\n- action item A\n- action item B';
  const content = buildRetroNotesFile(2, notes, NOW);
  assert.ok(content.endsWith(notes));
});
