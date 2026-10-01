import fs from 'node:fs';
import path from 'node:path';
import { tenantDataPath } from '../../config/tenantContext';
import { renderMarkdownToHtml, wrapReportPage } from '../../shared/markdownToHtml';
import { REPORT_PAGE_BASE_CSS } from '../../shared/reportPageStyle';
import {
  REPORT_JSON_PATH as SPRINT_STATUS_JSON_PATH,
  REPORT_MD_PATH as SPRINT_STATUS_MD_PATH,
  SprintStatusReport,
} from './sprintStatus';
import {
  REPORT_JSON_PATH as STANDUP_DIGEST_JSON_PATH,
  REPORT_MD_PATH as STANDUP_DIGEST_MD_PATH,
  StandupDigestReport,
} from './standupDigest';
import {
  REPORT_JSON_PATH as BLOCKER_SCAN_JSON_PATH,
  REPORT_MD_PATH as BLOCKER_SCAN_MD_PATH,
  BlockerScanReport,
} from './blockerScan';
import { BURNDOWN_JSON_PATH, BURNDOWN_MD_PATH, BurndownSprintReport } from './burndownReport';
import { RETRO_NOTES_MD_PATH } from './retroNotes';

/**
 * Dashboard v1, PR 1: read-only HTML views over this program's five scrum reports - sprint
 * status, standup digest, blocker scan, burndown, and retro notes. Explicitly out of scope here
 * (per spec): the Settings panel, any write action, any auth, and any framework/hosting decision -
 * this produces the exact same kind of static, self-hosted HTML page every other domain in this
 * project already produces (see pipelineReport.ts's writeSubReportPages()/buildReportHtml() for
 * the pattern this follows), nothing more.
 *
 * NO NEW INGESTION, NO NEW AGGREGATION LAYER: every function below only reads a report a scrum
 * stage has already written to disk (each stage's own REPORT_JSON_PATH()/REPORT_MD_PATH(), or
 * burndown-report's/retro-notes' per-sprint file naming) - there is no database, no new client
 * call, and no re-fetching of Jira/GitHub data anywhere in this file. Mirrors
 * pipelineReport.ts's readTraceabilitySummary(): read an already-written JSON, tolerate it not
 * existing yet (capability off, or the stage simply hasn't been run), and say so plainly rather
 * than showing a blank or broken view - same honesty-over-guessing convention every stage in this
 * program has followed since Phase 1.
 *
 * STANDUP IS A SNAPSHOT, NOT A HISTORY: standupDigest.ts writes a single report.json/report.md,
 * overwritten every run (confirmed against scrum-ceremony-report.yml: each weekday morning's run
 * commits over the same path) - there is no dated-archive file to read multiple days from. This
 * view is deliberately titled "Latest Standup Digest," not "Standup History" - showing the one
 * snapshot that exists is honest; a "history" label over one data point would not be. Building a
 * dated-archive convention for standup-digest would itself be a new ingestion pattern, which this
 * PR was explicitly told not to introduce.
 *
 * BURNDOWN AND RETRO ARE NATURALLY PER-SPRINT, NOT SINGLE-FILE: unlike the three domains above,
 * burndownReport.ts/retroNotes.ts write one file per (board, sprint)/sprint respectively under the
 * shared data/<tenantId>/scrum/ directory (burndown-<sprintId>.json/.md, retro-<sprintId>.md) -
 * see each file's own header comment for why. This module lists whichever of those files already
 * exist (readdirSync + a filename pattern, no new file format) rather than requiring a caller to
 * already know every sprint id that has ever been run.
 */

function card(title: string, rows: string[], footerHref: string | null, footerLabel: string): string {
  const footer = footerHref
    ? `<a class="detail-link" href="${escapeHtml(footerHref)}">${escapeHtml(footerLabel)} &rarr;</a>`
    : '';
  return `
    <section class="card">
      <h2>${escapeHtml(title)}</h2>
      <dl>${rows.join('')}</dl>
      ${footer}
    </section>`;
}

