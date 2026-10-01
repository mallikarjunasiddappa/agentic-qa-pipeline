import axios from 'axios';
import { CostReport } from './costReport';

function usd(n: number): string {
  return `$${n.toFixed(6)}`;
}

function fmtTokens(n: number): string {
  return n.toLocaleString('en-US');
}

/**
 * Pure message-building, same pattern as pipelineReport/slackNotify.ts's buildSlackMessage - keeps
 * the Slack payload testable without a network call. Deliberately its own message (not reusing
 * pipeline-report's), since that one only ever shows the aggregate cost total as a single summary
 * line - this one is either the full aggregate breakdown or one ticket's scoped breakdown
 * (report.scopedToIssue), with per-agent detail and runaway flags neither belongs to a one-line
 * summary.
 */
export function buildCostSlackMessage(report: CostReport): { text: string; blocks: unknown[] } {
  const headline = report.scopedToIssue
    ? `:receipt: Cost report — ${report.scopedToIssue}`
    : ':receipt: Cost report — all tickets';

  const totalTokens =
    report.overall.totalInputTokens +
    report.overall.totalOutputTokens +
    report.overall.totalCacheReadTokens +
    report.overall.totalCacheCreationTokens;
  const summaryText = [
    `*Total:* ${usd(report.overall.totalCostUsd)} across ${report.totalEvents} event${report.totalEvents === 1 ? '' : 's'}`,
    `*Wall-clock:* ${(report.overall.totalWallClockMs / 1000).toFixed(1)}s`,
    `*Tokens:* ${fmtTokens(totalTokens)} total (${fmtTokens(report.overall.totalInputTokens)} in / ` +
      `${fmtTokens(report.overall.totalOutputTokens)} out / ` +
      `${fmtTokens(report.overall.totalCacheReadTokens + report.overall.totalCacheCreationTokens)} cache)`,
  ].join('\n');

  const blocks: unknown[] = [
    { type: 'header', text: { type: 'plain_text', text: headline, emoji: true } },
    { type: 'section', text: { type: 'mrkdwn', text: summaryText } },
  ];

  // Per-agent breakdown, collapsed across weeks - a ticket-scoped report rarely spans more than
  // one ISO week, and even the aggregate report reads better in Slack as one line per agent than
  // as the full by-week-and-agent table the Markdown report shows.
  const totalsByAgent = new Map<
    string,
    { costUsd: number; invocations: number; inputTokens: number; outputTokens: number }
  >();
  for (const stats of report.byWeekAndAgent) {
    const existing = totalsByAgent.get(stats.agent) ?? {
      costUsd: 0,
      invocations: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
    existing.costUsd += stats.totalCostUsd;
    existing.invocations += stats.invocations;
    existing.inputTokens += stats.totalInputTokens;
    existing.outputTokens += stats.totalOutputTokens;
    totalsByAgent.set(stats.agent, existing);
  }
  if (totalsByAgent.size > 0) {
    const agentLines = [...totalsByAgent.entries()]
      .sort((a, b) => b[1].costUsd - a[1].costUsd)
      .map(
        ([agent, t]) =>
          `• *${agent}*: ${usd(t.costUsd)} (${t.invocations} invocation${t.invocations === 1 ? '' : 's'}, ` +
          `${fmtTokens(t.inputTokens)} in / ${fmtTokens(t.outputTokens)} out tokens)`,
      );
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: agentLines.join('\n') } });
  }

  if (report.runawayFlags.length > 0) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          `:rotating_light: ${report.runawayFlags.length} runaway invocation${report.runawayFlags.length === 1 ? '' : 's'} (>= 2x that agent's own median):\n` +
          report.runawayFlags
            .map((f) => `• ${f.event.agent} at ${f.event.timestamp}: ${usd(f.event.costUsd)} (${f.ratio.toFixed(1)}x median)`)
            .join('\n'),
      },
    });
  }

  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `Generated ${report.generatedAt}` }],
  });

  return { text: headline, blocks };
}

/**
 * Fire-and-log, not fire-and-throw - same contract as pipelineReport/slackNotify.ts's postToSlack
 * and traceability/slackNotify.ts: a missing webhook or a Slack outage never fails the cost-report
 * stage itself, since the report files are already written by the time this is called.
 */
export async function postCostReportToSlack(report: CostReport, webhookUrl: string | undefined): Promise<void> {
  if (!webhookUrl) {
    console.log('COST_REPORT_SLACK_WEBHOOK_URL not set - skipping Slack notification.');
    return;
  }
  try {
    await axios.post(webhookUrl, buildCostSlackMessage(report));
    console.log('Slack notification sent.');
  } catch (err) {
    console.warn(`Slack notification failed (report was still written): ${err instanceof Error ? err.message : String(err)}`);
  }
}
