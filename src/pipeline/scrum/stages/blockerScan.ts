import fs from 'node:fs';
import path from 'node:path';
import { tenantDataPath } from '../../config/tenantContext';
import { SprintIssueSnapshot } from '../agileClient';
import { SprintStatusBoardSprint } from './sprintStatus';

export function REPORT_JSON_PATH(): string {
  return tenantDataPath('blockerScan', 'report.json');
}
export function REPORT_MD_PATH(): string {
  return tenantDataPath('blockerScan', 'report.md');
}

/**
 * Phase 2's first WRITE stage (Jira comments, Slack messages) - everything built in Phase 0/1
 * (sprint-status/standup-digest/dev-status) only ever read Jira/GitHub or, at most, DM'd the
 * person who ran the command. blocker-scan escalates to OTHER people about a ticket they may not
 * be looking at, which is exactly the trust-boundary scrum-master-agent.md's own charter gates on
 * being "explicitly approved" - see TenantStageCapabilitiesSchema's scrumBlockerScan flag (its
 * own capability, not folded into scrumCeremony) and this stage's own manual-CLI-only wiring in
 * pipeline.ts (deliberately NOT added to scrum-ceremony-report.yml's cron in this PR - same
 * "build without the live side-effect, flip it on once tested against real data" staging as
 * standup-digest's own PR 6 -> PR 7 split).
 *
 * WHAT COUNTS AS "BLOCKED": pure idle time, not a status-name guess. An issue is flagged when its
 * statusCategory is anything other than 'done' AND its Jira `updated` timestamp is older than
 * scrum.json's blockerEscalation.idleDaysThreshold days - regardless of the issue's literal status
 * name. This is a deliberate continuation of a decision Phase 1's standup-digest PR already made:
 * that PR explicitly declined to guess a "blocked" bucket from a status-name text match (e.g.
 * anything containing "block"), reasoning that no real tenant's workflow vocabulary was confirmed
 * and a wrong guess there would be worse than not having the bucket - and pointed at THIS stage's
 * real idle-time signal as the correct answer once it existed. This is that answer.
 *
 * IDLE-DAYS CALCULATION: calendar days, not business days - see computeIdleDays(). Business-day
 * math would need new config (a weekend definition, timezone, possibly a holiday calendar) that
 * ScrumBlockerEscalationSchema does not reserve space for today; adding that is a real schema
 * change for a future PR, not something to improvise here.
 *
 * ESCALATION CHANNELS: the assignee is always notified via a Jira comment (jiraNotify.ts's
 * CommentPoster/addComment - the same mechanism drift-check already uses in production) - this is
 * not configurable per ScrumEscalationRecipientSchema's own comment ("the assignee itself is NOT a
 * field here... always notified, resolved from the ticket at blocker-scan runtime, never
 * configured"). Each configured relatedRecipient (scrum.json's blockerEscalation.relatedRecipients)
 * is additionally notified via every channel in their own `channels` array:
 *   - 'slack-dm'      - sendTicketSummaryDm() (ticketSummary/slackDm.ts), target = an email
 *                        address, same Bot API DM mechanism standup-digest's delivery already uses.
 *   - 'slack-channel'  - one tenant-wide BLOCKER_SCAN_SLACK_WEBHOOK_URL webhook, same pattern as
 *                        drift-check's/cost-report's own webhooks (traceability/slackNotify.ts).
 *                        IMPORTANT: a Slack incoming webhook is bound to one fixed channel at
 *                        creation time - a recipient's `target` is echoed into the message/report
 *                        for human context but does NOT dynamically pick a destination channel.
 *                        Every relatedRecipient configured with channel: 'slack-channel' posts to
 *                        the same physical channel that webhook was created for, regardless of
 *                        their individual `target` value. A future PR could instead route through
 *                        the Bot API's chat.postMessage(channel: target) for genuine per-recipient
 *                        routing; this PR deliberately reuses the simpler, already-established
 *                        webhook pattern instead.
 *   - 'email'          - real, provider-agnostic SMTP delivery (Real email delivery follow-on PR -
 *                        see src/pipeline/email/emailClient.ts's own header comment for the full
 *                        design), target = an email address. This is the pipeline itself sending
 *                        an email over SMTP - it has nothing to do with Jira's own native
 *                        assignment-notification emails, which are untouched and out of scope
 *                        here. Gated by the same scrumBlockerScan capability flag as 'slack-dm'/
 *                        'slack-channel' (no dedicated capability flag for email), and by
 *                        SMTP_NOTIFY_LOCAL/allowEmailNotify() the same CI-only-by-default way
 *                        'slack-channel' is gated by SLACK_NOTIFY_LOCAL/allowSlackNotify().
 * Teams still has no client anywhere in this codebase and remains explicitly out of scope
 * (ScrumEscalationChannelSchema.channel is an open string specifically so adding it later needs no
 * schema change) - assertSupportedChannel() throws a clear error for it, or any other unrecognized
 * channel value, rather than silently skipping a tenant's configured choice.
 *
 * NO CROSS-RUN DEDUP: every run re-escalates every currently-flagged issue - there is no persisted
 * "already escalated" state. Fine for this PR's manual-CLI-only scope (a human decides when to
 * run it), but a real spam risk once this is ever wired into a daily cron (a still-idle ticket
 * would get a fresh Jira comment + Slack ping every single day) - that has to be resolved as part
 * of whatever future PR adds the cron wiring, not assumed away here.
 */