function row(label: string, value: string): string {
  return `<div class="row"><dt>${escapeHtml(label)}</dt><dd>${value}</dd></div>`;
}

// Same escaping posture as pipelineReport.ts's own escapeHtml() - this dashboard is meant to be
// opened directly in a browser, and while today's inputs (tenant config, Jira ticket text) are all
// internally-controlled, escaping costs nothing and avoids depending on that staying true forever.
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function REPORT_JSON_PATH(): string {
  return tenantDataPath('scrumDashboard', 'report.json');
}
export function REPORT_HTML_PATH(): string {
  return tenantDataPath('scrumDashboard', 'report.html');
}

// Every per-domain report.html this module writes lives exactly one directory below
// data/<tenantId>/ (sprintStatus/, standupDigest/, blockerScan/, scrum/) - the same depth as
// scrumDashboard/ itself - so '../scrumDashboard/report.html' resolves correctly as a back-link
// from any of them, regardless of which stage's directory it's written into.
const BACK_TO_DASHBOARD_HREF = '../scrumDashboard/report.html';
// wrapReportPage()'s own backLabel default text ("Back to pipeline health dashboard") describes
// the pipelineReport dashboard, not this one - every sub-report page below passes this instead so
// the label actually matches where BACK_TO_DASHBOARD_HREF points.
const BACK_TO_DASHBOARD_LABEL = 'Back to Scrum Dashboard';

export interface ScrumSprintStatusSummary {
  available: boolean;
  generatedAt: string | null;
  boardIds: string[];
  activeSprintCount: number;
  totalStoryPoints: number;
}

export interface ScrumStandupDigestSummary {
  available: boolean;
  generatedAt: string | null;
  assigneeCount: number;
  totalIssueCount: number;
}

export interface ScrumBlockerScanSummary {
  available: boolean;
  generatedAt: string | null;
  flaggedCount: number;
  idleDaysThreshold: number | null;
}

export interface ScrumBurndownSprintSummary {
  sprintId: number;
  boardId: string;
  sprintName: string;
  totalStoryPoints: number;
  completedStoryPoints: number;
  percentComplete: number | null;
}

export interface ScrumRetroSprintSummary {
  sprintId: number;
  // Parsed from the file's own "Generated: <timestamp>" line (buildRetroNotesFile()'s standard
  // header) rather than the file's OS mtime - a pure parse of content this program itself wrote,
  // not a filesystem timestamp that could be disturbed by an unrelated copy/checkout operation.
  generatedAt: string | null;
}

export interface ScrumDashboardReport {
  generatedAt: string;
  sprintStatus: ScrumSprintStatusSummary;
  standupDigest: ScrumStandupDigestSummary;
  blockerScan: ScrumBlockerScanSummary;
  // Sorted by sprintId descending (most recently created sprint first) - Jira sprint ids are
  // assigned in increasing order over time, so this reads newest-first without needing any date
  // field to sort by.
  burndown: ScrumBurndownSprintSummary[];
  retroNotes: ScrumRetroSprintSummary[];
}

export function readSprintStatusSummary(
  reportJsonPath: string = SPRINT_STATUS_JSON_PATH(),
): ScrumSprintStatusSummary {
  if (!fs.existsSync(reportJsonPath)) {
    return { available: false, generatedAt: null, boardIds: [], activeSprintCount: 0, totalStoryPoints: 0 };
  }
  const raw = JSON.parse(fs.readFileSync(reportJsonPath, 'utf-8')) as SprintStatusReport;
  const totalStoryPoints = raw.sprints.reduce((sum, section) => sum + section.totalStoryPoints, 0);
  return {
    available: true,
    generatedAt: raw.generatedAt,
    boardIds: raw.boardIds,
    activeSprintCount: raw.sprints.length,
    totalStoryPoints,
  };
}

