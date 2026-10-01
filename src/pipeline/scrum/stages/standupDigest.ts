import fs from 'node:fs';
import path from 'node:path';
import { tenantDataPath } from '../../config/tenantContext';
import { SprintIssueSnapshot } from '../agileClient';
import { SprintStatusBoardSprint } from './sprintStatus';

export function REPORT_JSON_PATH(): string {
  return tenantDataPath('standupDigest', 'report.json');
}
export function REPORT_MD_PATH(): string {
  return tenantDataPath('standupDigest', 'report.md');
}

/**
 * DELIVERY: dm mode only (Phase 1, PR 7). scrum.json's standupDigest.channel is read and echoed
 * (see StandupDigestDeliveryConfig below) but posting to a channel is NOT implemented yet - it
 * needs a genuinely different Slack call (chat.postMessage straight to a channel, no per-person
 * lookup) than the per-assignee DM path below, and no tenant has a channel configured today.
 * planStandupDigestDelivery() always returns 'skipped-not-configured' when dm is false, even if
 * channel is set - channel delivery is a separate follow-up PR.
 *
 * The dm path was gated on the Jira account migration (personal -> company
 * account) that resolves SprintIssueSnapshot.assigneeEmail visibility - agileClient.ts's own doc
 * comment flags that Jira Cloud can omit this field entirely per-account. That migration is now
 * confirmed live, but the "surface it, don't guess" convention this whole stage follows still
 * applies to any individual assignee whose email comes back missing (e.g. an account this tenant
 * hasn't verified yet, or one with contact-info visibility set private): planStandupDigestDelivery()
 * skips that person with a clear 'skipped-no-email' outcome rather than throwing or silently
 * dropping them from the report.
 *
 * This file keeps the same pure/impure split every stage in this pipeline already uses: the
 * functions here (buildStandupDigestReport, planStandupDigestDelivery, buildAssigneeEmailMap,
 * buildStandupDigestSlackMessage) are all pure and unit-tested with node:test; the actual
 * sendTicketSummaryDm() network call happens in pipeline.ts's stageStandupDigest(), same place
 * every other stage's real client/Slack calls live (untested here, per this repo's existing
 * convention - jiraClient.ts/qaseClient.ts/vcsClient's real HTTP calls are verified manually the
 * same way). buildStandupDigestReport() itself still never reads assigneeEmail - the email lookup
 * (buildAssigneeEmailMap) is a separate function operating on the same raw fetched issues, kept
 * out of the report's own pure mapper so that function's shape and its existing tests are
 * untouched by this PR.
 */

// Every statusCategory value except 'unknown' maps to one of this digest's three buckets; unknown
// gets a fourth explicit bucket rather than being folded into one of the other three (same
// "surface it, don't guess" reasoning as SprintIssueStatusCategory's own doc comment) - a status
// Jira didn't categorize should look unusual in the digest, not quietly count as "in progress".
//
// There is deliberately no fourth "blocked" bucket here. The only data available to guess it from
// is the issue's status name (statusCategory itself only distinguishes new/indeterminate/done/
// unknown - a "Blocked" status is still bucketed as indeterminate by Jira), and a status-name
// text match would be a heuristic this pipeline has no confirmation matches how any real tenant's
// workflow actually names a blocked state. scrum.json's blockerEscalation config already reserves
// a shape for a real blocked/idle signal (idleDaysThreshold, relatedRecipients) for Phase 2's
// blocker-scan - a deliberately more rigorous, config-driven signal (idle time, not a status-name
// guess). Shipping a guessed heuristic here that Phase 2 might later contradict would be worse
// than not having the bucket yet.

export interface StandupDigestIssueEntry {
  key: string;
  summary: string;
  status: string;
  boardId: string;
  sprintName: string;
  storyPoints: number | null;
}

// The full set of delivery outcomes a single assignee's digest can end up with. 'sent' and
// 'failed' only ever come from an actual sendTicketSummaryDm() attempt (pipeline.ts) - nothing in
// this file can produce those two without really trying the Slack call, since whether it works
// genuinely can't be known in advance. The three 'skipped-*' outcomes are decided up front,
// without any network call, by planStandupDigestDelivery() below - each one is surfaced with its
// own distinct reason rather than a single generic "not sent", so a report reader can tell "nobody
// to DM" apart from "delivery is off for this tenant" apart from "we don't have this person's
// email yet".
export type StandupDigestDeliveryOutcome =
  | 'sent'
  | 'skipped-unassigned'
  | 'skipped-not-configured'
  | 'skipped-no-email'
  | 'failed';

export interface StandupDigestDeliveryStatus {
  outcome: StandupDigestDeliveryOutcome;
  detail?: string;
}