// Three implemented so far - see this file's header comment for why Teams is still out of
// scope, and why 'slack-channel' doesn't dynamically route on `target`.
export type BlockerScanChannel = 'slack-dm' | 'slack-channel' | 'email';
const SUPPORTED_RECIPIENT_CHANNELS: readonly BlockerScanChannel[] = ['slack-dm', 'slack-channel', 'email'];

/**
 * Fails loud, not silently - a tenant's relatedRecipients config is admin-provisioned
 * (config/tenants/<id>/scrum.json), so a channel value blocker-scan doesn't implement is a real
 * configuration mistake (a typo, or a channel like 'teams' this codebase has no client for yet),
 * not a per-run condition to skip past. Called once, for every configured channel, before this
 * stage attempts any delivery at all - so a misconfigured tenant gets a clear error up front
 * rather than a partially-completed escalation run.
 */
export function assertSupportedChannel(channel: string): asserts channel is BlockerScanChannel {
  if (!SUPPORTED_RECIPIENT_CHANNELS.includes(channel as BlockerScanChannel)) {
    throw new Error(
      `blocker-scan: channel "${channel}" is not supported yet (only ${SUPPORTED_RECIPIENT_CHANNELS.join(', ')} ` +
        'are implemented). Teams has no client anywhere in this codebase - building one is a ' +
        'separate PR, not blocker-scan itself. Fix config/tenants/<tenantId>/scrum.json\'s ' +
        'blockerEscalation.relatedRecipients before running this stage again.',
    );
  }
}

/**
 * Calendar days between `updated` and `now`, floored - see this file's header comment for why
 * calendar (not business) days. A negative result (updated in the future - clock skew, or a test
 * fixture) is returned as-is rather than clamped to 0; it will simply never clear a positive
 * idleDaysThreshold, which is the only place this value is used.
 */
