import fs from 'node:fs';
import path from 'node:path';
import { tenantDataPath } from '../../config/tenantContext';
import { SprintInfo, SprintIssueStatusCategory } from '../agileClient';
import { SprintStatusSprintSection, SprintStatusCategoryTotals } from './sprintStatus';

/**
 * Phase 3's first duty, and the smallest of the two Phase 3 PRs (retro-notes, not yet built, is
 * expected to be the agent-reasoning one - this one is fully deterministic, no design forks).
 *
 * WHAT THIS IS NOT: a historical, day-by-day burndown chart, or a real committed-vs-actual trend
 * line. See agileClient.ts's own header comment - the committed/completed/carried-over deltas
 * Jira's own UI shows live come from an undocumented/deprecated Greenhopper endpoint this project
 * does not depend on, and sprint-status's README subsection already tells readers "not a burndown/
 * velocity view - see Phase 3" pointing here. This stage does not reach for that endpoint, and
 * does not persist day-over-day snapshots to approximate one either - both would be a real design
 * fork this PR was explicitly told not to take on. What it IS: the same current-sprint snapshot
 * sprint-status already fetches (agileClient.ts, completely unchanged - no new client method),
 * reshaped into a completed/remaining-work view for each currently active sprint - the honest
 * "how much of this sprint's work is done right now" signal the public Agile REST API can
 * actually support, surfaced plainly rather than faked into looking like a real trend chart.
 *
 * REUSES sprintStatus.ts'S OWN CATEGORIZATION, DOES NOT RE-DERIVE IT: buildBurndownSprintReport()
 * below takes a SprintStatusSprintSection (sprintStatus.ts's own per-(board,sprint) pure builder
 * output - byStatusCategory/totalStoryPoints/unestimatedIssueCount already computed there) and
 * reshapes it into a burndown view, rather than re-summing raw issues a second time. This keeps
 * "how do we bucket an issue's status category and sum its points" as exactly one implementation
 * in this module, not two now that a second stage needs it - stageBurndownReport() (pipeline.ts)
 * still owns its own fetch loop, same "each stage function owns its own fetch calls" convention
 * standup-digest's header comment already establishes, but calls buildSprintStatusReport() (an
 * already-exported pure function) to get each section rather than hand-rolling the same math.
 *
 * ONE FILE PER (BOARD, ACTIVE SPRINT) PAIR, NOT ONE COMBINED REPORT: unlike sprint-status's single
 * report.json holding every section, burndown-report writes data/<tenantId>/scrum/
 * burndown-<sprintId>.json/.md - one pair per sprint. This is a deliberate, spec'd departure from
 * the data/<tenantId>/<stageName>/report.json convention every earlier stage's static
 * REPORT_JSON_PATH()/REPORT_MD_PATH() helper follows, since a burndown is inherently a
 * per-sprint artifact (a combined multi-sprint file would force a reader to know which section is
 * "their" sprint) - same "give the real per-scope file its own path" reasoning as cost-report's
 * own buildIssueReportPaths() for a --issue-scoped run, just keyed by sprint id (numeric, globally
 * unique, filesystem-safe by construction - no slugifying needed) instead of a Jira issue key.
 * Lives under the shared scrum/ directory (not a burndownReport/ directory of its own), per this
 * duty's own spec.
 *
 * storyPointsField UNCONFIGURED IS SURFACED, NOT GUESSED: same as sprint-status,
 * ScrumConfigSchema's storyPointsField being unset means every issue's storyPoints comes back
 * null and totalStoryPoints/completedStoryPoints/remainingStoryPoints are all 0 - but
 * percentComplete stays null (not 0%) in that case, so a reader can tell "this tenant hasn't
 * configured a story-points field" apart from "this sprint is genuinely at 0% points-complete."
 */

export function BURNDOWN_JSON_PATH(sprintId: number): string {
  return tenantDataPath('scrum', `burndown-${sprintId}.json`);
}
export function BURNDOWN_MD_PATH(sprintId: number): string {
  return tenantDataPath('scrum', `burndown-${sprintId}.md`);
}

export interface BurndownSprintReport {
  generatedAt: string;
  boardId: string;
  sprint: SprintInfo;
  storyPointsField: string | null;
  totalIssueCount: number;
  totalStoryPoints: number;
  completedIssueCount: number;
  completedStoryPoints: number;
  remainingIssueCount: number;
  remainingStoryPoints: number;
  unestimatedIssueCount: number;
  // null when storyPointsField is unconfigured, or when this sprint has 0 total story points -
  // see this file's header comment for why that's null, not 0/100%.
  percentComplete: number | null;
  // Echoed straight from the SprintStatusSprintSection this was built from - same four-category
  // breakdown sprint-status's own report already surfaces, so a burndown reader gets the "why" (a
  // still-open ticket's actual status) alongside the completed/remaining headline numbers above.
  byStatusCategory: Record<SprintIssueStatusCategory, SprintStatusCategoryTotals>;
}

