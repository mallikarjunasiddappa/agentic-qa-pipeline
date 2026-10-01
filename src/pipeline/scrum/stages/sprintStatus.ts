import fs from 'node:fs';
import path from 'node:path';
import { tenantDataPath } from '../../config/tenantContext';
import { SprintInfo, SprintIssueSnapshot, SprintIssueStatusCategory } from '../agileClient';

export function REPORT_JSON_PATH(): string {
  return tenantDataPath('sprintStatus', 'report.json');
}
export function REPORT_MD_PATH(): string {
  return tenantDataPath('sprintStatus', 'report.md');
}

// Every SprintIssueStatusCategory value, in display order - used to pre-seed byStatusCategory so
// every section of the report always has all four keys present (even at 0), rather than a
// consumer having to guess which categories exist for a given sprint.
const STATUS_CATEGORIES: SprintIssueStatusCategory[] = ['new', 'indeterminate', 'done', 'unknown'];

/**
 * One board's already-fetched active sprint plus its issues - the async AgileClient calls
 * (getActiveSprints/getSprintIssues) happen in pipeline.ts's stageSprintStatus(), same
 * fetch-then-map split as devStatus.ts. A board can have more than one currently-active sprint
 * (AgileClient.getActiveSprints's own doc comment - a Kanban-with-sprints or multi-team board),
 * so this is one (boardId, sprint) pair, not one per board.
 */
export interface SprintStatusBoardSprint {
  boardId: string;
  sprint: SprintInfo;
  issues: SprintIssueSnapshot[];
}

export interface SprintStatusCategoryTotals {
  issueCount: number;
  storyPoints: number;
}

export interface SprintStatusAssigneeSummary {
  // null = unassigned, kept as its own bucket (not dropped) - same "surface it" reasoning as
  // mapSprintIssue's own assignee/assigneeEmail null-handling.
  assignee: string | null;
  issueCount: number;
  storyPoints: number;
  byStatusCategory: Record<SprintIssueStatusCategory, number>;
}

export interface SprintStatusSprintSection {
  boardId: string;
  sprint: SprintInfo;
  issues: SprintIssueSnapshot[];
  byStatusCategory: Record<SprintIssueStatusCategory, SprintStatusCategoryTotals>;
  byAssignee: SprintStatusAssigneeSummary[];
  // Sum of storyPoints across issues where it's a real number - issues with storyPoints === null
  // are excluded from the sum (not treated as 0) and counted separately below, same "null vs zero"
  // distinction SprintIssueSnapshot itself already draws.
  totalStoryPoints: number;
  unestimatedIssueCount: number;
}

export interface SprintStatusReport {
  generatedAt: string;
  // Exactly scrum.json's configured boardIds, tried in full - even a board with zero currently
  // active sprints still appears here (not silently dropped), so the report can distinguish "this
  // board has no active sprint right now" from "this board was never checked".
  boardIds: string[];
  // scrum.json's storyPointsField, echoed back - or null when the tenant hasn't configured one
  // yet. Every issue's storyPoints will be null in that case (not because nobody estimated
  // anything, but because this pipeline doesn't know which custom field to read) - surfacing the
  // field's own configured-or-not state here lets a report reader tell those two things apart,
  // rather than a wall of null values silently looking like an unestimated backlog.
  storyPointsField: string | null;
  // One entry per (board, active sprint) pair across every configured board - every active
  // sprint, not just the first one found on a board. Most boards run a single active sprint, but
  // an overlapping-sprint board (e.g. a maintenance sprint alongside a feature sprint) legitimately
  // has more than one; collapsing to "the" active sprint would silently misreport that board, same
  // "surface it, don't guess or drop it" reasoning as devStatus.ts's unlinked-activity section and
  // AgileClient.getActiveSprints's own doc comment.
  sprints: SprintStatusSprintSection[];
}

function emptyStatusCategoryTotals(): Record<SprintIssueStatusCategory, SprintStatusCategoryTotals> {
  const totals = {} as Record<SprintIssueStatusCategory, SprintStatusCategoryTotals>;
  for (const category of STATUS_CATEGORIES) totals[category] = { issueCount: 0, storyPoints: 0 };
  return totals;
}