export interface StandupDigestAssigneeSummary {
  // null = unassigned, kept as its own bucket - same reasoning as sprintStatus.ts's
  // SprintStatusAssigneeSummary.assignee.
  assignee: string | null;
  notStarted: StandupDigestIssueEntry[];
  inProgress: StandupDigestIssueEntry[];
  doneThisSprint: StandupDigestIssueEntry[];
  // Issues whose statusCategory came back 'unknown' (Jira didn't return a recognized
  // statusCategory.key) - surfaced in their own bucket rather than dropped or guessed into one of
  // the other three.
  unknownStatus: StandupDigestIssueEntry[];
  totalIssueCount: number;
  // Sum of storyPoints across this assignee's issues where it's a real number - null values are
  // excluded from the sum (not treated as 0) and counted separately, same null-vs-zero
  // distinction sprintStatus.ts's totalStoryPoints/unestimatedIssueCount already draws.
  totalStoryPoints: number;
  unestimatedIssueCount: number;
  // Optional and set to undefined by buildStandupDigestReport() itself - the pure report builder
  // stays delivery-free, same as before this PR. pipeline.ts's stageStandupDigest() attaches this
  // after the pure build step, once a real delivery decision (or attempt) has been made for this
  // assignee - by the time the report is written to disk, every assignee has one. A report object
  // fresh out of buildStandupDigestReport() alone (e.g. in a test) will not.
  delivery?: StandupDigestDeliveryStatus;
}

// scrum.json's standupDigest config, echoed back verbatim for display - `channel` is read but not
// yet acted upon (see this file's header comment: channel-mode delivery is a separate follow-up
// PR). `channel` is optional in ScrumConfigSchema; normalized to null here (not undefined) so JSON
// consumers see an explicit "not configured" rather than a missing key.
export interface StandupDigestDeliveryConfig {
  dm: boolean;
  channel: string | null;
}

export interface StandupDigestReport {
  generatedAt: string;
  // Exactly scrum.json's configured boardIds, same "tried in full, never silently dropped"
  // reasoning as SprintStatusReport.boardIds.
  boardIds: string[];
  // scrum.json's storyPointsField, echoed back - or null when unconfigured, same
  // "surface unconfigured, don't guess" reasoning as SprintStatusReport.storyPointsField.
  storyPointsField: string | null;
  configuredDelivery: StandupDigestDeliveryConfig;
  // One entry per distinct assignee (plus one unassigned entry, if any unassigned issues exist)
  // across every active sprint on every configured board - not scoped to one board/sprint, since
  // a standup digest's whole point is "what is this person doing right now", not "what is
  // happening on this one board".
  assignees: StandupDigestAssigneeSummary[];
}

function toIssueEntry(
  issue: SprintIssueSnapshot,
  boardId: string,
  sprintName: string,
): StandupDigestIssueEntry {
  return {
    key: issue.key,
    summary: issue.summary,
    status: issue.status,
    boardId,
    sprintName,
    storyPoints: issue.storyPoints,
  };
}

/**
 * Pure mapper: already-fetched board/sprint/issue data (from AgileClient, via pipeline.ts's
 * stageStandupDigest() - same fetch-then-map split, and the exact same SprintStatusBoardSprint[]
 * shape, as sprintStatus.ts) -> this report's own per-assignee shape. Takes `now` as a parameter
 * for the same determinism-in-tests reason as buildSprintStatusReport/buildDevStatusReport.
 *
 * Issues from every (board, sprint) pair are flattened together before grouping by assignee - an
 * assignee working across two boards' sprints gets one combined entry here, not one per board, so
 * the digest genuinely answers "what is this person doing" rather than "what is happening on this
 * board that this person happens to touch".
 *
 * Stays delivery-free by design (see StandupDigestAssigneeSummary.delivery's own comment) - this
 * function never reads assigneeEmail and never sets `delivery`.
 */
