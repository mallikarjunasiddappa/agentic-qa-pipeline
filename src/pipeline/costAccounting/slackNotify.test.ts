import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCostSlackMessage, postCostReportToSlack } from './slackNotify';
import type { AgentWeekStats, CostReport } from './costReport';

const NOW = new Date('2026-08-08T12:00:00.000Z');

function overall(overrides: Partial<CostReport['overall']> = {}): CostReport['overall'] {
  return {
    totalCostUsd: 0,
    totalWallClockMs: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
    ...overrides,
  };
}

function weekStats(overrides: Partial<AgentWeekStats> & Pick<AgentWeekStats, 'week' | 'agent'>): AgentWeekStats {
  return {
    invocations: 0,
    totalCostUsd: 0,
    totalWallClockMs: 0,
    avgCostUsd: 0,
    medianCostUsd: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
    ...overrides,
  };
}

function baseReport(overrides: Partial<CostReport> = {}): CostReport {
  return {
    generatedAt: NOW.toISOString(),
    totalEvents: 0,
    overall: overall(),
    byWeekAndAgent: [],
    trendByAgent: [],
    runawayFlags: [],
    ...overrides,
  };
}

function blockTexts(blocks: unknown[]): string[] {
  return blocks.map((b: any) => b.text?.text ?? b.elements?.[0]?.text ?? '');
}

test('buildCostSlackMessage headlines "all tickets" when the report is not issue-scoped', () => {
  const message = buildCostSlackMessage(baseReport());
  assert.match(message.text, /all tickets/);
});

test('buildCostSlackMessage headlines the jiraKey when the report is issue-scoped', () => {
  const message = buildCostSlackMessage(baseReport({ scopedToIssue: 'PROJ-123' }));
  assert.match(message.text, /PROJ-123/);
  assert.ok(!message.text.includes('all tickets'));
});

test('buildCostSlackMessage includes total cost, wall-clock time, and tokens in the summary', () => {
  const message = buildCostSlackMessage(
    baseReport({
      totalEvents: 5,
      overall: overall({ totalCostUsd: 1.234567, totalWallClockMs: 60000, totalInputTokens: 100, totalOutputTokens: 50 }),
    }),
  );
  const texts = blockTexts(message.blocks);
  assert.ok(texts.some((t) => t.includes('5 events')));
  assert.ok(texts.some((t) => t.includes('$1.234567')));
  assert.ok(texts.some((t) => t.includes('60.0s')));
  assert.ok(texts.some((t) => t.includes('150 total') && t.includes('100 in') && t.includes('50 out')));
});

test('buildCostSlackMessage collapses byWeekAndAgent into one line per agent, sorted by cost descending', () => {
  const message = buildCostSlackMessage(
    baseReport({
      byWeekAndAgent: [
        weekStats({ week: '2026-W32', agent: 'jira-agent', invocations: 2, totalCostUsd: 0.01, totalWallClockMs: 1000, avgCostUsd: 0.005, medianCostUsd: 0.005, totalInputTokens: 10, totalOutputTokens: 5 }),
        weekStats({ week: '2026-W33', agent: 'jira-agent', invocations: 1, totalCostUsd: 0.02, totalWallClockMs: 1000, avgCostUsd: 0.02, medianCostUsd: 0.02, totalInputTokens: 20, totalOutputTokens: 8 }),
        weekStats({ week: '2026-W32', agent: 'excel-agent', invocations: 3, totalCostUsd: 0.5, totalWallClockMs: 1000, avgCostUsd: 0.166, medianCostUsd: 0.166, totalInputTokens: 300, totalOutputTokens: 150 }),
      ],
    }),
  );
  const texts = blockTexts(message.blocks);
  const agentLine = texts.find((t) => t.includes('excel-agent'));
  assert.ok(agentLine);
  // excel-agent (0.5) should be listed before jira-agent's combined 0.03 - sorted descending
  assert.ok(agentLine!.indexOf('excel-agent') < agentLine!.indexOf('jira-agent'));
  assert.ok(agentLine!.includes('$0.500000'));
  assert.ok(agentLine!.includes('300 in / 150 out tokens'));
  assert.ok(agentLine!.includes('*jira-agent*: $0.030000 (3 invocations, 30 in / 13 out tokens)'));
});

test('buildCostSlackMessage omits the per-agent block when byWeekAndAgent is empty', () => {
  const message = buildCostSlackMessage(baseReport());
  // header + summary + context = 3 blocks; no agent-breakdown or runaway-flags section
  assert.equal(message.blocks.length, 3);
});

test('buildCostSlackMessage lists runaway flags when present', () => {
  const message = buildCostSlackMessage(
    baseReport({
      runawayFlags: [
        {
          event: {
            timestamp: '2026-08-08T10:00:00.000Z',
            agent: 'jira-agent',
            model: 'claude-sonnet-5',
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            costUsd: 0.05,
            wallClockMs: 1000,
          },
          agentMedianCostUsd: 0.01,
          ratio: 5,
        },
      ],
    }),
  );
  const texts = blockTexts(message.blocks);
  assert.ok(texts.some((t) => t.includes('1 runaway invocation') && t.includes('5.0x median')));
});

test('postCostReportToSlack skips silently when no webhook URL is configured', async () => {
  await assert.doesNotReject(postCostReportToSlack(baseReport(), undefined));
});
