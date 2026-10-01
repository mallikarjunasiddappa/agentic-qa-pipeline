import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readSprintStatusSummary,
  readStandupDigestSummary,
  readBlockerScanSummary,
  readBurndownSummaries,
  readRetroNotesSummaries,
  buildScrumDashboardReport,
  readScrumDashboardData,
  writeScrumSubReportPages,
  writeScrumDashboardReports,
  buildScrumDashboardHtml,
  REPORT_JSON_PATH,
  REPORT_HTML_PATH,
  ScrumSprintStatusSummary,
  ScrumStandupDigestSummary,
  ScrumBlockerScanSummary,
  ScrumBurndownSprintSummary,
  ScrumRetroSprintSummary,
} from './scrumDashboard';
import { tenantDataPath } from '../../config/tenantContext';
import { BURNDOWN_JSON_PATH, BURNDOWN_MD_PATH, BurndownSprintReport } from './burndownReport';
import { RETRO_NOTES_MD_PATH, buildRetroNotesFile, writeRetroNotesFile } from './retroNotes';
import { SprintStatusReport } from './sprintStatus';
import { StandupDigestReport } from './standupDigest';
import { BlockerScanReport } from './blockerScan';

const NOW = new Date('2026-08-23T12:00:00.000Z');

function withTempCwd<T>(fn: (tmpDir: string) => T): T {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrum-dashboard-'));
  const originalCwd = process.cwd();
  process.chdir(tmpDir);
  try {
    return fn(tmpDir);
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// readSprintStatusSummary / readStandupDigestSummary / readBlockerScanSummary
// ---------------------------------------------------------------------------

test('readSprintStatusSummary returns unavailable defaults when the report file does not exist', () => {
  const missingPath = path.join(os.tmpdir(), `no-such-sprint-status-${Date.now()}.json`);
  const summary = readSprintStatusSummary(missingPath);
  assert.deepEqual(summary, {
    available: false,
    generatedAt: null,
    boardIds: [],
    activeSprintCount: 0,
    totalStoryPoints: 0,
  });
});

function zeroStatusCategoryTotals() {
  const zero = { issueCount: 0, storyPoints: 0 };
  return { new: zero, indeterminate: zero, done: zero, unknown: zero };
}

test('readSprintStatusSummary aggregates totalStoryPoints and activeSprintCount across sprint sections', () => {
  const tmpPath = path.join(os.tmpdir(), `sprint-status-report-${Date.now()}.json`);
  const fixture: SprintStatusReport = {
    generatedAt: NOW.toISOString(),
    boardIds: ['DEV', 'QA'],
    storyPointsField: 'customfield_10016',
    sprints: [
      { boardId: 'DEV', sprint: { id: 1, name: 'Sprint 1', state: 'active' }, issues: [], byStatusCategory: zeroStatusCategoryTotals(), byAssignee: [], totalStoryPoints: 8, unestimatedIssueCount: 1 },
      { boardId: 'QA', sprint: { id: 2, name: 'Sprint 2', state: 'active' }, issues: [], byStatusCategory: zeroStatusCategoryTotals(), byAssignee: [], totalStoryPoints: 5, unestimatedIssueCount: 0 },
    ],
  };
  fs.writeFileSync(tmpPath, JSON.stringify(fixture), 'utf-8');
  try {
    const summary = readSprintStatusSummary(tmpPath);
    assert.deepEqual(summary, {
      available: true,
      generatedAt: NOW.toISOString(),
      boardIds: ['DEV', 'QA'],
      activeSprintCount: 2,
      totalStoryPoints: 13,
    });
  } finally {
    fs.unlinkSync(tmpPath);
  }
});

test('readStandupDigestSummary returns unavailable defaults when the report file does not exist', () => {
  const missingPath = path.join(os.tmpdir(), `no-such-standup-digest-${Date.now()}.json`);
  const summary = readStandupDigestSummary(missingPath);
  assert.deepEqual(summary, { available: false, generatedAt: null, assigneeCount: 0, totalIssueCount: 0 });
});

test('readStandupDigestSummary aggregates totalIssueCount across assignees', () => {
  const tmpPath = path.join(os.tmpdir(), `standup-digest-report-${Date.now()}.json`);
  const fixture: StandupDigestReport = {
    generatedAt: NOW.toISOString(),
    boardIds: ['DEV'],
    storyPointsField: 'customfield_10016',
    configuredDelivery: { dm: true, channel: null },
    assignees: [
      { assignee: 'alice', notStarted: [], inProgress: [], doneThisSprint: [], unknownStatus: [], totalIssueCount: 3, totalStoryPoints: 5, unestimatedIssueCount: 0 },
      { assignee: null, notStarted: [], inProgress: [], doneThisSprint: [], unknownStatus: [], totalIssueCount: 2, totalStoryPoints: 0, unestimatedIssueCount: 2 },
    ],
  };
  fs.writeFileSync(tmpPath, JSON.stringify(fixture), 'utf-8');
  try {
    const summary = readStandupDigestSummary(tmpPath);
    assert.deepEqual(summary, {
      available: true,
      generatedAt: NOW.toISOString(),
      assigneeCount: 2,
      totalIssueCount: 5,
    });
  } finally {
    fs.unlinkSync(tmpPath);
  }
});

test('readBlockerScanSummary returns unavailable defaults when the report file does not exist', () => {
  const missingPath = path.join(os.tmpdir(), `no-such-blocker-scan-${Date.now()}.json`);
  const summary = readBlockerScanSummary(missingPath);
  assert.deepEqual(summary, { available: false, generatedAt: null, flaggedCount: 0, idleDaysThreshold: null });
});

test('readBlockerScanSummary passes flaggedCount and idleDaysThreshold through unchanged', () => {
  const tmpPath = path.join(os.tmpdir(), `blocker-scan-report-${Date.now()}.json`);
  const fixture: BlockerScanReport = {
    generatedAt: NOW.toISOString(),
    boardIds: ['DEV'],
    idleDaysThreshold: 3,
    flaggedCount: 2,
    issues: [],
  };
  fs.writeFileSync(tmpPath, JSON.stringify(fixture), 'utf-8');
  try {
    const summary = readBlockerScanSummary(tmpPath);
    assert.deepEqual(summary, {
      available: true,
      generatedAt: NOW.toISOString(),
      flaggedCount: 2,
      idleDaysThreshold: 3,
    });
  } finally {
    fs.unlinkSync(tmpPath);
  }
});

// ---------------------------------------------------------------------------
// readBurndownSummaries / readRetroNotesSummaries (directory listing + sorting)
// ---------------------------------------------------------------------------

function writeBurndownFixture(sprintId: number, overrides: Partial<BurndownSprintReport> = {}): void {
  const report: BurndownSprintReport = {
    generatedAt: NOW.toISOString(),
    boardId: 'DEV',
    sprint: { id: sprintId, name: `Sprint ${sprintId}`, state: 'active' },
    storyPointsField: 'customfield_10016',
    totalIssueCount: 4,
    totalStoryPoints: 10,
    completedIssueCount: 2,
    completedStoryPoints: 6,
    remainingIssueCount: 2,
    remainingStoryPoints: 4,
    unestimatedIssueCount: 0,
    percentComplete: 0.6,
    ...overrides,
  } as BurndownSprintReport;
  fs.mkdirSync(path.dirname(BURNDOWN_JSON_PATH(sprintId)), { recursive: true });
  fs.writeFileSync(BURNDOWN_JSON_PATH(sprintId), JSON.stringify(report), 'utf-8');
}

test('readBurndownSummaries returns [] when the scrum/ directory does not exist yet', () => {
  withTempCwd(() => {
    assert.deepEqual(readBurndownSummaries(), []);
  });
});

test('readBurndownSummaries lists every burndown-<id>.json found, sorted by sprintId descending', () => {
  withTempCwd(() => {
    writeBurndownFixture(1, { percentComplete: 0.5 });
    writeBurndownFixture(3, { percentComplete: null });
    writeBurndownFixture(2);
    // A retro file in the same directory must not be picked up as a burndown file.
    fs.writeFileSync(RETRO_NOTES_MD_PATH(1), buildRetroNotesFile(1, 'notes', NOW), 'utf-8');

    const summaries = readBurndownSummaries();

    assert.deepEqual(
      summaries.map((s) => s.sprintId),
      [3, 2, 1],
    );
    const sprint1 = summaries.find((s) => s.sprintId === 1) as ScrumBurndownSprintSummary;
    assert.equal(sprint1.boardId, 'DEV');
    assert.equal(sprint1.sprintName, 'Sprint 1');
    assert.equal(sprint1.totalStoryPoints, 10);
    assert.equal(sprint1.completedStoryPoints, 6);
    assert.equal(sprint1.percentComplete, 0.5);
    const sprint3 = summaries.find((s) => s.sprintId === 3) as ScrumBurndownSprintSummary;
    assert.equal(sprint3.percentComplete, null);
  });
});

test('readRetroNotesSummaries returns [] when the scrum/ directory does not exist yet', () => {
  withTempCwd(() => {
    assert.deepEqual(readRetroNotesSummaries(), []);
  });
});

test('readRetroNotesSummaries lists every retro-<id>.md found, sorted by sprintId descending, parsing Generated: from the file itself', () => {
  withTempCwd(() => {
    writeRetroNotesFile(1, buildRetroNotesFile(1, 'Went well: shipped X', new Date('2026-08-20T00:00:00.000Z')));
    writeRetroNotesFile(5, buildRetroNotesFile(5, 'Went well: shipped Y', new Date('2026-08-22T00:00:00.000Z')));
    // A burndown file in the same directory must not be picked up as a retro file.
    writeBurndownFixture(5);

    const summaries = readRetroNotesSummaries();

    assert.deepEqual(
      summaries.map((s) => s.sprintId),
      [5, 1],
    );
    assert.equal(summaries[0].generatedAt, '2026-08-22T00:00:00.000Z');
    assert.equal(summaries[1].generatedAt, '2026-08-20T00:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// buildScrumDashboardReport (pure composition)
// ---------------------------------------------------------------------------

test('buildScrumDashboardReport stamps generatedAt and passes each summary through unchanged', () => {
  const sprintStatus: ScrumSprintStatusSummary = {
    available: true,
    generatedAt: '2026-08-23T00:00:00.000Z',
    boardIds: ['DEV'],
    activeSprintCount: 1,
    totalStoryPoints: 8,
  };
  const standupDigest: ScrumStandupDigestSummary = {
    available: false,
    generatedAt: null,
    assigneeCount: 0,
    totalIssueCount: 0,
  };
  const blockerScan: ScrumBlockerScanSummary = {
    available: true,
    generatedAt: '2026-08-23T00:00:00.000Z',
    flaggedCount: 1,
    idleDaysThreshold: 3,
  };
  const burndown: ScrumBurndownSprintSummary[] = [
    { sprintId: 1, boardId: 'DEV', sprintName: 'Sprint 1', totalStoryPoints: 10, completedStoryPoints: 6, percentComplete: 0.6 },
  ];
  const retroNotes: ScrumRetroSprintSummary[] = [{ sprintId: 1, generatedAt: '2026-08-23T05:22:14.124Z' }];

  const report = buildScrumDashboardReport(sprintStatus, standupDigest, blockerScan, burndown, retroNotes, NOW);

  assert.deepEqual(report, {
    generatedAt: NOW.toISOString(),
    sprintStatus,
    standupDigest,
    blockerScan,
    burndown,
    retroNotes,
  });
});

test('readScrumDashboardData composes all five domains from real on-disk reports', () => {
  withTempCwd(() => {
    writeBurndownFixture(1);
    writeRetroNotesFile(1, buildRetroNotesFile(1, 'notes', NOW));
    // sprintStatus/standupDigest/blockerScan deliberately left absent - should read as unavailable.

    const report = readScrumDashboardData(NOW);

    assert.equal(report.generatedAt, NOW.toISOString());
    assert.equal(report.sprintStatus.available, false);
    assert.equal(report.standupDigest.available, false);
    assert.equal(report.blockerScan.available, false);
    assert.equal(report.burndown.length, 1);
    assert.equal(report.burndown[0].sprintId, 1);
    assert.equal(report.retroNotes.length, 1);
    assert.equal(report.retroNotes[0].sprintId, 1);
  });
});

// ---------------------------------------------------------------------------
// buildScrumDashboardHtml
// ---------------------------------------------------------------------------

function emptyReport(overrides: Partial<{
  sprintStatus: ScrumSprintStatusSummary;
  standupDigest: ScrumStandupDigestSummary;
  blockerScan: ScrumBlockerScanSummary;
  burndown: ScrumBurndownSprintSummary[];
  retroNotes: ScrumRetroSprintSummary[];
}> = {}) {
  return buildScrumDashboardReport(
    overrides.sprintStatus ?? { available: false, generatedAt: null, boardIds: [], activeSprintCount: 0, totalStoryPoints: 0 },
    overrides.standupDigest ?? { available: false, generatedAt: null, assigneeCount: 0, totalIssueCount: 0 },
    overrides.blockerScan ?? { available: false, generatedAt: null, flaggedCount: 0, idleDaysThreshold: null },
    overrides.burndown ?? [],
    overrides.retroNotes ?? [],
    NOW,
  );
}

test('buildScrumDashboardHtml shows a not-generated message for every card when nothing is available', () => {
  const html = buildScrumDashboardHtml(emptyReport());

  assert.match(html, /Not generated yet - run <code>npm run pipeline -- --stage sprint-status<\/code>/);
  assert.match(html, /Not generated yet - run <code>npm run pipeline -- --stage standup-digest<\/code>/);
  assert.match(html, /Not generated yet - run <code>npm run pipeline -- --stage blocker-scan<\/code>/);
  assert.match(html, /Not generated yet - run <code>npm run pipeline -- --stage burndown-report<\/code>/);
  assert.match(
    html,
    /Not generated yet - run <code>npm run pipeline -- --stage retro-notes-fetch<\/code> then <code>--stage retro-notes-post<\/code>/,
  );
  // REPORT_PAGE_BASE_CSS always defines the .detail-link style rule regardless of whether any
  // card uses it - assert on the actual anchor usage, not the bare class-name substring.
  assert.doesNotMatch(html, /<a class="detail-link"/);
});

test('buildScrumDashboardHtml renders real values and detail links for available sprint status/standup/blocker cards', () => {
  const html = buildScrumDashboardHtml(
    emptyReport({
      sprintStatus: { available: true, generatedAt: '2026-08-23T00:00:00.000Z', boardIds: ['DEV', 'QA'], activeSprintCount: 2, totalStoryPoints: 13 },
      standupDigest: { available: true, generatedAt: '2026-08-23T06:00:00.000Z', assigneeCount: 2, totalIssueCount: 5 },
      blockerScan: { available: true, generatedAt: '2026-08-23T00:00:00.000Z', flaggedCount: 1, idleDaysThreshold: 3 },
    }),
  );

  assert.match(html, /<dt>Boards<\/dt><dd>DEV, QA<\/dd>/);
  assert.match(html, /<dt>Active sprints<\/dt><dd>2<\/dd>/);
  assert.match(html, /<dt>Total story points<\/dt><dd>13<\/dd>/);
  assert.match(html, /href="\.\.\/sprintStatus\/report\.html"/);

  assert.match(html, /<dt>Assignees<\/dt><dd>2<\/dd>/);
  assert.match(html, /<dt>Total issues<\/dt><dd>5<\/dd>/);
  assert.match(html, /href="\.\.\/standupDigest\/report\.html"/);

  assert.match(html, /<dt>Flagged issues<\/dt><dd>1<\/dd>/);
  assert.match(html, /<dt>Idle days threshold<\/dt><dd>3<\/dd>/);
  assert.match(html, /href="\.\.\/blockerScan\/report\.html"/);
});

test('buildScrumDashboardHtml renders one linked row per sprint for available burndown and retro cards', () => {
  const html = buildScrumDashboardHtml(
    emptyReport({
      burndown: [
        { sprintId: 2, boardId: 'DEV', sprintName: 'Sprint 2', totalStoryPoints: 10, completedStoryPoints: 10, percentComplete: 1 },
        { sprintId: 1, boardId: 'DEV', sprintName: 'Sprint 1', totalStoryPoints: 8, completedStoryPoints: 4, percentComplete: 0.5 },
      ],
      retroNotes: [{ sprintId: 1, generatedAt: '2026-08-23T05:22:14.124Z' }],
    }),
  );

  assert.match(html, /href="\.\.\/scrum\/burndown-2\.html"[^<]*>10\/10 pts \(100%\)/);
  assert.match(html, /href="\.\.\/scrum\/burndown-1\.html"[^<]*>4\/8 pts \(50%\)/);
  assert.match(html, /href="\.\.\/scrum\/retro-1\.html"[^<]*>2026-08-23T05:22:14\.124Z/);
});

// ---------------------------------------------------------------------------
// writeScrumSubReportPages / writeScrumDashboardReports
// ---------------------------------------------------------------------------

test('writeScrumSubReportPages writes an HTML sibling for each present report.md and each found burndown/retro sprint file, skips the rest', () => {
  withTempCwd(() => {
    const sprintStatusDir = tenantDataPath('sprintStatus');
    fs.mkdirSync(sprintStatusDir, { recursive: true });
    fs.writeFileSync(path.join(sprintStatusDir, 'report.md'), '# Sprint Status Report\n\nBoards checked: DEV\n', 'utf-8');
    // standupDigest/ and blockerScan/ deliberately left absent.

    writeBurndownFixture(1);
    fs.writeFileSync(BURNDOWN_MD_PATH(1), '# Burndown - Sprint 1\n\nCompleted: 6/10\n', 'utf-8');
    writeRetroNotesFile(1, buildRetroNotesFile(1, 'Went well: shipped X', NOW));

    const written = writeScrumSubReportPages();

    assert.deepEqual(
      written.sort(),
      [
        tenantDataPath('sprintStatus', 'report.html'),
        tenantDataPath('scrum', 'burndown-1.html'),
        tenantDataPath('scrum', 'retro-1.html'),
      ].sort(),
    );
    assert.equal(fs.existsSync(tenantDataPath('standupDigest', 'report.html')), false);
    assert.equal(fs.existsSync(tenantDataPath('blockerScan', 'report.html')), false);

    const sprintStatusHtml = fs.readFileSync(tenantDataPath('sprintStatus', 'report.html'), 'utf-8');
    assert.match(sprintStatusHtml, /<title>Sprint Status Report<\/title>/);
    assert.match(sprintStatusHtml, /<h1>Sprint Status Report<\/h1>/);
    assert.match(sprintStatusHtml, /href="\.\.\/scrumDashboard\/report\.html"/); // back-link to the dashboard
    assert.match(sprintStatusHtml, /Back to Scrum Dashboard/); // and its label actually matches, not the pipelineReport default
    assert.doesNotMatch(sprintStatusHtml, /Back to pipeline health dashboard/);

    const burndownHtml = fs.readFileSync(tenantDataPath('scrum', 'burndown-1.html'), 'utf-8');
    assert.match(burndownHtml, /<title>Burndown - Sprint 1<\/title>/);

    const retroHtml = fs.readFileSync(tenantDataPath('scrum', 'retro-1.html'), 'utf-8');
    assert.match(retroHtml, /<title>Retro Notes - Sprint 1<\/title>/);
  });
});

test('writeScrumDashboardReports writes report.json and report.html and also writes the sub-report pages', () => {
  withTempCwd(() => {
    const sprintStatusDir = tenantDataPath('sprintStatus');
    fs.mkdirSync(sprintStatusDir, { recursive: true });
    fs.writeFileSync(path.join(sprintStatusDir, 'report.md'), '# Sprint Status Report\n\nBoards checked: DEV\n', 'utf-8');

    const report = readScrumDashboardData(NOW);
    const { reportJsonPath, reportHtmlPath } = writeScrumDashboardReports(report);

    assert.equal(reportJsonPath, REPORT_JSON_PATH());
    assert.equal(reportHtmlPath, REPORT_HTML_PATH());
    assert.equal(fs.existsSync(reportJsonPath), true);
    assert.equal(fs.existsSync(reportHtmlPath), true);

    const savedReport = JSON.parse(fs.readFileSync(reportJsonPath, 'utf-8'));
    assert.equal(savedReport.generatedAt, NOW.toISOString());

    const html = fs.readFileSync(reportHtmlPath, 'utf-8');
    assert.match(html, /<title>Scrum Dashboard<\/title>/);

    // The sprint-status sub-report page was also written as part of this call.
    assert.equal(fs.existsSync(tenantDataPath('sprintStatus', 'report.html')), true);
  });
});
