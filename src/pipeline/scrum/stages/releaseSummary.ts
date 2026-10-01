import fs from 'node:fs';
import path from 'node:path';
import { tenantDataPath } from '../../config/tenantContext';
import { JiraSearchIssueRaw } from '../../jira/jiraClient';

/**
 * Phase E ("AI-Assisted Scrum and SDLC Console - Development Plan," docs/planning/) - "Release
 * Stage," deliberately built last and deliberately the most conservative stage in this whole
 * program, per the source deck's own "highest caution" label and this plan's own explicit
 * instruction: "Read-only summarization only ... it must never trigger a release." Every function
 * in this file only ever reads and reports; nothing here calls Jira's write API, sets a
 * fixVersion, transitions an issue, or talks to a deploy tool. --stage release-summary
 * (pipeline.ts) is this module's only caller, and it queues the result as a NEEDS_SESSION AI Queue
 * item for a real Release Owner sign-off - "needs a real owner sign-off UX, not just a report," per
 * this plan's own Phase E section - rather than ever acting on the summary itself.
 *
 * Same four-category status bucketing every other scrum stage in this pipeline already uses
 * (SprintIssueStatusCategory's own reasoning in agileClient.ts) - kept as its own local type here
 * rather than importing agileClient.ts's, since this reads Jira's core REST API v3 (JiraClient),
 * not the Agile API (AgileClient) - two separate REST surfaces with separately-typed raw shapes
 * (see jiraClient.ts's JiraSearchIssueRaw doc comment), so this stage does not take a dependency on
 * the sprint/board-scoped client at all.
 */

export type ReleaseIssueStatusCategory = 'new' | 'indeterminate' | 'done' | 'unknown';

export interface ReleaseIssueSnapshot {
  key: string;
  summary: string;
  status: string;
  statusCategory: ReleaseIssueStatusCategory;
  assignee: string | null;
}

function mapStatusCategory(key: string | undefined): ReleaseIssueStatusCategory {
  if (key === 'new' || key === 'indeterminate' || key === 'done') return key;
  return 'unknown';
}

/** Pure mapper: one raw JiraSearchIssueRaw -> this stage's own ReleaseIssueSnapshot shape. */
export function mapReleaseIssue(raw: JiraSearchIssueRaw): ReleaseIssueSnapshot {
  return {
    key: raw.key,
    summary: raw.fields.summary,
    status: raw.fields.status.name,
    statusCategory: mapStatusCategory(raw.fields.status.statusCategory?.key),
    assignee: raw.fields.assignee?.displayName ?? null,
  };
}

export interface ReleaseSummaryReport {
  generatedAt: string;
  fixVersion: string;
  totalIssueCount: number;
  byStatusCategory: Record<ReleaseIssueStatusCategory, number>;
  // Every issue NOT in the 'done' category - the concrete list a Release Owner needs to actually
  // review before signing off, not just a count.
  notDoneIssues: ReleaseIssueSnapshot[];
  // true only when there is at least one issue AND every one of them is 'done' - a fixVersion with
  // zero issues is NOT reported ready (almost certainly means the fixVersion name was
  // mistyped/misconfigured, not a genuinely empty, ready release), same "don't let an empty result
  // look like a clean bill" reasoning buildReport()'s "clean-bill message" cases in this codebase
  // already apply elsewhere - surfaced explicitly via zeroIssuesFound below instead.
  readyForRelease: boolean;
  zeroIssuesFound: boolean;
}

const STATUS_CATEGORIES: ReleaseIssueStatusCategory[] = ['new', 'indeterminate', 'done', 'unknown'];

/**
 * Pure mapper: already-fetched issues (JiraClient.searchByFixVersion(), mapped via
 * mapReleaseIssue() in pipeline.ts's stageReleaseSummary()) -> this stage's own report shape.
 * Takes `now` as a parameter for the same determinism-in-tests reason as every other
 * buildXReport() pure builder in this pipeline.
 */
export function buildReleaseSummaryReport(
  fixVersion: string,
  issues: ReleaseIssueSnapshot[],
  now: Date = new Date(),
): ReleaseSummaryReport {
  const byStatusCategory = { new: 0, indeterminate: 0, done: 0, unknown: 0 } as Record<
    ReleaseIssueStatusCategory,
    number
  >;
  for (const issue of issues) byStatusCategory[issue.statusCategory] += 1;

  const notDoneIssues = issues.filter((issue) => issue.statusCategory !== 'done');
  const zeroIssuesFound = issues.length === 0;
  const readyForRelease = !zeroIssuesFound && notDoneIssues.length === 0;

  return {
    generatedAt: now.toISOString(),
    fixVersion,
    totalIssueCount: issues.length,
    byStatusCategory,
    notDoneIssues,
    readyForRelease,
    zeroIssuesFound,
  };
}

