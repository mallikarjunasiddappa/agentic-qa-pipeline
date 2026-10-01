import fs from 'node:fs';
import path from 'node:path';
import { tenantDataPath } from '../../config/tenantContext';
import { SprintIssueStatusCategory } from '../agileClient';
import { DevStatusReport, DevStatusPullRequestEntry, DevStatusBranchEntry } from './devStatus';

export function REPORT_JSON_PATH(): string {
  return tenantDataPath('retroNotes', 'report.json');
}
export function REPORT_MD_PATH(): string {
  return tenantDataPath('retroNotes', 'report.md');
}

// Sprint retro output lives alongside burndown-report's per-sprint files, not in this stage's own
// retroNotes/ directory - the fetch report above is this stage's own working data (mirrors
// groomCheck.ts's REPORT_JSON_PATH()/REPORT_MD_PATH() convention exactly, dedicated directory,
// single file, re-generated fresh each run), but the final retro itself is deliberately written to
// the shared data/<tenantId>/scrum/ directory where burndown-<sprintId>.json/.md already live -
// confirmed with the user rather than guessed (AskUserQuestion, "retro notes destination": file
// only, data/<tenantId>/scrum/retro-<sprintId>.md, no Jira comment, no Slack post). Keyed by
// sprintId the same way burndown-report is, for the same reason: a retro is inherently a
// per-sprint artifact, not something a single combined report file can represent.
export function RETRO_NOTES_MD_PATH(sprintId: number): string {
  return tenantDataPath('scrum', `retro-${sprintId}.md`);
}

/**
 * Phase 3's second and final duty (--stage retro-notes-fetch / --stage retro-notes-post), and -
 * like backlog-groom-check before it - NOT a new deterministic stage that makes its own judgment
 * call. DECIDED APPROACH (Option B, same as groomCheck.ts - read that file's own header comment
 * first, this one does not re-litigate it): this codebase still has zero direct-Anthropic-API-call
 * infrastructure anywhere (no @anthropic-ai/sdk, no ANTHROPIC_API_KEY), and building one for
 * retro-notes specifically would re-decide that parked "how agentic should this get" question
 * piecemeal - exactly what Option B avoided for backlog-groom-check. So this module only provides
 * the two deterministic bookends - a clean fetch (this file's report builder, below) and a dumb
 * file-poster (buildRetroNotesFile, further down) - with the actual retrospective synthesis (what
 * went well, what didn't, action items) made live, by whoever (human or Cowork) is running
 * scrum-master-agent.md's own new instructions, exactly mirroring Gate 0's and backlog-groom-check's
 * shape.
 *
 * QA TELEMETRY: deliberately NOT wired in yet, confirmed with the user rather than guessed
 * (AskUserQuestion, "QA telemetry source" - selected "VCS half only, no QA telemetry yet").
 * healingReport.ts/flakyReport.ts are both ISO-week-bucketed, not sprint-scoped - correlating
 * either to "this sprint" would require a brand-new sprint-date-range filter that doesn't exist
 * anywhere in this codebase today, and traceability's drift-check data is a point-in-time
 * consistency snapshot (requirements vs scenarios vs test cases), not time-scoped at all. Wiring
 * either in here would be exactly the kind of guessed convention this project's other stages
 * (standup-digest's no-guessed-"blocked"-bucket, blocker-scan's no-status-name-matching,
 * groomCheck.ts's own QA-vs-dev detection comment) have already declined to ship. Flagged here as a
 * known, deliberate gap - a future addition once a real sprint-scoped QA signal exists, not
 * something this PR silently works around.
 *
 * VCS HALF: reuses devStatus.ts's exported buildDevStatusReport() unchanged (same repo-wide
 * PR/branch fetch as --stage dev-status) rather than re-deriving branch-to-ticket correlation - see
 * findVcsActivityForTicket() below, which simply filters that report's already ticketKey-tagged
 * arrays down to one ticket. Sprint/ticket data reuses buildSprintStatusReport()'s own per-sprint
 * SprintStatusSprintSection (same reuse-don't-re-derive pattern burndownReport.ts already
 * established for its own per-sprint categorization) rather than re-fetching/re-deriving anything
 * from agileClient.ts's raw issue shape.
 *
 * VCS IS OPTIONAL ENRICHMENT HERE, NOT A HARD REQUIREMENT - unlike --stage dev-status, whose
 * entire job is VCS reporting. This duty's real scope is sprint/ticket data with QA and/or VCS
 * telemetry layered on top; a multi-tenant SaaS product will have tenants who never connect a
 * GitHub repo at all, and retro-notes-fetch failing outright for them would be the actual bug, not
 * the correct behavior. pipeline.ts's stageRetroNotesFetch() checks vcsClient's own
 * hasVcsConfigured() before attempting any VCS fetch, and passes the result through to
 * buildRetroNotesFetchReport()'s vcsConfigured parameter below - every ticket still gets a full
 * entry either way, just with empty pullRequests/branchesWithoutOpenPr when VCS isn't configured.
 * That flag is surfaced in the report itself (not just logged to stdout), so "this tenant has no
 * VCS connected" is never confused with "this tenant's VCS genuinely has zero PR/branch activity
 * right now" when the live judgment step reads the report - the same null-vs-zero distinction
 * storyPointsField/percentComplete already draw elsewhere in this program.
 */