export function readStandupDigestSummary(
  reportJsonPath: string = STANDUP_DIGEST_JSON_PATH(),
): ScrumStandupDigestSummary {
  if (!fs.existsSync(reportJsonPath)) {
    return { available: false, generatedAt: null, assigneeCount: 0, totalIssueCount: 0 };
  }
  const raw = JSON.parse(fs.readFileSync(reportJsonPath, 'utf-8')) as StandupDigestReport;
  const totalIssueCount = raw.assignees.reduce((sum, a) => sum + a.totalIssueCount, 0);
  return {
    available: true,
    generatedAt: raw.generatedAt,
    assigneeCount: raw.assignees.length,
    totalIssueCount,
  };
}

export function readBlockerScanSummary(
  reportJsonPath: string = BLOCKER_SCAN_JSON_PATH(),
): ScrumBlockerScanSummary {
  if (!fs.existsSync(reportJsonPath)) {
    return { available: false, generatedAt: null, flaggedCount: 0, idleDaysThreshold: null };
  }
  const raw = JSON.parse(fs.readFileSync(reportJsonPath, 'utf-8')) as BlockerScanReport;
  return {
    available: true,
    generatedAt: raw.generatedAt,
    flaggedCount: raw.flaggedCount,
    idleDaysThreshold: raw.idleDaysThreshold,
  };
}

// Matches burndown-report's/retro-notes' own filename convention exactly (BURNDOWN_JSON_PATH()/
// RETRO_NOTES_MD_PATH() in their respective files) - captured here as regexes only to list
// *which* sprint ids exist, never to construct a path by hand (every actual path used below still
// goes through each domain's own exported path function).
const BURNDOWN_FILENAME_PATTERN = /^burndown-(\d+)\.json$/;
const RETRO_FILENAME_PATTERN = /^retro-(\d+)\.md$/;

function listSprintIds(pattern: RegExp): number[] {
  const dir = tenantDataPath('scrum');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .map((name) => name.match(pattern))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => Number(match[1]))
    .sort((a, b) => b - a);
}

export function readBurndownSummaries(): ScrumBurndownSprintSummary[] {
  return listSprintIds(BURNDOWN_FILENAME_PATTERN).map((sprintId) => {
    const raw = JSON.parse(fs.readFileSync(BURNDOWN_JSON_PATH(sprintId), 'utf-8')) as BurndownSprintReport;
    return {
      sprintId,
      boardId: raw.boardId,
      sprintName: raw.sprint.name,
      totalStoryPoints: raw.totalStoryPoints,
      completedStoryPoints: raw.completedStoryPoints,
      percentComplete: raw.percentComplete,
    };
  });
}

// buildRetroNotesFile()'s own standard header always writes this as its second line - parsed back
// out here rather than trusting the file's OS mtime, which a copy/checkout/CI-artifact-download
// step could disturb without the retro's real post time changing.
function parseRetroGeneratedAt(markdown: string): string | null {
  const match = markdown.match(/^Generated: (.+)$/m);
  return match ? match[1].trim() : null;
}

export function readRetroNotesSummaries(): ScrumRetroSprintSummary[] {
  return listSprintIds(RETRO_FILENAME_PATTERN).map((sprintId) => {
    const markdown = fs.readFileSync(RETRO_NOTES_MD_PATH(sprintId), 'utf-8');
    return { sprintId, generatedAt: parseRetroGeneratedAt(markdown) };
  });
}

/**
 * Pure aggregation over each domain's own already-read summary - no I/O here, matching
 * pipelineReport.ts's buildPipelineReport(). Callers (readScrumDashboardData() below, or a test
 * building fixtures directly) do the actual reading first.
 */
export function buildScrumDashboardReport(
  sprintStatus: ScrumSprintStatusSummary,
  standupDigest: ScrumStandupDigestSummary,
  blockerScan: ScrumBlockerScanSummary,
  burndown: ScrumBurndownSprintSummary[],
  retroNotes: ScrumRetroSprintSummary[],
  now: Date = new Date(),
): ScrumDashboardReport {
  return {
    generatedAt: now.toISOString(),
    sprintStatus,
    standupDigest,
    blockerScan,
    burndown,
    retroNotes,
  };
}