export function computeIdleDays(updated: string, now: Date): number {
  const updatedMs = new Date(updated).getTime();
  const diffMs = now.getTime() - updatedMs;
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

export type BlockerEscalationOutcome = 'sent' | 'skipped-not-configured' | 'failed';

/** One escalation delivery attempt for one flagged issue - see this file's header comment for the
 * four channels ('jira-comment' for the assignee, 'slack-dm'/'slack-channel'/'email' for related
 * recipients). Optional and unset by buildBlockerScanReport() itself (stays a pure, delivery-free
 * mapper, same convention as standupDigest.ts's own `delivery` field) - pipeline.ts's
 * stageBlockerScan() attaches these after actually attempting delivery. */
export interface BlockerEscalationAttempt {
  // 'assignee' for the always-on Jira comment, or `${role}:${identifier}` for a configured
  // relatedRecipient - human-readable, not a machine key, since this only ever appears in the
  // written report for a person to read.
  recipient: string;
  channel: 'jira-comment' | BlockerScanChannel;
  outcome: BlockerEscalationOutcome;
  detail?: string;
}

export interface BlockerScanFlaggedIssue {
  key: string;
  summary: string;
  status: string;
  statusCategory: SprintIssueSnapshot['statusCategory'];
  assignee: string | null;
  assigneeEmail?: string;
  boardId: string;
  sprintName: string;
  updated: string;
  idleDays: number;
  // See BlockerEscalationAttempt's own comment - unset until pipeline.ts's stageBlockerScan()
  // attaches real delivery outcomes after the pure build step.
  escalations?: BlockerEscalationAttempt[];
}

export interface BlockerScanReport {
  generatedAt: string;
  boardIds: string[];
  idleDaysThreshold: number;
  flaggedCount: number;
  issues: BlockerScanFlaggedIssue[];
}

/**
 * Pure report builder - identical fetch-loop shape to buildSprintStatusReport()/
 * buildStandupDigestReport() (same SprintStatusBoardSprint[] input, same reused fetch), but its
 * own filtering logic: keeps only issues whose statusCategory isn't 'done' and whose idleDays
 * (computeIdleDays) meets or exceeds idleDaysThreshold. Never reads scrum.json's
 * blockerEscalation.relatedRecipients and never attempts any delivery - purely "which issues are
 * flagged, and why" (idleDays is included per-issue so the written report itself explains every
 * inclusion, not just a pass/fail bit).
 */
export function buildBlockerScanReport(
  boardIds: string[],
  boardSprints: SprintStatusBoardSprint[],
  idleDaysThreshold: number,
  now: Date = new Date(),
): BlockerScanReport {
  const issues: BlockerScanFlaggedIssue[] = [];

  for (const { boardId, sprint, issues: sprintIssues } of boardSprints) {
    for (const issue of sprintIssues) {
      if (issue.statusCategory === 'done') continue;
      const idleDays = computeIdleDays(issue.updated, now);
      if (idleDays < idleDaysThreshold) continue;

      issues.push({
        key: issue.key,
        summary: issue.summary,
        status: issue.status,
        statusCategory: issue.statusCategory,
        assignee: issue.assignee,
        assigneeEmail: issue.assigneeEmail,
        boardId,
        sprintName: sprint.name,
        updated: issue.updated,
        idleDays,
      });
    }
  }

  // Most-idle first, then by key for stable output when idleDays ties - same "deterministic
  // ordering, not fetch order" reasoning as sprintStatus.ts/standupDigest.ts's own bucket sorts.
  issues.sort((a, b) => b.idleDays - a.idleDays || a.key.localeCompare(b.key));

  return {
    generatedAt: now.toISOString(),
    boardIds,
    idleDaysThreshold,
    flaggedCount: issues.length,
    issues,
  };
}

/**
 * Plain-text Jira comment body (jiraClient.ts's addComment converts to ADF itself, same as
 * drift-check's own buildComment() in traceability/jiraNotify.ts) - always posted for a flagged
 * issue's assignee, regardless of whether the issue is actually assigned (an unassigned idle
 * ticket still gets flagged and commented on; the comment just says so).
 */
export function buildBlockerEscalationComment(issue: BlockerScanFlaggedIssue, idleDaysThreshold: number): string {
  return [
    `This ticket has been idle for ${issue.idleDays} day(s) (no update since ${issue.updated}) - ` +
      `past the configured ${idleDaysThreshold}-day idle threshold.`,
    '',
    `Status: ${issue.status}`,
    `Assignee: ${issue.assignee ?? 'Unassigned'}`,
    '',
    'Flagged automatically by blocker-scan. This is a report only - nothing was changed on this ticket.',
  ].join('\n');
}

/**
 * Pure Slack message for a related recipient's escalation (same {text, blocks} split as every
 * other Slack message builder in this project - buildTicketSummaryText, buildDriftCheckSlackMessage,
 * buildStandupDigestSlackMessage). One message per flagged issue, reused as-is for every
 * relatedRecipient/channel this issue escalates to - not personalized per recipient, since the
 * content (which ticket, how idle, who's assigned) is the same regardless of who's reading it.
 */
export function buildBlockerEscalationSlackMessage(
  issue: BlockerScanFlaggedIssue,
  idleDaysThreshold: number,
): { text: string; blocks: unknown[] } {
  const headline = `:hourglass_flowing_sand: ${issue.key} has been idle for ${issue.idleDays} day(s)`;
  const bodyText =
    `*Summary:* ${issue.summary}\n` +
    `*Status:* ${issue.status}\n` +
    `*Assignee:* ${issue.assignee ?? 'Unassigned'}\n` +
    `*Last updated:* ${issue.updated}\n` +
    `*Idle threshold:* ${idleDaysThreshold} day(s)`;

  const blocks: unknown[] = [
    { type: 'header', text: { type: 'plain_text', text: headline, emoji: true } },
    { type: 'section', text: { type: 'mrkdwn', text: bodyText } },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: 'Flagged automatically by blocker-scan - report only, nothing changed on the ticket.' }],
    },
  ];

  return { text: `${headline}\n${bodyText}`, blocks };
}

