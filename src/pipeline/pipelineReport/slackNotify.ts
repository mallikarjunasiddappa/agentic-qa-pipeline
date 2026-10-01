import axios from 'axios';
import { PipelineReport, REPORT_HTML_PATH } from './pipelineReport';

function pct(rate: number | null): string {
  return rate === null ? 'n/a' : `${(rate * 100).toFixed(1)}%`;
}

function usd(n: number): string {
  return `$${n.toFixed(4)}`;
}

/**
 * Pure message-building, mirroring the buildXReport() pattern used elsewhere in this project -
 * keeps the Slack payload testable without a network call. Uses Slack's Block Kit rather than
 * plain `text` so the attention flags (the part someone actually needs to act on) are visually
 * distinct from the routine metrics.
 */
export function buildSlackMessage(
  report: PipelineReport,
  publicReportUrl?: string,
): { text: string; blocks: unknown[] } {
  const hasFlags = report.attentionFlags.length > 0;
  const headline = hasFlags
    ? `:rotating_light: Pipeline report - ${report.attentionFlags.length} item${report.attentionFlags.length === 1 ? ' needs' : 's need'} attention`
    : ':white_check_mark: Pipeline report - all clear';

  const metricsText = [
    `*Cost:* ${report.cost.totalEvents} event${report.cost.totalEvents === 1 ? '' : 's'}, ${usd(report.cost.overall.totalCostUsd)}`,
    `*Healing:* ${report.healing.healed} healed / ${report.healing.escalated} escalated (rate ${pct(report.healing.healingRate)})`,
    `*Flaky:* ${report.flaky.currentlyActive} currently quarantined`,
    `*Traceability:* ${
      !report.traceability.available ? 'never checked' : report.traceability.stale ? 'stale' : 'fresh'
    }`,
  ].join('\n');

  const blocks: unknown[] = [
    { type: 'header', text: { type: 'plain_text', text: headline, emoji: true } },
    { type: 'section', text: { type: 'mrkdwn', text: metricsText } },
  ];

  if (hasFlags) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: report.attentionFlags.map((f) => `• ${f}`).join('\n') },
    });
  }

  // A bare local path (e.g. `data/default/pipelineReport/report.html`) only means something on the machine that
  // generated it - not clickable, and not useful to anyone else in the channel. When a real
  // public URL is available (set by .github/workflows/pipeline-report.yml after publishing to
  // GitHub Pages - see PIPELINE_REPORT_PUBLIC_URL in env.ts), link to that instead.
  const reportRefText = publicReportUrl
    ? `Generated ${report.generatedAt} - <${publicReportUrl}|Full report>`
    : `Generated ${report.generatedAt} - full report at \`${REPORT_HTML_PATH()}\``;
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: reportRefText }],
  });

  // `text` is Slack's required fallback/notification-preview field when `blocks` is present -
  // keep it short, the real content lives in the blocks above.
  return { text: headline, blocks };
}

/**
 * Fire-and-log, not fire-and-throw: a missing webhook or a Slack outage should never fail the
 * pipeline run that's reporting on the pipeline's own health. Callers are expected to have
 * already written the report files (writePipelineReports) before calling this - this is purely
 * the notification side effect on top of that.
 */
export async function postToSlack(
  report: PipelineReport,
  webhookUrl: string | undefined,
  publicReportUrl?: string,
): Promise<void> {
  if (!webhookUrl) {
    console.log('SLACK_WEBHOOK_URL not set - skipping Slack notification.');
    return;
  }
  try {
    await axios.post(webhookUrl, buildSlackMessage(report, publicReportUrl));
    console.log('Slack notification sent.');
  } catch (err) {
    console.warn(`Slack notification failed (report was still written): ${err instanceof Error ? err.message : String(err)}`);
  }
}
