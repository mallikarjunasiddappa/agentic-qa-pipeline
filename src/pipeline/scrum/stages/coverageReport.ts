import fs from 'node:fs';
import path from 'node:path';
import { tenantDataPath } from '../../config/tenantContext';
import { SprintStatusSprintSection } from './sprintStatus';
import { DevStatusReport } from './devStatus';
import { findVcsActivityForTicket } from './retroNotes';
import { TraceabilityEntry, SyncState } from '../../types/schemas';

/**
 * Story/dev coverage report - not a new Phase, a new lens on data three existing pieces already
 * produce: sprint-status's per-sprint issue list (this sprint's real denominator), the
 * traceability manifest (Jira <-> TMS-case <-> test-file links, already CI-guardrailed and
 * mature), and dev-status/retro-notes' VCS correlation. Requested directly by the Primary, acting
 * as the program's own first customer, after a client meeting flagged "user stories coverage",
 * "development coverage", and "test coverage" as three of six wanted metrics (the other three -
 * test automation, burndown, skill gap - are respectively already the product, already shipped,
 * and deliberately out of scope for this PR pending more requirements).
 *
 * "USER STORIES COVERAGE" AND "TEST COVERAGE" ARE TREATED AS THE SAME METRIC HERE - a real,
 * flagged assumption, not a guess made silently. This repo has no code-coverage tooling (no nyc/
 * c8/istanbul anywhere in package.json) - the only "coverage" concept that already exists is
 * requirements-to-test-case linkage (the traceability manifest), so absent a clarification from
 * the client, both requested metrics resolve to the same number: what fraction of this sprint's
 * stories have at least one linked, traceable test case. If the client actually meant code
 * coverage (line/branch %) for either, that is a genuinely different, currently unbuilt capability
 * - revisit this assumption once real requirements land, don't quietly extend this file to cover
 * both meanings speculatively.
 *
 * COVERED VS. HEALTHY ARE DELIBERATELY SEPARATE: a story with a traceability entry is "covered"
 * even if that entry's syncState is drifted or orphaned - same honesty-over-guessing posture the
 * traceability module itself uses (drift is a real, trackable state, not treated as "no
 * coverage"). `healthyCoverageCount` additionally reports how many covered stories have EVERY
 * linked entry IN_SYNC, so a reader can tell "covered" apart from "covered and actually trustworthy
 * right now" - collapsing those into one number would hide exactly the kind of drift this whole
 * program's traceability system exists to surface.
 *
 * DEV COVERAGE REUSES retroNotes.ts's OWN CORRELATION, NOT A SECOND IMPLEMENTATION:
 * findVcsActivityForTicket() (retroNotes.ts) already matches a ticket key against a
 * DevStatusReport's pullRequests/branchesWithoutOpenPr - reused here verbatim rather than
 * re-deriving the same PR/branch-to-ticket matching a second time. A branch with no open PR yet
 * still counts as dev coverage (real work has started, even pre-review) - same "surface real
 * activity, don't wait for a formal gate" reasoning dev-status.ts's own branchesWithoutOpenPr
 * field already applies.
 *
 * devCovered IS null (NOT false) WHEN VCS ISN'T CONFIGURED FOR THIS TENANT - a ceremony-only
 * tenant (e.g. admin today) genuinely cannot answer "does this story have a PR", and reporting
 * false would misreport "checked, none found" when the real state is "never checked at all" - same
 * vcsConfigured:false distinction retro-notes-fetch's own report already draws.
 */
export function REPORT_JSON_PATH(): string {
  return tenantDataPath('coverageReport', 'report.json');
}
export function REPORT_MD_PATH(): string {
  return tenantDataPath('coverageReport', 'report.md');
}

export interface CoverageTraceabilityLink {
  externalCaseId: string;
  testFilePath: string;
  syncState: SyncState;
}

export interface StoryCoverage {
  key: string;
  summary: string;
  covered: boolean;
  healthy: boolean;
  links: CoverageTraceabilityLink[];
  // null = VCS not configured for this tenant (see this module's own header comment) - never
  // guessed as false.
  devCovered: boolean | null;
}

export interface SprintCoverageSection {
  boardId: string;
  sprintId: number;
  sprintName: string;
  stories: StoryCoverage[];
  totalStoryCount: number;
  coveredStoryCount: number;
  healthyCoverageCount: number;
  // null = VCS not configured for this tenant - both counts stay null together, never a real
  // number paired with an unconfigured denominator.
  devCoveredStoryCount: number | null;
}

export interface CoverageReport {
  generatedAt: string;
  boardIds: string[];
  vcsConfigured: boolean;
  sprints: SprintCoverageSection[];
}