export function buildStandupDigestReport(
  boardIds: string[],
  boardSprints: SprintStatusBoardSprint[],
  storyPointsField: string | null,
  configuredDelivery: StandupDigestDeliveryConfig,
  now: Date = new Date(),
): StandupDigestReport {
  const byAssigneeMap = new Map<string | null, StandupDigestAssigneeSummary>();

  for (const boardSprint of boardSprints) {
    const { boardId, sprint, issues } = boardSprint;
    for (const issue of issues) {
      const assignee = issue.assignee;
      const existing = byAssigneeMap.get(assignee);
      const summary: StandupDigestAssigneeSummary =
        existing ?? {
          assignee,
          notStarted: [],
          inProgress: [],
          doneThisSprint: [],
          unknownStatus: [],
          totalIssueCount: 0,
          totalStoryPoints: 0,
          unestimatedIssueCount: 0,
        };

      const entry = toIssueEntry(issue, boardId, sprint.name);
      if (issue.statusCategory === 'new') summary.notStarted.push(entry);
      else if (issue.statusCategory === 'indeterminate') summary.inProgress.push(entry);
      else if (issue.statusCategory === 'done') summary.doneThisSprint.push(entry);
      else summary.unknownStatus.push(entry);

      summary.totalIssueCount += 1;
      if (issue.storyPoints !== null) summary.totalStoryPoints += issue.storyPoints;
      else summary.unestimatedIssueCount += 1;

      byAssigneeMap.set(assignee, summary);
    }
  }

  // Deterministic ordering, same convention as sprintStatus.ts's byAssignee: named assignees
  // alphabetically first, unassigned (null) last. Each bucket's issues are sorted by key so
  // re-running the digest against unchanged sprint state never reshuffles rows for no reason.
  const assignees = [...byAssigneeMap.values()]
    .map((summary) => ({
      ...summary,
      notStarted: [...summary.notStarted].sort((a, b) => a.key.localeCompare(b.key)),
      inProgress: [...summary.inProgress].sort((a, b) => a.key.localeCompare(b.key)),
      doneThisSprint: [...summary.doneThisSprint].sort((a, b) => a.key.localeCompare(b.key)),
      unknownStatus: [...summary.unknownStatus].sort((a, b) => a.key.localeCompare(b.key)),
    }))
    .sort((a, b) => {
      if (a.assignee === null) return 1;
      if (b.assignee === null) return -1;
      return a.assignee.localeCompare(b.assignee);
    });

  return {
    generatedAt: now.toISOString(),
    boardIds,
    storyPointsField,
    configuredDelivery,
    assignees,
  };
}

/**
 * Decides, WITHOUT making any network call, whether an assignee's digest should even attempt
 * delivery - and if not, exactly which surfaced reason to record. Returns null to mean "go ahead
 * and actually try to send this one" - the caller (stageStandupDigest(), pipeline.ts) is the one
 * that makes the real Slack call and records 'sent'/'failed' itself, since this function has no
 * way to know the outcome of an attempt it never makes.
 *
 * Order matters: an unassigned bucket is always 'skipped-unassigned' regardless of config (there
 * is nobody to DM), then tenant configuration is checked (dm off -> 'skipped-not-configured', even
 * when channel is set - see this file's header comment for why channel-mode isn't wired yet), and
 * only once delivery is actually turned on for this tenant does a missing email become the
 * deciding factor ('skipped-no-email').
 */
export function planStandupDigestDelivery(
  assignee: string | null,
  configuredDelivery: StandupDigestDeliveryConfig,
  email: string | undefined,
): StandupDigestDeliveryStatus | null {
  if (assignee === null) {
    return {
      outcome: 'skipped-unassigned',
      detail: 'no Jira assignee on these issues - nobody to DM',
    };
  }

  if (!configuredDelivery.dm) {
    return {
      outcome: 'skipped-not-configured',
      detail: configuredDelivery.channel
        ? `standupDigest.dm is false in scrum.json; channel delivery ("${configuredDelivery.channel}") is not implemented yet`
        : "standupDigest.dm is false in scrum.json and no channel is configured",
    };
  }

  if (!email) {
    return {
      outcome: 'skipped-no-email',
      detail:
        'Jira returned no assigneeEmail for this assignee - possibly a private contact-information visibility setting (see agileClient.ts)',
    };
  }

  return null;
}

/**
 * Best-effort assignee -> email lookup built from the same raw issue data
 * buildStandupDigestReport() consumes - kept as its own pure, tested function rather than inline
 * in pipeline.ts. assigneeEmail is fetched per-issue, not per-person, so the same assignee could
 * in principle show up with it present on one issue and absent on another; the first email found
 * for a name is used for every one of their issues, since Slack delivery is genuinely per-person.
 * An assignee who never has an email on any of their issues simply has no entry here -
 * planStandupDigestDelivery() turns that absence into an explicit 'skipped-no-email', not a crash.
 */
export function buildAssigneeEmailMap(boardSprints: SprintStatusBoardSprint[]): Map<string, string> {
  const emails = new Map<string, string>();
  for (const { issues } of boardSprints) {
    for (const issue of issues) {
      if (issue.assignee && issue.assigneeEmail && !emails.has(issue.assignee)) {
        emails.set(issue.assignee, issue.assigneeEmail);
      }
    }
  }
  return emails;
}

function section(label: string, entries: StandupDigestIssueEntry[]): string {
  if (entries.length === 0) return `*${label}:* none`;
  return `*${label}:*\n${entries.map((e) => `  - ${e.key} - ${e.summary}`).join('\n')}`;
}

/**
 * Pure Slack message building for one assignee's digest slice - mirrors buildTicketSummaryText's
 * own split (text for console/fallback, blocks for Slack Block Kit, both built from the same data
 * so they can't drift apart). Never touches assigneeEmail and makes no network call - the caller
 * (stageStandupDigest(), pipeline.ts) is the one that resolves this assignee's email and actually
 * calls sendTicketSummaryDm() with the message this function returns.
 */
