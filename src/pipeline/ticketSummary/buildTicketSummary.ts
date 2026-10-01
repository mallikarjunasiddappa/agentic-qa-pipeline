import { TicketSummaryData } from './gatherTicketSummary';
import { tenantDataPath } from '../config/tenantContext';

function gateLine(label: string, at: string | undefined, by?: string): string {
  if (!at) return `- ${label}: not recorded`;
  const attribution = by ? ` (by ${by})` : '';
  return `- ${label}: ${at}${attribution}`;
}

/**
 * Pure message-building, mirroring buildSlackMessage (pipelineReport/slackNotify.ts) and
 * buildDriftCheckSlackMessage (traceability/slackNotify.ts) - keeps the Slack payload testable
 * without a network call, and keeps `text` (the console/fallback rendering) and `blocks` (Slack
 * Block Kit) built from the same data so they can never drift apart.
 */
export function buildTicketSummaryText(data: TicketSummaryData): { text: string; blocks: unknown[] } {
  const title = data.jiraSummary ? `${data.jiraKey} - ${data.jiraSummary}` : data.jiraKey;
  const headline = `:clipboard: Ticket summary - ${title}`;

  const gatesText = [
    gateLine('Gate 0 (requirements cleared)', data.gate0ClearedAt),
    gateLine('Gate 1 (scenarios approved)', data.gate1ApprovedAt, data.gate1ApprovedBy),
    gateLine('Gate 2 (test cases approved)', data.gate2ApprovedAt, data.gate2ApprovedBy),
  ].join('\n');

  const tmsText = data.runId
    ? `*TMS:* ${data.tmsProvider ?? 'unknown provider'}, run ${data.runId}, ` +
      `${data.externalCaseIds.length} case${data.externalCaseIds.length === 1 ? '' : 's'} ` +
      `(${data.externalCaseIds.join(', ')})`
    : `*TMS:* no run recorded yet for ${data.jiraKey} (run --stage tms-upload first)`;

  const testsText =
    data.testFilePaths.length > 0
      ? `*Tests (${data.testFilePaths.length}):*\n${data.testFilePaths.map((f) => `  - ${f}`).join('\n')}`
      : `*Tests:* none recorded in ${tenantDataPath('traceability', 'manifest.json')} yet`;

  const { total, passedNoHealNeeded, healed, escalated } = data.healing;
  const healingText =
    total > 0
      ? `*Run/heal:* ${passedNoHealNeeded} passed clean / ${healed} healed / ${escalated} escalated ` +
        `(${total} event${total === 1 ? '' : 's'})`
      : '*Run/heal:* no events recorded yet';

  const blocks: unknown[] = [
    { type: 'header', text: { type: 'plain_text', text: headline, emoji: true } },
    { type: 'section', text: { type: 'mrkdwn', text: gatesText } },
    { type: 'section', text: { type: 'mrkdwn', text: tmsText } },
    { type: 'section', text: { type: 'mrkdwn', text: healingText } },
    { type: 'section', text: { type: 'mrkdwn', text: testsText } },
  ];

  const text = [headline, gatesText, tmsText, healingText, testsText].join('\n\n');
  return { text, blocks };
}