/**
 * Pure: takes already-fetched sprint sections (sprintStatus.ts's own builder output, same
 * "reuse the categorization, don't re-derive it" convention burndownReport.ts established),
 * already-loaded manifest entries, and an already-built DevStatusReport (or null when this
 * tenant has no VCS configured) - no filesystem/network access itself, directly unit-testable
 * against synthetic input the same way checkTraceabilityCoverage.ts's pure functions are.
 */
export function buildCoverageReport(
  boardIds: string[],
  sprintSections: SprintStatusSprintSection[],
  manifestEntries: TraceabilityEntry[],
  devStatusReport: DevStatusReport | null,
  now: Date = new Date(),
): CoverageReport {
  const entriesByJiraKey = new Map<string, TraceabilityEntry[]>();
  for (const entry of manifestEntries) {
    const existing = entriesByJiraKey.get(entry.jiraKey);
    if (existing) existing.push(entry);
    else entriesByJiraKey.set(entry.jiraKey, [entry]);
  }

  const sprints: SprintCoverageSection[] = sprintSections.map((section) => {
    const stories: StoryCoverage[] = section.issues.map((issue) => {
      const links = (entriesByJiraKey.get(issue.key) ?? []).map((e) => ({
        externalCaseId: e.externalCaseId,
        testFilePath: e.testFilePath,
        syncState: e.syncState,
      }));
      const covered = links.length > 0;
      const healthy = covered && links.every((l) => l.syncState === 'IN_SYNC');

      let devCovered: boolean | null = null;
      if (devStatusReport) {
        const { pullRequests, branchesWithoutOpenPr } = findVcsActivityForTicket(issue.key, devStatusReport);
        devCovered = pullRequests.length > 0 || branchesWithoutOpenPr.length > 0;
      }

      return { key: issue.key, summary: issue.summary, covered, healthy, links, devCovered };
    });

    const devCoveredStoryCount = devStatusReport ? stories.filter((s) => s.devCovered).length : null;

    return {
      boardId: section.boardId,
      sprintId: section.sprint.id,
      sprintName: section.sprint.name,
      stories,
      totalStoryCount: stories.length,
      coveredStoryCount: stories.filter((s) => s.covered).length,
      healthyCoverageCount: stories.filter((s) => s.healthy).length,
      devCoveredStoryCount,
    };
  });

  return {
    generatedAt: now.toISOString(),
    boardIds,
    vcsConfigured: devStatusReport !== null,
    sprints,
  };
}

function percent(numerator: number, denominator: number): string {
  if (denominator === 0) return 'n/a';
  return `${Math.round((numerator / denominator) * 100)}%`;
}

function buildCoverageReportMarkdown(report: CoverageReport): string {
  const lines: string[] = [];
  lines.push('# Coverage Report', '', `Generated: ${report.generatedAt}`, '');
  lines.push(
    '_"User stories coverage" and "test coverage" are treated as the same metric here - the ' +
      "fraction of this sprint's stories with at least one linked, traceable test case. See this " +
      'report\'s own module header comment (coverageReport.ts) if that assumption needs revisiting._',
    '',
  );

  if (report.sprints.length === 0) {
    lines.push('No active sprints found - nothing to report.');
    return lines.join('\n');
  }

  if (!report.vcsConfigured) {
    lines.push(
      '_Development coverage: not available - this tenant has no VCS (GITHUB_REPO) configured. ' +
        'Story and test coverage below are unaffected._',
      '',
    );
  }

  for (const section of report.sprints) {
    lines.push(`## ${section.sprintName} (board ${section.boardId})`, '');
    lines.push(
      `- User stories / test coverage: ${section.coveredStoryCount}/${section.totalStoryCount} ` +
        `(${percent(section.coveredStoryCount, section.totalStoryCount)}), ` +
        `${section.healthyCoverageCount} fully in sync`,
    );
    lines.push(
      `- Development coverage: ${
        section.devCoveredStoryCount === null
          ? 'n/a (no VCS configured)'
          : `${section.devCoveredStoryCount}/${section.totalStoryCount} (${percent(section.devCoveredStoryCount, section.totalStoryCount)})`
      }`,
      '',
    );
    lines.push('| Story | Covered | Healthy | Dev activity |', '|---|---|---|---|');
    for (const story of section.stories) {
      const dev = story.devCovered === null ? 'n/a' : story.devCovered ? 'yes' : 'no';
      lines.push(
        `| ${story.key} - ${story.summary} | ${story.covered ? 'yes' : 'no'} | ${story.healthy ? 'yes' : 'no'} | ${dev} |`,
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}

export function writeCoverageReports(report: CoverageReport): { reportJsonPath: string; reportMdPath: string } {
  const reportJsonPath = REPORT_JSON_PATH();
  const reportMdPath = REPORT_MD_PATH();
  fs.mkdirSync(path.dirname(reportJsonPath), { recursive: true });
  fs.writeFileSync(reportJsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
  fs.writeFileSync(reportMdPath, buildCoverageReportMarkdown(report), 'utf-8');
  return { reportJsonPath, reportMdPath };
}
