import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCostReport, buildIssueReportPaths, filterEventsByIssue, RUNAWAY_THRESHOLD_MULTIPLIER } from './costReport';
import { tenantDataPath } from '../config/tenantContext';
import type { CostEvent } from '../types/schemas';

function event(overrides: Partial<CostEvent>): CostEvent {
  return {
    timestamp: '2026-08-05T00:00:00Z', // Wednesday, ISO week 2026-W32
    agent: 'jira-agent',
    model: 'claude-sonnet-5',
    inputTokens: 2,
    outputTokens: 100,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0.01,
    wallClockMs: 5000,
    ...overrides,
  };
}

test('buildCostReport totals cost and wall-clock time across all events', () => {
  const events = [event({ costUsd: 0.01, wallClockMs: 1000 }), event({ costUsd: 0.02, wallClockMs: 2000 })];
  const report = buildCostReport(events, new Date('2026-08-05T12:00:00Z'));
  assert.equal(report.totalEvents, 2);
  assert.ok(Math.abs(report.overall.totalCostUsd - 0.03) < 1e-9);
  assert.equal(report.overall.totalWallClockMs, 3000);
});

test('buildCostReport totals tokens (input/output/cache) across all events, overall and per agent-week', () => {
  const events = [
    event({ agent: 'jira-agent', inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheCreationTokens: 2 }),
    event({ agent: 'jira-agent', inputTokens: 200, outputTokens: 80, cacheReadTokens: 0, cacheCreationTokens: 0 }),
    event({ agent: 'excel-agent', inputTokens: 5, outputTokens: 3, cacheReadTokens: 0, cacheCreationTokens: 0 }),
  ];
  const report = buildCostReport(events, new Date('2026-08-05T12:00:00Z'));

  assert.equal(report.overall.totalInputTokens, 305);
  assert.equal(report.overall.totalOutputTokens, 133);
  assert.equal(report.overall.totalCacheReadTokens, 10);
  assert.equal(report.overall.totalCacheCreationTokens, 2);

  const jiraStats = report.byWeekAndAgent.find((s) => s.agent === 'jira-agent');
  assert.equal(jiraStats?.totalInputTokens, 300);
  assert.equal(jiraStats?.totalOutputTokens, 130);
});

test('buildCostReport groups by week and agent independently', () => {
  const events = [
    event({ agent: 'jira-agent', costUsd: 0.01 }),
    event({ agent: 'excel-agent', costUsd: 0.02 }),
    event({ agent: 'jira-agent', timestamp: '2026-08-12T00:00:00Z', costUsd: 0.03 }), // next week
  ];
  const report = buildCostReport(events, new Date('2026-08-05T12:00:00Z'));
  assert.equal(report.byWeekAndAgent.length, 3);
});

test('buildCostReport flags an invocation costing >= 2x that agent\'s own median', () => {
  const events = [
    event({ agent: 'jira-agent', costUsd: 0.01 }),
    event({ agent: 'jira-agent', costUsd: 0.01 }),
    event({ agent: 'jira-agent', costUsd: 0.05 }), // 5x the median of 0.01
  ];
  const report = buildCostReport(events, new Date('2026-08-05T12:00:00Z'));
  assert.equal(report.runawayFlags.length, 1);
  assert.equal(report.runawayFlags[0].event.costUsd, 0.05);
  assert.ok(report.runawayFlags[0].ratio >= RUNAWAY_THRESHOLD_MULTIPLIER);
});

test('filterEventsByIssue keeps only events recorded against the given jiraKey', () => {
  const events = [
    event({ jiraKey: 'PROJ-1', costUsd: 0.01 }),
    event({ jiraKey: 'PROJ-2', costUsd: 0.02 }),
    event({ costUsd: 0.03 }), // no jiraKey at all - never matches any --issue filter
  ];
  const filtered = filterEventsByIssue(events, 'PROJ-1');
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].costUsd, 0.01);
});

test('buildCostReport records scopedToIssue when given, and omits it when not', () => {
  const events = [event({ jiraKey: 'PROJ-1' })];
  const scoped = buildCostReport(events, new Date('2026-08-05T12:00:00Z'), 'PROJ-1');
  assert.equal(scoped.scopedToIssue, 'PROJ-1');

  const unscoped = buildCostReport(events, new Date('2026-08-05T12:00:00Z'));
  assert.equal(unscoped.scopedToIssue, undefined);
});

test('buildIssueReportPaths slugifies the jiraKey into a safe, distinct filename', () => {
  const paths = buildIssueReportPaths('PROJ-123');
  assert.equal(paths.reportJsonPath, tenantDataPath('cost', 'report-proj-123.json'));
  assert.equal(paths.reportMdPath, tenantDataPath('cost', 'report-proj-123.md'));
});

test('buildCostReport does not flag anything when costs are all similar', () => {
  const events = [
    event({ agent: 'jira-agent', costUsd: 0.01 }),
    event({ agent: 'jira-agent', costUsd: 0.011 }),
    event({ agent: 'jira-agent', costUsd: 0.009 }),
  ];
  const report = buildCostReport(events, new Date('2026-08-05T12:00:00Z'));
  assert.deepEqual(report.runawayFlags, []);
});

test('buildCostReport judges each agent against its own median, not a cross-agent one', () => {
  const events = [
    // jira-agent: cheap and consistent
    event({ agent: 'jira-agent', costUsd: 0.001 }),
    event({ agent: 'jira-agent', costUsd: 0.001 }),
    // healer-agent: expensive but consistent - should NOT be flagged just for being pricier
    event({ agent: 'healer-agent', costUsd: 0.5 }),
    event({ agent: 'healer-agent', costUsd: 0.5 }),
  ];
  const report = buildCostReport(events, new Date('2026-08-05T12:00:00Z'));
  assert.deepEqual(report.runawayFlags, []);
});

test('buildCostReport computes week-over-week trend per agent', () => {
  const now = new Date('2026-08-12T12:00:00Z');
  const events = [
    event({ agent: 'jira-agent', timestamp: '2026-08-05T00:00:00Z', costUsd: 0.02 }), // last week
    event({ agent: 'jira-agent', timestamp: '2026-08-12T00:00:00Z', costUsd: 0.04 }), // this week
  ];
  const report = buildCostReport(events, now);
  const trend = report.trendByAgent.find((t) => t.agent === 'jira-agent')!;
  assert.equal(trend.previousWeekTotalCostUsd, 0.02);
  assert.equal(trend.currentWeekTotalCostUsd, 0.04);
  assert.ok(Math.abs(trend.deltaPct! - 100) < 1e-9);
});

test('buildCostReport reports null trend when there is no data for the previous week', () => {
  const now = new Date('2026-08-12T12:00:00Z');
  const events = [event({ agent: 'jira-agent', timestamp: '2026-08-12T00:00:00Z' })];
  const report = buildCostReport(events, now);
  const trend = report.trendByAgent.find((t) => t.agent === 'jira-agent')!;
  assert.equal(trend.previousWeekTotalCostUsd, null);
  assert.equal(trend.deltaPct, null);
});
