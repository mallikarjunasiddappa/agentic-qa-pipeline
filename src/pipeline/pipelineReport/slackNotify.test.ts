import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSlackMessage } from './slackNotify';
import { postToSlack } from './slackNotify';
import { PipelineReport } from './pipelineReport';

const NOW = new Date('2026-08-08T12:00:00.000Z');

function baseReport(overrides: Partial<PipelineReport> = {}): PipelineReport {
  return {
    generatedAt: NOW.toISOString(),
    cost: {
      totalEvents: 0,
      overall: {
        totalCostUsd: 0,
        totalWallClockMs: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheReadTokens: 0,
        totalCacheCreationTokens: 0,
      },
      runawayFlags: [],
    },
    healing: { healed: 0, escalated: 0, passedNoHealNeeded: 0, healingRate: null, avgAttemptsToHeal: null, totalEvents: 0 },
    flaky: { currentlyActive: 0, totalQuarantinedAllTime: 0 },
    traceability: { available: false, generatedAt: null, stale: false, counts: null },
    promptVersions: { totalCommits: 0, byAgent: [] },
    attentionFlags: [],
    ...overrides,
  };
}

function blockTexts(blocks: unknown[]): string[] {
  return blocks.map((b: any) => b.text?.text ?? b.elements?.[0]?.text ?? '');
}

test('buildSlackMessage headlines "all clear" when nothing is flagged', () => {
  const message = buildSlackMessage(baseReport());
  assert.match(message.text, /all clear/);
  const header = message.blocks[0] as any;
  assert.equal(header.type, 'header');
  assert.match(header.text.text, /all clear/);
});

test('buildSlackMessage headlines the flag count and lists each flag when something needs attention', () => {
  const report = baseReport({
    attentionFlags: ['2 tests currently quarantined as flaky.', 'Healing rate is below 50% (25.0%).'],
  });
  const message = buildSlackMessage(report);
  assert.match(message.text, /2 items need attention/);

  const texts = blockTexts(message.blocks);
  assert.ok(texts.some((t) => t.includes('2 tests currently quarantined as flaky.')));
  assert.ok(texts.some((t) => t.includes('Healing rate is below 50% (25.0%).')));
});

test('buildSlackMessage singularizes "1 item" when exactly one flag is present', () => {
  const message = buildSlackMessage(baseReport({ attentionFlags: ['1 test currently quarantined as flaky.'] }));
  assert.match(message.text, /1 item needs attention/);
});

test('buildSlackMessage does not include an attention block when there are no flags', () => {
  const message = buildSlackMessage(baseReport());
  // header + metrics + context = 3 blocks; no separate attention-flags section
  assert.equal(message.blocks.length, 3);
});

test('buildSlackMessage includes key metrics in the body', () => {
  const report = baseReport({
    cost: {
      totalEvents: 5,
      overall: {
        totalCostUsd: 1.2345,
        totalWallClockMs: 60000,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheReadTokens: 0,
        totalCacheCreationTokens: 0,
      },
      runawayFlags: [],
    },
    healing: { healed: 3, escalated: 1, passedNoHealNeeded: 0, healingRate: 0.75, avgAttemptsToHeal: 1.5, totalEvents: 4 },
    flaky: { currentlyActive: 2, totalQuarantinedAllTime: 5 },
  });
  const texts = blockTexts(report ? [buildSlackMessage(report).blocks[1]] : []);
  assert.ok(texts[0].includes('5 events'));
  assert.ok(texts[0].includes('$1.2345'));
  assert.ok(texts[0].includes('3 healed'));
  assert.ok(texts[0].includes('75.0%'));
  assert.ok(texts[0].includes('2 currently quarantined'));
});

test('postToSlack skips silently when no webhook URL is configured', async () => {
  // No network call should be attempted - passing undefined must resolve cleanly.
  await assert.doesNotReject(postToSlack(baseReport(), undefined));
});

test('buildSlackMessage falls back to the local file path when no public URL is given', () => {
  const message = buildSlackMessage(baseReport());
  const context = message.blocks[message.blocks.length - 1] as any;
  assert.match(context.elements[0].text, /`data[\\/]default[\\/]pipelineReport[\\/]report\.html`/);
  assert.ok(!context.elements[0].text.includes('<http'));
});

test('buildSlackMessage links to the public URL as a real Slack link when one is provided', () => {
  const message = buildSlackMessage(baseReport(), 'https://acme.github.io/repo/report.html');
  const context = message.blocks[message.blocks.length - 1] as any;
  assert.equal(
    context.elements[0].text,
    `Generated ${NOW.toISOString()} - <https://acme.github.io/repo/report.html|Full report>`,
  );
  assert.ok(!context.elements[0].text.includes('data/default/pipelineReport/report.html'));
});