export interface RetroNotesTicket {
  key: string;
  summary: string;
  status: string;
  statusCategory: SprintIssueStatusCategory;
  boardId: string;
  sprintName: string;
  pullRequests: DevStatusPullRequestEntry[];
  branchesWithoutOpenPr: DevStatusBranchEntry[];
}

export interface RetroNotesFetchReport {
  generatedAt: string;
  boardIds: string[];
  ticketCount: number;
  // Count of tickets above with at least one linked PR or branch - surfaced as its own field so
  // JSON/Markdown consumers don't need to re-filter the array to answer "how much of this sprint
  // had visible VCS activity?", same "surfaced count, not re-derived by the reader" convention as
  // devStatus.ts's own unlinkedPullRequestCount.
  ticketsWithVcsActivityCount: number;
  // Whether GITHUB_REPO was actually configured for this tenant when this report was fetched (see
  // vcsClient/index.ts's hasVcsConfigured()). VCS is optional enrichment for retro-notes, so a
  // tenant without it configured still gets a full ticket list here - just with every ticket's
  // pullRequests/branchesWithoutOpenPr empty. Surfaced explicitly rather than left for a reader to
  // infer from an all-empty VCS section, so "not configured" is never confused with "configured,
  // genuinely zero activity right now".
  vcsConfigured: boolean;
  tickets: RetroNotesTicket[];
}

/**
 * Pure correlation function: filters an already-built DevStatusReport's ticketKey-tagged
 * pullRequests/branchesWithoutOpenPr arrays down to the ones matching one sprint ticket. Does not
 * call matchBranchToTicket() itself, and does not re-fetch anything - devStatus.ts already did
 * that matching once when it built the report this takes as a parameter; re-deriving it here would
 * be two implementations of the same correlation, which this module's own "each stage function
 * owns its own fetch loop" convention does not extend to duplicating pure mapping logic that
 * already lives in a reusable exported function.
 */
export function findVcsActivityForTicket(
  ticketKey: string,
  devStatusReport: DevStatusReport,
): { pullRequests: DevStatusPullRequestEntry[]; branchesWithoutOpenPr: DevStatusBranchEntry[] } {
  return {
    pullRequests: devStatusReport.pullRequests.filter((pr) => pr.ticketKey === ticketKey),
    branchesWithoutOpenPr: devStatusReport.branchesWithoutOpenPr.filter((b) => b.ticketKey === ticketKey),
  };
}

/**
 * Pure mapper: stamps generatedAt, sorts tickets by key, and computes ticketsWithVcsActivityCount
 * - same "generatedAt defaulted to now(), overridable for tests" convention as every other
 * buildXReport() in this module. Takes already-fetched/already-correlated tickets rather than
 * re-fetching or re-correlating anything itself - pipeline.ts's stageRetroNotesFetch() owns the
 * actual agileClient.ts/vcsClient calls and the findVcsActivityForTicket() correlation, same
 * pure/impure split as every other stage here.
 */
