import axios from 'axios';
import { DriftCheckResult } from './traceabilityAgent';
import { REPORT_MD_PATH } from './report';
import { SyncState } from '../types/schemas';

// Mirrors NON_SYNCED_STATES in pipelineReport.ts - kept as its own copy rather than a shared
// import, since traceability's own module is the more natural owner of "which states count as
// drifted" and pipelineReport already treats traceability as a downstream consumer (reads its
// report.json, never the other way around).
const NON_SYNCED_STATES: SyncState[] = [
  'CASE_DRIFTED',
  'TEST_DRIFTED',
  'BOTH_DRIFTED',
  'ORPHANED_CASE',
  'ORPHANED_TEST',
];

/**
 * Pure message-building, same pattern as pipelineReport/slackNotify.ts's buildSlackMessage() -
 * keeps the Slack payload testable without a network call.
 */
export function buildDriftCheckSlackMessage(
  result: DriftCheckResult,
  postedJiraComments: { jiraKey: string; entryCount: number }[],
  reportUrl?: string,
): { text: string; blocks: unknown[] } {
  const outOfSync = NON_SYNCED_STATES.reduce((sum, state) => sum + (result.counts[state] ?? 0), 0);
  const headline =
    outOfSync > 0
      ? `:rotating_light: Traceability drift check - ${outOfSync} ${outOfSync === 1 ? 'entry is' : 'entries are'} out of sync`
      : ':white_check_mark: Traceability drift check - all in sync';

  const countsText = Object.entries(result.counts)
    .map(([state, count]) => `*${state}:* ${count}`)
    .join('\n');

  const blocks: unknown[] = [
    { type: 'header', text: { type: 'plain_text', text: headline, emoji: true } },
    { type: 'section', text: { type: 'mrkdwn', text: countsText } },
  ];

  if (postedJiraComments.length > 0) {
    const commentsText = postedJiraComments
      .map(({ jiraKey, entryCount }) => `• *${jiraKey}* - ${entryCount} newly drifted ${entryCount === 1 ? 'entry' : 'entries'}`)
      .join('\n');
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `New drift flagged on Jira:\n${commentsText}` },
    });
  }

  const reportRefText = reportUrl
    ? `<${reportUrl}|Full report>`
    : `Full report at \`${REPORT_MD_PATH()}\` (run \`npm run drift:check\` to regenerate)`;
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: reportRefText }] });

  return { text: headline, blocks };
}

/**
 * Fire-and-log, not fire-and-throw - same reasoning as pipelineReport/slackNotify.ts's
 * postToSlack(): a missing webhook or a Slack outage shouldn't fail the drift-check run itself.
 */
export async function postDriftCheckToSlack(
  result: DriftCheckResult,
  postedJiraComments: { jiraKey: string; entryCount: number }[],
  webhookUrl: string | undefined,
  reportUrl?: string,
): Promise<void> {
  if (!webhookUrl) {
    console.log('DRIFT_CHECK_SLACK_WEBHOOK_URL not set - skipping Slack notification.');
    return;
  }
  try {
    await axios.post(webhookUrl, buildDriftCheckSlackMessage(result, postedJiraComments, reportUrl));
    console.log('Slack notification sent.');
  } catch (err) {
    console.warn(`Slack notification failed (drift check still completed): ${err instanceof Error ? err.message : String(err)}`);
  }
}