/**
 * Short, human-readable sign-off note for the AI Queue dashboard's generic payload.note summary
 * fallback (queueDashboard.mjs's summarizePayload()) - this stage deliberately does NOT get its
 * own dedicated dashboard summarizer branch the way stories/defects do, since a plain note already
 * says everything a Release Owner needs at a glance, and this stage has no "file" action to gate a
 * button on (it never writes anywhere) - a plain Approve/Reject/Dismiss is the entire sign-off UX.
 */
export function buildReleaseSignOffNote(report: ReleaseSummaryReport): string {
  if (report.zeroIssuesFound) {
    return `Release ${report.fixVersion}: 0 issues found for this fixVersion - check the name is correct before signing off.`;
  }
  if (report.readyForRelease) {
    return `Release ${report.fixVersion}: all ${report.totalIssueCount} issue(s) are Done. Ready for release sign-off.`;
  }
  return (
    `Release ${report.fixVersion}: ${report.byStatusCategory.done}/${report.totalIssueCount} issue(s) Done - ` +
    `${report.notDoneIssues.length} NOT yet Done. NOT ready for release.`
  );
}

const STATUS_CATEGORY_LABELS: Record<ReleaseIssueStatusCategory, string> = {
  new: 'To Do',
  indeterminate: 'In Progress',
  done: 'Done',
  unknown: 'Unknown',
};

function buildReleaseSummaryMarkdown(report: ReleaseSummaryReport): string {
  const lines: string[] = [
    `# Release Summary — ${report.fixVersion}`,
    '',
    `Generated: ${report.generatedAt}`,
    '',
    '**This report is read-only.** It never sets a fixVersion, transitions an issue, or triggers a ' +
      'release - it exists only to inform a real Release Owner sign-off decision, made elsewhere.',
    '',
  ];

  if (report.zeroIssuesFound) {
    lines.push(`_No issues found for fixVersion "${report.fixVersion}" - check the name is correct._`, '');
    return lines.join('\n');
  }

  lines.push(
    `- Total issues: ${report.totalIssueCount}`,
    `- Ready for release: ${report.readyForRelease ? 'YES - every issue is Done' : `NO - ${report.notDoneIssues.length} not yet Done`}`,
    '',
  );

  const statusSummary = STATUS_CATEGORIES.map(
    (category) => `${STATUS_CATEGORY_LABELS[category]}: ${report.byStatusCategory[category]}`,
  ).join(' · ');
  lines.push(`By status: ${statusSummary}`, '');

  if (report.notDoneIssues.length > 0) {
    lines.push('## Not Done', '', '| Key | Status | Summary | Assignee |', '|---|---|---|---|');
    for (const issue of report.notDoneIssues) {
      lines.push(`| ${issue.key} | ${issue.status} | ${issue.summary} | ${issue.assignee ?? '_Unassigned_'} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// fixVersion is arbitrary human text (e.g. "2026.09", "Release 1.0 (GA)"), not a filesystem-safe-
// by-construction id the way burndown-report's numeric sprint id is - so it's slugified before
// becoming part of a filename, same "don't let free text become a raw path segment" precaution as
// buildScenarioFileName() (excelWriter.ts) already applies to Jira ticket keys.
function slugifyFixVersion(fixVersion: string): string {
  return fixVersion.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}

export function RELEASE_SUMMARY_JSON_PATH(fixVersion: string): string {
  return tenantDataPath('releaseSummary', `${slugifyFixVersion(fixVersion)}.json`);
}
export function RELEASE_SUMMARY_MD_PATH(fixVersion: string): string {
  return tenantDataPath('releaseSummary', `${slugifyFixVersion(fixVersion)}.md`);
}

export function writeReleaseSummaryReports(
  report: ReleaseSummaryReport,
  paths: { reportJsonPath: string; reportMdPath: string } = {
    reportJsonPath: RELEASE_SUMMARY_JSON_PATH(report.fixVersion),
    reportMdPath: RELEASE_SUMMARY_MD_PATH(report.fixVersion),
  },
): { reportJsonPath: string; reportMdPath: string } {
  const { reportJsonPath, reportMdPath } = paths;
  fs.mkdirSync(path.dirname(reportJsonPath), { recursive: true });
  fs.writeFileSync(reportJsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
  fs.writeFileSync(reportMdPath, buildReleaseSummaryMarkdown(report), 'utf-8');
  return { reportJsonPath, reportMdPath };
}