function buildSprintSection(boardSprint: SprintStatusBoardSprint): SprintStatusSprintSection {
  const { boardId, sprint, issues } = boardSprint;

  const byStatusCategory = emptyStatusCategoryTotals();
  const byAssigneeMap = new Map<string | null, SprintStatusAssigneeSummary>();
  let totalStoryPoints = 0;
  let unestimatedIssueCount = 0;

  for (const issue of issues) {
    byStatusCategory[issue.statusCategory].issueCount += 1;
    if (issue.storyPoints !== null) {
      byStatusCategory[issue.statusCategory].storyPoints += issue.storyPoints;
      totalStoryPoints += issue.storyPoints;
    } else {
      unestimatedIssueCount += 1;
    }

    const assignee = issue.assignee;
    const existing = byAssigneeMap.get(assignee);
    const summary: SprintStatusAssigneeSummary =
      existing ?? {
        assignee,
        issueCount: 0,
        storyPoints: 0,
        byStatusCategory: { new: 0, indeterminate: 0, done: 0, unknown: 0 },
      };
    summary.issueCount += 1;
    if (issue.storyPoints !== null) summary.storyPoints += issue.storyPoints;
    summary.byStatusCategory[issue.statusCategory] += 1;
    byAssigneeMap.set(assignee, summary);
  }

  // Deterministic ordering for stable JSON/Markdown diffs across runs: named assignees
  // alphabetically first, unassigned (null) last - not sorted by volume, so re-running the report
  // with the same sprint state never reshuffles rows for no reason.
  const byAssignee = [...byAssigneeMap.values()].sort((a, b) => {
    if (a.assignee === null) return 1;
    if (b.assignee === null) return -1;
    return a.assignee.localeCompare(b.assignee);
  });

  return { boardId, sprint, issues, byStatusCategory, byAssignee, totalStoryPoints, unestimatedIssueCount };
}

/**
 * Pure mapper: already-fetched board/sprint/issue data (from AgileClient, via
 * pipeline.ts's stageSprintStatus()) -> this report's own shape. Takes `now` as a parameter for
 * the same determinism-in-tests reason as buildCostReport/buildDevStatusReport.
 */
export function buildSprintStatusReport(
  boardIds: string[],
  boardSprints: SprintStatusBoardSprint[],
  storyPointsField: string | null,
  now: Date = new Date(),
): SprintStatusReport {
  return {
    generatedAt: now.toISOString(),
    boardIds,
    storyPointsField,
    sprints: boardSprints.map(buildSprintSection),
  };
}

const STATUS_CATEGORY_LABELS: Record<SprintIssueStatusCategory, string> = {
  new: 'To Do',
  indeterminate: 'In Progress',
  done: 'Done',
  unknown: 'Unknown',
};

function buildSprintStatusReportMarkdown(report: SprintStatusReport): string {
  const lines: string[] = ['# Sprint Status Report', '', `Generated: ${report.generatedAt}`, ''];

  lines.push(`Boards checked: ${report.boardIds.length > 0 ? report.boardIds.join(', ') : '_none configured_'}`);
  lines.push(
    `Story points field: ${report.storyPointsField ?? '_not configured - every issue below is unestimated_'}`,
  );
  lines.push('');

  if (report.sprints.length === 0) {
    lines.push('_No active sprints found across the configured board(s)._', '');
    return lines.join('\n');
  }

  for (const section of report.sprints) {
    lines.push(`## Board ${section.boardId} — ${section.sprint.name} (${section.sprint.state})`, '');
    lines.push(
      `- Issues: ${section.issues.length} total, ${section.totalStoryPoints} story point(s) ` +
        `(${section.unestimatedIssueCount} unestimated)`,
    );
    const statusSummary = STATUS_CATEGORIES.map((category) => {
      const totals = section.byStatusCategory[category];
      return `${STATUS_CATEGORY_LABELS[category]}: ${totals.issueCount} (${totals.storyPoints} pts)`;
    }).join(' · ');
    lines.push(`- By status: ${statusSummary}`, '');

    lines.push('| Assignee | Issues | Points |', '|---|---|---|');
    for (const assigneeSummary of section.byAssignee) {
      const name = assigneeSummary.assignee ?? '_Unassigned_';
      lines.push(`| ${name} | ${assigneeSummary.issueCount} | ${assigneeSummary.storyPoints} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

export function writeSprintStatusReports(
  report: SprintStatusReport,
  paths: { reportJsonPath: string; reportMdPath: string } = {
    reportJsonPath: REPORT_JSON_PATH(),
    reportMdPath: REPORT_MD_PATH(),
  },
): { reportJsonPath: string; reportMdPath: string } {
  const { reportJsonPath, reportMdPath } = paths;
  fs.mkdirSync(path.dirname(reportJsonPath), { recursive: true });
  fs.writeFileSync(reportJsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
  fs.writeFileSync(reportMdPath, buildSprintStatusReportMarkdown(report), 'utf-8');
  return { reportJsonPath, reportMdPath };
}