/** Impure convenience wrapper: reads every domain's current on-disk report, then builds the
 * combined dashboard report from them. Split from buildScrumDashboardReport() purely so tests can
 * exercise the aggregation logic against hand-built summaries without touching the filesystem -
 * same split pipelineReport.ts's stagePipelineReport() (orchestrator/pipeline.ts) keeps between
 * reading each sub-report and calling buildPipelineReport().
 */
export function readScrumDashboardData(now: Date = new Date()): ScrumDashboardReport {
  return buildScrumDashboardReport(
    readSprintStatusSummary(),
    readStandupDigestSummary(),
    readBlockerScanSummary(),
    readBurndownSummaries(),
    readRetroNotesSummaries(),
    now,
  );
}

/**
 * Generates a report.html sibling for each of the three single-file domains (sprint-status,
 * standup-digest, blocker-scan) plus one per burndown/retro sprint file found - via the exact same
 * shared markdown renderer every other domain in this project already uses (renderMarkdownToHtml/
 * wrapReportPage), mirroring pipelineReport.ts's writeSubReportPages() precisely. Best-effort:
 * silently skips any report whose .md doesn't exist yet, same as writeSubReportPages() does for
 * cost/flaky (no scheduled CI job for those two) - a missing report here just means "not run for
 * this tenant yet, or its capability flag is off," not an error.
 */
export function writeScrumSubReportPages(): string[] {
  const written: string[] = [];

  const singleFileDomains: { mdPath: string; htmlPath: string; title: string }[] = [
    { mdPath: SPRINT_STATUS_MD_PATH(), htmlPath: tenantDataPath('sprintStatus', 'report.html'), title: 'Sprint Status Report' },
    { mdPath: STANDUP_DIGEST_MD_PATH(), htmlPath: tenantDataPath('standupDigest', 'report.html'), title: 'Standup Digest (Latest)' },
    { mdPath: BLOCKER_SCAN_MD_PATH(), htmlPath: tenantDataPath('blockerScan', 'report.html'), title: 'Blocker Scan Report' },
  ];
  for (const { mdPath, htmlPath, title } of singleFileDomains) {
    if (!fs.existsSync(mdPath)) continue;
    const markdown = fs.readFileSync(mdPath, 'utf-8');
    fs.writeFileSync(htmlPath, wrapReportPage(title, renderMarkdownToHtml(markdown), BACK_TO_DASHBOARD_HREF, BACK_TO_DASHBOARD_LABEL), 'utf-8');
    written.push(htmlPath);
  }

  for (const sprintId of listSprintIds(BURNDOWN_FILENAME_PATTERN)) {
    const mdPath = BURNDOWN_MD_PATH(sprintId);
    const markdown = fs.readFileSync(mdPath, 'utf-8');
    const htmlPath = tenantDataPath('scrum', `burndown-${sprintId}.html`);
    fs.writeFileSync(
      htmlPath,
      wrapReportPage(`Burndown - Sprint ${sprintId}`, renderMarkdownToHtml(markdown), BACK_TO_DASHBOARD_HREF, BACK_TO_DASHBOARD_LABEL),
      'utf-8',
    );
    written.push(htmlPath);
  }

  for (const sprintId of listSprintIds(RETRO_FILENAME_PATTERN)) {
    const mdPath = RETRO_NOTES_MD_PATH(sprintId);
    const markdown = fs.readFileSync(mdPath, 'utf-8');
    const htmlPath = tenantDataPath('scrum', `retro-${sprintId}.html`);
    fs.writeFileSync(
      htmlPath,
      wrapReportPage(`Retro Notes - Sprint ${sprintId}`, renderMarkdownToHtml(markdown), BACK_TO_DASHBOARD_HREF, BACK_TO_DASHBOARD_LABEL),
      'utf-8',
    );
    written.push(htmlPath);
  }

  return written;
}