export function buildStandupDigestSlackMessage(assignee: StandupDigestAssigneeSummary): {
  text: string;
  blocks: unknown[];
} {
  const name = assignee.assignee ?? 'Unassigned';
  const headline = `:sunrise: Standup digest for ${name}`;

  const countsText =
    `*Not started:* ${assignee.notStarted.length} · ` +
    `*In progress:* ${assignee.inProgress.length} · ` +
    `*Done this sprint:* ${assignee.doneThisSprint.length}` +
    (assignee.unknownStatus.length > 0 ? ` · *Unknown status:* ${assignee.unknownStatus.length}` : '');

  const pointsText = `*Story points:* ${assignee.totalStoryPoints} (${assignee.unestimatedIssueCount} unestimated)`;

  const inProgressText = section('In progress', assignee.inProgress);
  const notStartedText = section('Not started', assignee.notStarted);
  const doneText = section('Done this sprint', assignee.doneThisSprint);

  const blocks: unknown[] = [
    { type: 'header', text: { type: 'plain_text', text: headline, emoji: true } },
    { type: 'section', text: { type: 'mrkdwn', text: `${countsText}\n${pointsText}` } },
    { type: 'section', text: { type: 'mrkdwn', text: inProgressText } },
    { type: 'section', text: { type: 'mrkdwn', text: notStartedText } },
    { type: 'section', text: { type: 'mrkdwn', text: doneText } },
  ];

  const text = [headline, countsText, pointsText, inProgressText, notStartedText, doneText].join('\n\n');
  return { text, blocks };
}

function issueLines(entries: StandupDigestIssueEntry[]): string[] {
  if (entries.length === 0) return ['  - _none_'];
  return entries.map((e) => `  - ${e.key} - ${e.summary} (${e.boardId} / ${e.sprintName})`);
}

function deliveryLine(delivery: StandupDigestDeliveryStatus | undefined): string {
  if (!delivery) return '_delivery not attempted_';
  const detail = delivery.detail ? ` - ${delivery.detail}` : '';
  return `${delivery.outcome}${detail}`;
}

function buildStandupDigestReportMarkdown(report: StandupDigestReport): string {
  const lines: string[] = ['# Standup Digest', '', `Generated: ${report.generatedAt}`, ''];

  lines.push(`Boards checked: ${report.boardIds.length > 0 ? report.boardIds.join(', ') : '_none configured_'}`);
  lines.push(
    `Story points field: ${report.storyPointsField ?? '_not configured - every issue below is unestimated_'}`,
  );
  const delivery = report.configuredDelivery;
  lines.push(
    `Configured delivery: ${
      delivery.dm
        ? 'DM each assignee'
        : delivery.channel
          ? `post to #${delivery.channel} (not implemented yet)`
          : '_not configured_'
    }`,
  );
  lines.push('');

  if (report.assignees.length === 0) {
    lines.push('_No active sprint issues found across the configured board(s)._', '');
    return lines.join('\n');
  }

  for (const a of report.assignees) {
    const name = a.assignee ?? '_Unassigned_';
    lines.push(
      `## ${name} — ${a.totalIssueCount} issue(s), ${a.totalStoryPoints} story point(s) ` +
        `(${a.unestimatedIssueCount} unestimated)`,
      '',
    );
    lines.push(`Delivery: ${deliveryLine(a.delivery)}`, '');
    lines.push(`**Not started (${a.notStarted.length}):**`, ...issueLines(a.notStarted), '');
    lines.push(`**In progress (${a.inProgress.length}):**`, ...issueLines(a.inProgress), '');
    lines.push(`**Done this sprint (${a.doneThisSprint.length}):**`, ...issueLines(a.doneThisSprint), '');
    if (a.unknownStatus.length > 0) {
      lines.push(`**Unknown status (${a.unknownStatus.length}):**`, ...issueLines(a.unknownStatus), '');
    }
  }

  return lines.join('\n');
}

export function writeStandupDigestReports(
  report: StandupDigestReport,
  paths: { reportJsonPath: string; reportMdPath: string } = {
    reportJsonPath: REPORT_JSON_PATH(),
    reportMdPath: REPORT_MD_PATH(),
  },
): { reportJsonPath: string; reportMdPath: string } {
  const { reportJsonPath, reportMdPath } = paths;
  fs.mkdirSync(path.dirname(reportJsonPath), { recursive: true });
  fs.writeFileSync(reportJsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
  fs.writeFileSync(reportMdPath, buildStandupDigestReportMarkdown(report), 'utf-8');
  return { reportJsonPath, reportMdPath };
}
