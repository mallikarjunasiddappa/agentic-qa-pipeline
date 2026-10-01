import fs from 'node:fs';
import path from 'node:path';
import { tenantDataPath } from '../../config/tenantContext';

export function REPORT_JSON_PATH(): string {
  return tenantDataPath('groomCheck', 'report.json');
}
export function REPORT_MD_PATH(): string {
  return tenantDataPath('groomCheck', 'report.md');
}

/**
 * Phase 2's second and final duty (backlog-groom-check), and a genuinely different shape from
 * every other stage in this module (dev-status/sprint-status/standup-digest/blocker-scan are all
 * deterministic pure-mapper-plus-real-client-call stages). This one reuses the Planning Agent's
 * existing Gate 0 clarity-judgment mechanism (requirementGate.ts/planning-agent.md), reframed per
 * ticket type ("can scenarios be generated from this" for QA tickets, "can a developer start
 * building from this" for dev tickets - Technical Document's Duty Breakdown, Section 3) - see
 * scrum-master-agent.md's own new instructions for the full duty.
 *
 * DECIDED APPROACH (Option B, not Option A - Continuity Log, Aug 22 "backlog-groom-check build
 * approach"): this is NOT a new deterministic --stage backlog-groom-check function that makes its
 * own judgment call. requirementGate.ts's buildRequirementGapComment() is a pure formatter only -
 * the actual clarity judgment happens entirely inside planning-agent's own live LLM reasoning
 * during a Claude Code/Cowork session, never a deterministic function - and this codebase has zero
 * direct-Anthropic-API-call infrastructure anywhere (no @anthropic-ai/sdk, no ANTHROPIC_API_KEY).
 * So backlog-groom-check reuses that exact same live-session mechanism rather than building a new
 * automated pipeline stage: this module only provides the two deterministic bookends - a clean
 * fetch (this file's report builder, below) and a dumb flag-poster (buildGroomCheckComment,
 * further down) - with the actual per-ticket judgment made live, by whoever (human or Cowork) is
 * running scrum-master-agent.md's new instructions, exactly mirroring Gate 0's own shape.
 *
 * QA-VS-DEV DETECTION: NOT a Jira-metadata rule, and deliberately so. Checked the real SCRUM
 * project's data before writing any of this (per instruction, rather than assuming a convention):
 * every real ticket is issue type "Task" (the full project-level issue-type list is Epic/Subtask/
 * Task/Story/Feature/Request/Bug - no dedicated QA type), no labels are set on any ticket, and no
 * components are configured at all. There is no mechanical signal in this tenant's real project
 * today that would let a deterministic rule split QA vs dev tickets - building one anyway would be
 * exactly the kind of guessed convention this project's other stages (standup-digest's no-guessed-
 * "blocked"-bucket, blocker-scan's no-status-name-matching) have already declined to ship. So the
 * ticket type/status/description this stage fetches are handed to the live judgment step as-is,
 * unfiltered - the judgment of which lens (QA, dev, or both) applies to a given ticket is made by
 * reading its actual content, the same live-judgment-not-pattern-matching principle Gate 0 itself
 * already uses for requirement clarity. If a tenant's config ever does carry a real, confirmed
 * QA/dev convention (a label scheme, a real per-type split), that becomes a future additive
 * config field to defer to - not something to speculatively build now against unconfirmed data.
 */
export interface GroomCheckTicket {
  key: string;
  summary: string;
  description: string;
  issueType: string;
  status: string;
  boardId: string;
  sprintName: string;
}

export interface GroomCheckFetchReport {
  generatedAt: string;
  boardIds: string[];
  ticketCount: number;
  tickets: GroomCheckTicket[];
}

/**
 * Pure mapper: stamps generatedAt and sorts tickets by key for deterministic output, same
 * "generatedAt defaulted to now(), overridable for tests" convention as every other buildXReport()
 * in this module. Takes already-fetched tickets rather than re-fetching anything itself -
 * pipeline.ts's stageGroomCheckFetch() owns the actual agileClient.ts/jiraClient.ts calls, same
 * pure/impure split as every other stage here.
 */
export function buildGroomCheckFetchReport(
  boardIds: string[],
  tickets: GroomCheckTicket[],
  now: Date = new Date(),
): GroomCheckFetchReport {
  const sorted = [...tickets].sort((a, b) => a.key.localeCompare(b.key));
  return {
    generatedAt: now.toISOString(),
    boardIds,
    ticketCount: sorted.length,
    tickets: sorted,
  };
}

function buildGroomCheckFetchMarkdown(report: GroomCheckFetchReport): string {
  const lines: string[] = [
    '# Backlog Groom Check - Fetch',
    '',
    `Generated: ${report.generatedAt}`,
    `Boards: ${report.boardIds.join(', ') || 'none configured'} | Tickets: ${report.ticketCount}`,
    '',
  ];

  if (report.tickets.length === 0) {
    lines.push('No tickets found in the current or an upcoming (not-yet-started) sprint.');
    return lines.join('\n');
  }

  for (const ticket of report.tickets) {
    lines.push(
      `## ${ticket.key} - ${ticket.summary}`,
      `Type: ${ticket.issueType} | Status: ${ticket.status} | Board/Sprint: ${ticket.boardId} / ${ticket.sprintName}`,
      '',
      ticket.description.length > 0 ? ticket.description : '_(no description)_',
      '',
    );
  }

  return lines.join('\n');
}

export function writeGroomCheckFetchReports(
  report: GroomCheckFetchReport,
  paths: { reportJsonPath: string; reportMdPath: string } = {
    reportJsonPath: REPORT_JSON_PATH(),
    reportMdPath: REPORT_MD_PATH(),
  },
): { reportJsonPath: string; reportMdPath: string } {
  const { reportJsonPath, reportMdPath } = paths;
  fs.mkdirSync(path.dirname(reportJsonPath), { recursive: true });
  fs.writeFileSync(reportJsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
  fs.writeFileSync(reportMdPath, buildGroomCheckFetchMarkdown(report), 'utf-8');
  return { reportJsonPath, reportMdPath };
}

/**
 * Comment posted to a Jira ticket when a live backlog-grooming pass (scrum-master-agent.md's
 * groom-check-fetch -> live judgment -> groom-check-flag flow) finds the ticket isn't clear enough
 * yet under whichever lens applies to it - "can scenarios be generated from this" for a
 * QA-shaped ticket, "can a developer start building from this" for a dev-shaped one. Deliberately
 * mirrors requirementGate.ts's buildRequirementGapComment() tone/structure closely (same kind of
 * message, a different pipeline) rather than importing it directly - this module owns its own
 * comment builder the same way blockerScan.ts owns buildBlockerEscalationComment() rather than
 * reaching into another agent's formatter, per this module's own "no cross-agent imports" rule.
 *
 * Unlike buildRequirementGapComment(), there is no override-command line here - Gate 0 is a hard
 * gate (blocks --stage excel-write until cleared or overridden); backlog-groom-check is
 * informational only, posted fire-and-log style with no manifest-recorded gate and nothing
 * downstream it blocks, the same posture blocker-scan's own escalation comment already uses.
 */
export function buildGroomCheckComment(gaps: string[]): string {
  return [
    "A backlog grooming pass found this ticket isn't clear enough yet to move forward with " +
      'confidence - here is what is missing:',
    '',
    ...gaps.map((gap) => `- ${gap}`),
    '',
    'This is informational, not a blocking gate - update the ticket with the missing detail ' +
      "whenever convenient, or disregard this if the gaps flagged here don't actually matter for " +
      'this ticket.',
  ].join('\n');
}