export function writeScrumDashboardReports(
  report: ScrumDashboardReport,
): { reportJsonPath: string; reportHtmlPath: string } {
  fs.mkdirSync(path.dirname(REPORT_JSON_PATH()), { recursive: true });
  fs.writeFileSync(REPORT_JSON_PATH(), `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
  fs.writeFileSync(REPORT_HTML_PATH(), buildScrumDashboardHtml(report), 'utf-8');
  writeScrumSubReportPages();
  return { reportJsonPath: REPORT_JSON_PATH(), reportHtmlPath: REPORT_HTML_PATH() };
}

function pct(rate: number | null): string {
  return rate === null ? 'n/a' : `${Math.round(rate * 100)}%`;
}

function notAvailableRow(stageCommand: string): string {
  return row('Status', `Not generated yet - run <code>npm run pipeline -- --stage ${stageCommand}</code>`);
}

// Exported for testing - not part of the public report-generation flow, callers should go through
// writeScrumDashboardReports().
export function buildScrumDashboardHtml(report: ScrumDashboardReport): string {
  const sprintStatusCard = card(
    'Sprint Status',
    report.sprintStatus.available
      ? [
          row('Boards', report.sprintStatus.boardIds.join(', ') || 'none configured'),
          row('Active sprints', String(report.sprintStatus.activeSprintCount)),
          row('Total story points', String(report.sprintStatus.totalStoryPoints)),
        ]
      : [notAvailableRow('sprint-status')],
    report.sprintStatus.available ? '../sprintStatus/report.html' : null,
    'Full sprint status report',
  );

  const standupDigestCard = card(
    'Latest Standup Digest',
    report.standupDigest.available
      ? [
          row('Generated', escapeHtml(report.standupDigest.generatedAt ?? '')),
          row('Assignees', String(report.standupDigest.assigneeCount)),
          row('Total issues', String(report.standupDigest.totalIssueCount)),
        ]
      : [notAvailableRow('standup-digest')],
    report.standupDigest.available ? '../standupDigest/report.html' : null,
    'Full standup digest',
  );

  const blockerScanCard = card(
    'Blocker Scan',
    report.blockerScan.available
      ? [
          row('Flagged issues', String(report.blockerScan.flaggedCount)),
          row('Idle days threshold', String(report.blockerScan.idleDaysThreshold ?? 'n/a')),
        ]
      : [notAvailableRow('blocker-scan')],
    report.blockerScan.available ? '../blockerScan/report.html' : null,
    'Full blocker scan report',
  );

  const burndownCard = card(
    'Burndown',
    report.burndown.length === 0
      ? [notAvailableRow('burndown-report')]
      : report.burndown.map((sprint) =>
          row(
            `${sprint.boardId} / ${sprint.sprintName}`,
            `<a href="../scrum/burndown-${sprint.sprintId}.html">${sprint.completedStoryPoints}/${sprint.totalStoryPoints} pts (${pct(sprint.percentComplete)})</a>`,
          ),
        ),
    null,
    '',
  );

  const retroNotesCard = card(
    'Retro Notes',
    report.retroNotes.length === 0
      ? [row('Status', 'Not generated yet - run <code>npm run pipeline -- --stage retro-notes-fetch</code> then <code>--stage retro-notes-post</code>')]
      : report.retroNotes.map((sprint) =>
          row(
            `Sprint ${sprint.sprintId}`,
            `<a href="../scrum/retro-${sprint.sprintId}.html">${escapeHtml(sprint.generatedAt ?? 'view')}</a>`,
          ),
        ),
    null,
    '',
  );

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Scrum Dashboard</title>
<style>
${REPORT_PAGE_BASE_CSS}
</style>
</head>
<body>
<div class="wrap">
  <h1>Scrum Dashboard</h1>
  <p class="generated">Generated ${escapeHtml(report.generatedAt)}</p>
  <div class="grid">
    ${sprintStatusCard}
    ${standupDigestCard}
    ${blockerScanCard}
    ${burndownCard}
    ${retroNotesCard}
  </div>
</div>
</body>
</html>
`;
}