/**
 * Pure mapper: one already-built SprintStatusSprintSection (sprintStatus.ts's own per-sprint
 * output - see this file's header comment for why that's reused rather than re-derived) plus the
 * tenant's storyPointsField -> this stage's own completed/remaining burndown shape. Takes `now`
 * as a parameter for the same determinism-in-tests reason as buildSprintStatusReport/
 * buildDevStatusReport.
 */
export function buildBurndownSprintReport(
  section: SprintStatusSprintSection,
  storyPointsField: string | null,
  now: Date = new Date(),
): BurndownSprintReport {
  const done = section.byStatusCategory.done;
  const totalIssueCount = section.issues.length;
  const completedIssueCount = done.issueCount;
  const completedStoryPoints = done.storyPoints;
  const remainingIssueCount = totalIssueCount - completedIssueCount;
  const remainingStoryPoints = section.totalStoryPoints - completedStoryPoints;
  const percentComplete =
    storyPointsField !== null && section.totalStoryPoints > 0
      ? completedStoryPoints / section.totalStoryPoints
      : null;

  return {
    generatedAt: now.toISOString(),
    boardId: section.boardId,
    sprint: section.sprint,
    storyPointsField,
    totalIssueCount,
    totalStoryPoints: section.totalStoryPoints,
    completedIssueCount,
    completedStoryPoints,
    remainingIssueCount,
    remainingStoryPoints,
    unestimatedIssueCount: section.unestimatedIssueCount,
    percentComplete,
    byStatusCategory: section.byStatusCategory,
  };
}

const STATUS_CATEGORIES: SprintIssueStatusCategory[] = ['new', 'indeterminate', 'done', 'unknown'];
const STATUS_CATEGORY_LABELS: Record<SprintIssueStatusCategory, string> = {
  new: 'To Do',
  indeterminate: 'In Progress',
  done: 'Done',
  unknown: 'Unknown',
};

function buildBurndownReportMarkdown(report: BurndownSprintReport): string {
  const lines: string[] = [
    `# Burndown Report — ${report.sprint.name}`,
    '',
    `Generated: ${report.generatedAt}`,
    `Board: ${report.boardId} | Sprint: ${report.sprint.name} (${report.sprint.state}) | id ${report.sprint.id}`,
    '',
  ];

  lines.push(
    `Story points field: ${report.storyPointsField ?? '_not configured - every figure below is unestimated_'}`,
    '',
  );

  const percentText =
    report.percentComplete === null ? '_not available_' : `${Math.round(report.percentComplete * 100)}%`;
  lines.push(
    `- Total: ${report.totalIssueCount} issue(s), ${report.totalStoryPoints} story point(s) ` +
      `(${report.unestimatedIssueCount} unestimated)`,
    `- Completed: ${report.completedIssueCount} issue(s), ${report.completedStoryPoints} story point(s)`,
    `- Remaining: ${report.remainingIssueCount} issue(s), ${report.remainingStoryPoints} story point(s)`,
    `- Percent complete (by story points): ${percentText}`,
    '',
  );

  const statusSummary = STATUS_CATEGORIES.map((category) => {
    const totals = report.byStatusCategory[category];
    return `${STATUS_CATEGORY_LABELS[category]}: ${totals.issueCount} (${totals.storyPoints} pts)`;
  }).join(' · ');
  lines.push(`By status: ${statusSummary}`, '');

  return lines.join('\n');
}

export function writeBurndownReports(
  report: BurndownSprintReport,
  paths: { reportJsonPath: string; reportMdPath: string } = {
    reportJsonPath: BURNDOWN_JSON_PATH(report.sprint.id),
    reportMdPath: BURNDOWN_MD_PATH(report.sprint.id),
  },
): { reportJsonPath: string; reportMdPath: string } {
  const { reportJsonPath, reportMdPath } = paths;
  fs.mkdirSync(path.dirname(reportJsonPath), { recursive: true });
  fs.writeFileSync(reportJsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
  fs.writeFileSync(reportMdPath, buildBurndownReportMarkdown(report), 'utf-8');
  return { reportJsonPath, reportMdPath };
}