function escalationLines(escalations: BlockerEscalationAttempt[] | undefined): string[] {
  if (!escalations || escalations.length === 0) return ['  - _escalation not attempted_'];
  return escalations.map((e) => `  - ${e.recipient} (${e.channel}): ${e.outcome}${e.detail ? ` - ${e.detail}` : ''}`);
}

function buildBlockerScanReportMarkdown(report: BlockerScanReport): string {
  const lines: string[] = ['# Blocker Scan', '', `Generated: ${report.generatedAt}`, ''];
  lines.push(
    `Boards: ${report.boardIds.join(', ') || 'none configured'} | ` +
      `Idle threshold: ${report.idleDaysThreshold} day(s) | Flagged: ${report.flaggedCount}`,
    '',
  );

  if (report.issues.length === 0) {
    lines.push('No idle issues past the configured threshold.');
    return lines.join('\n');
  }

  for (const issue of report.issues) {
    lines.push(
      `## ${issue.key} - ${issue.summary}`,
      `Status: ${issue.status} | Assignee: ${issue.assignee ?? 'Unassigned'} | ` +
        `Idle: ${issue.idleDays} day(s) (updated ${issue.updated}) | Board/Sprint: ${issue.boardId} / ${issue.sprintName}`,
      '',
      'Escalations:',
      ...escalationLines(issue.escalations),
      '',
    );
  }

  return lines.join('\n');
}

export function writeBlockerScanReports(
  report: BlockerScanReport,
  paths: { reportJsonPath: string; reportMdPath: string } = {
    reportJsonPath: REPORT_JSON_PATH(),
    reportMdPath: REPORT_MD_PATH(),
  },
): { reportJsonPath: string; reportMdPath: string } {
  const { reportJsonPath, reportMdPath } = paths;
  fs.mkdirSync(path.dirname(reportJsonPath), { recursive: true });
  fs.writeFileSync(reportJsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
  fs.writeFileSync(reportMdPath, buildBlockerScanReportMarkdown(report), 'utf-8');
  return { reportJsonPath, reportMdPath };
}