export function buildRetroNotesFetchReport(
  boardIds: string[],
  tickets: RetroNotesTicket[],
  vcsConfigured: boolean,
  now: Date = new Date(),
): RetroNotesFetchReport {
  const sorted = [...tickets].sort((a, b) => a.key.localeCompare(b.key));
  const ticketsWithVcsActivityCount = sorted.filter(
    (t) => t.pullRequests.length > 0 || t.branchesWithoutOpenPr.length > 0,
  ).length;
  return {
    generatedAt: now.toISOString(),
    boardIds,
    ticketCount: sorted.length,
    ticketsWithVcsActivityCount,
    vcsConfigured,
    tickets: sorted,
  };
}

function buildRetroNotesFetchMarkdown(report: RetroNotesFetchReport): string {
  const vcsStatusText = report.vcsConfigured
    ? `${report.ticketsWithVcsActivityCount} with linked VCS activity`
    : 'VCS not configured for this tenant - no PR/branch data below';
  const lines: string[] = [
    '# Retro Notes - Fetch',
    '',
    `Generated: ${report.generatedAt}`,
    `Boards: ${report.boardIds.join(', ') || 'none configured'} | Tickets: ${report.ticketCount} ` +
      `(${vcsStatusText})`,
    '',
  ];

  if (report.tickets.length === 0) {
    lines.push('No current-sprint tickets found.');
    return lines.join('\n');
  }

  const noVcsLine = report.vcsConfigured
    ? '_No linked VCS activity._'
    : '_VCS not configured for this tenant - not checked._';

  for (const ticket of report.tickets) {
    lines.push(
      `## ${ticket.key} - ${ticket.summary}`,
      `Status: ${ticket.status} (${ticket.statusCategory}) | Board/Sprint: ${ticket.boardId} / ${ticket.sprintName}`,
      '',
    );
    if (ticket.pullRequests.length === 0 && ticket.branchesWithoutOpenPr.length === 0) {
      lines.push(noVcsLine, '');
      continue;
    }
    for (const pr of ticket.pullRequests) {
      lines.push(`- PR [#${pr.number}](${pr.url}) "${pr.title}" (${pr.state}, review: ${pr.reviewState})`);
    }
    for (const branch of ticket.branchesWithoutOpenPr) {
      lines.push(`- Branch \`${branch.name}\` - no open PR (last commit ${branch.lastCommitDate})`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

export function writeRetroNotesFetchReports(
  report: RetroNotesFetchReport,
  paths: { reportJsonPath: string; reportMdPath: string } = {
    reportJsonPath: REPORT_JSON_PATH(),
    reportMdPath: REPORT_MD_PATH(),
  },
): { reportJsonPath: string; reportMdPath: string } {
  const { reportJsonPath, reportMdPath } = paths;
  fs.mkdirSync(path.dirname(reportJsonPath), { recursive: true });
  fs.writeFileSync(reportJsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
  fs.writeFileSync(reportMdPath, buildRetroNotesFetchMarkdown(report), 'utf-8');
  return { reportJsonPath, reportMdPath };
}

/**
 * The posting half of retro-notes - deliberately dumb, same posture as groomCheck.ts's
 * buildGroomCheckComment()/stageGroomCheckFlag(). The actual retrospective synthesis (what went
 * well, what didn't, action items) is made live, by whoever is running scrum-master-agent.md's own
 * new instructions after reading --stage retro-notes-fetch's report; this function just wraps
 * whatever notes text that live step already produced with a minimal standard header. Does NOT
 * re-fetch the sprint's name or any other Agile API data - keeping retro-notes-post fully local and
 * dependency-free, same minimal-dependency posture groomCheck.ts's own flag-poster already takes
 * (it doesn't re-fetch the ticket either, it just posts the gaps it's handed).
 */
export function buildRetroNotesFile(sprintId: number, notes: string, now: Date = new Date()): string {
  return [`# Retro Notes - Sprint ${sprintId}`, '', `Generated: ${now.toISOString()}`, '', notes].join('\n');
}

export function writeRetroNotesFile(
  sprintId: number,
  content: string,
  mdPath: string = RETRO_NOTES_MD_PATH(sprintId),
): string {
  fs.mkdirSync(path.dirname(mdPath), { recursive: true });
  fs.writeFileSync(mdPath, content, 'utf-8');
  return mdPath;
}
