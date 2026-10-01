import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildPipelineReport,
  buildReportHtml,
  deriveSiteRoot,
  readTraceabilitySummary,
  writeSubReportPages,
} from './pipelineReport';
import { tenantDataPath } from '../config/tenantContext';
import { CostReport } from '../costAccounting/costReport';
import { HealingReport } from '../telemetry/healingReport';
import { FlakyReport } from '../flaky/flakyReport';
import { PromptVersionReport } from '../promptVersions/buildChangelog';

const NOW = new Date('2026-08-08T12:00:00.000Z');

function emptyCost(overrides: Partial<CostReport> = {}): CostReport {
  return {
    generatedAt: NOW.toISOString(),
    totalEvents: 0,
    overall: {
      totalCostUsd: 0,
      totalWallClockMs: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
    },
    byWeekAndAgent: [],
    trendByAgent: [],
    runawayFlags: [],
    ...overrides,
  };
}

function emptyHealing(overrides: Partial<HealingReport> = {}): HealingReport {
  return {
    generatedAt: NOW.toISOString(),
    totalEvents: 0,
    overall: {
      healed: 0,
      escalated: 0,
      passedNoHealNeeded: 0,
      healingRate: null,
      avgAttemptsToHeal: null,
    },
    byWeekAndSuite: [],
    trendBySuite: [],
    ...overrides,
  };
}

function emptyFlaky(overrides: Partial<FlakyReport> = {}): FlakyReport {
  return {
    generatedAt: NOW.toISOString(),
    totalQuarantinedAllTime: 0,
    currentlyActive: 0,
    breakdownBySuite: [],
    avgRunsToDetect: null,
    ...overrides,
  };
}

function emptyPromptVersions(): PromptVersionReport {
  return { generatedAt: NOW.toISOString(), agents: [{ agentFile: 'jira-agent.md', commits: [] }] };
}

test('buildPipelineReport flags nothing when everything is clean', () => {
  const report = buildPipelineReport(
    emptyCost(),
    emptyHealing(),
    emptyFlaky(),
    emptyPromptVersions(),
    { available: true, generatedAt: NOW.toISOString(), stale: false, counts: { IN_SYNC: 6 } as any },
    NOW,
  );
  assert.deepEqual(report.attentionFlags, []);
});

test('buildPipelineReport flags a runaway cost invocation', () => {
  const report = buildPipelineReport(
    emptyCost({
      runawayFlags: [{ event: { agent: 'x' } as any, agentMedianCostUsd: 0.01, ratio: 3 }],
    }),
    emptyHealing(),
    emptyFlaky(),
    emptyPromptVersions(),
    { available: false, generatedAt: null, stale: false, counts: null },
    NOW,
  );
  assert.equal(report.attentionFlags.some((f) => f.includes('runaway cost')), true);
});

test('buildPipelineReport flags a healing rate below 50%', () => {
  const report = buildPipelineReport(
    emptyCost(),
    emptyHealing({ overall: { healed: 1, escalated: 3, passedNoHealNeeded: 0, healingRate: 0.25, avgAttemptsToHeal: 2 } }),
    emptyFlaky(),
    emptyPromptVersions(),
    { available: false, generatedAt: null, stale: false, counts: null },
    NOW,
  );
  assert.equal(report.attentionFlags.some((f) => f.includes('Healing rate')), true);
});

test('buildPipelineReport flags active flaky quarantine', () => {
  const report = buildPipelineReport(
    emptyCost(),
    emptyHealing(),
    emptyFlaky({ currentlyActive: 2 }),
    emptyPromptVersions(),
    { available: false, generatedAt: null, stale: false, counts: null },
    NOW,
  );
  assert.equal(report.attentionFlags.some((f) => f.includes('2 tests currently quarantined')), true);
});

test('buildPipelineReport flags missing traceability data distinctly from stale data', () => {
  const missing = buildPipelineReport(
    emptyCost(), emptyHealing(), emptyFlaky(), emptyPromptVersions(),
    { available: false, generatedAt: null, stale: false, counts: null },
    NOW,
  );
  assert.equal(missing.attentionFlags.some((f) => f.includes('never been checked')), true);

  const stale = buildPipelineReport(
    emptyCost(), emptyHealing(), emptyFlaky(), emptyPromptVersions(),
    { available: true, generatedAt: '2020-01-01T00:00:00.000Z', stale: true, counts: { IN_SYNC: 1 } as any },
    NOW,
  );
  assert.equal(stale.attentionFlags.some((f) => f.includes('stale')), true);
});

test('buildPipelineReport flags out-of-sync traceability entries when fresh but not IN_SYNC', () => {
  const report = buildPipelineReport(
    emptyCost(), emptyHealing(), emptyFlaky(), emptyPromptVersions(),
    {
      available: true,
      generatedAt: NOW.toISOString(),
      stale: false,
      counts: { IN_SYNC: 4, CASE_DRIFTED: 2, TEST_DRIFTED: 0, BOTH_DRIFTED: 0, ORPHANED_CASE: 0, ORPHANED_TEST: 0 } as any,
    },
    NOW,
  );
  assert.equal(report.attentionFlags.some((f) => f.includes('2 traceability entries are out of sync')), true);
});

test('buildPipelineReport sums prompt version commits across agents', () => {
  const report = buildPipelineReport(
    emptyCost(), emptyHealing(), emptyFlaky(),
    {
      generatedAt: NOW.toISOString(),
      agents: [
        { agentFile: 'jira-agent.md', commits: [{}, {}] as any },
        { agentFile: 'tms-agent.md', commits: [{}] as any },
      ],
    },
    { available: false, generatedAt: null, stale: false, counts: null },
    NOW,
  );
  assert.equal(report.promptVersions.totalCommits, 3);
  assert.deepEqual(report.promptVersions.byAgent, [
    { agentFile: 'jira-agent.md', commitCount: 2 },
    { agentFile: 'tms-agent.md', commitCount: 1 },
  ]);
});

test('readTraceabilitySummary returns unavailable when the report file does not exist', () => {
  const missingPath = path.join(os.tmpdir(), `no-such-report-${Date.now()}.json`);
  const summary = readTraceabilitySummary(missingPath, NOW);
  assert.deepEqual(summary, { available: false, generatedAt: null, stale: false, counts: null });
});

test('readTraceabilitySummary flags stale when older than the threshold, fresh otherwise', () => {
  const tmpPath = path.join(os.tmpdir(), `traceability-report-${Date.now()}.json`);
  fs.writeFileSync(
    tmpPath,
    JSON.stringify({ generatedAt: '2026-08-06T00:00:00.000Z', counts: { IN_SYNC: 1 } }),
    'utf-8',
  );
  try {
    const stale = readTraceabilitySummary(tmpPath, NOW); // ~2 days before NOW
    assert.equal(stale.available, true);
    assert.equal(stale.stale, true);

    const fresh = readTraceabilitySummary(tmpPath, new Date('2026-08-06T05:00:00.000Z')); // 5h later
    assert.equal(fresh.stale, false);
  } finally {
    fs.unlinkSync(tmpPath);
  }
});

test('buildReportHtml uses relative sub-links when no source base URL is given', () => {
  const report = buildPipelineReport(
    emptyCost(), emptyHealing(), emptyFlaky(), emptyPromptVersions(),
    { available: false, generatedAt: null, stale: false, counts: null },
    NOW,
  );
  const html = buildReportHtml(report);
  assert.match(html, /href="\.\.\/cost\/report\.md"/);
  assert.match(html, /href="\.\.\/healing\/report\.md"/);
  assert.match(html, /href="\.\.\/flaky\/report\.md"/);
  assert.match(html, /href="\.\.\/traceability\/report\.md"/);
  assert.match(html, /href="\.\.\/promptVersions\/report\.md"/);
});

test('buildReportHtml links sub-reports to the self-hosted HTML pages when a public site root is given', () => {
  const report = buildPipelineReport(
    emptyCost(), emptyHealing(), emptyFlaky(), emptyPromptVersions(),
    { available: false, generatedAt: null, stale: false, counts: null },
    NOW,
  );
  const html = buildReportHtml(report, 'https://your-org.github.io/agentic-qa-pipeline');
  assert.match(html, /href="https:\/\/your-org\.github\.io\/agentic-qa-pipeline\/cost\/report\.html"/);
  assert.match(
    html,
    /href="https:\/\/your-org\.github\.io\/agentic-qa-pipeline\/promptVersions\/report\.html"/,
  );
  // No leftover relative paths, and no .md links, once a public site root is provided.
  assert.doesNotMatch(html, /href="\.\.\//);
  assert.doesNotMatch(html, /report\.md"/);
});

test('deriveSiteRoot strips the /report.html suffix from the public URL, passes through unset', () => {
  assert.equal(
    deriveSiteRoot('https://your-org.github.io/agentic-qa-pipeline/report.html'),
    'https://your-org.github.io/agentic-qa-pipeline',
  );
  assert.equal(deriveSiteRoot(undefined), undefined);
});

test('writeSubReportPages writes an HTML sibling for each domain with an existing report.md, skips the rest', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-report-pages-'));
  const originalCwd = process.cwd();
  process.chdir(tmpDir);
  try {
    const costDir = tenantDataPath('cost');
    fs.mkdirSync(costDir, { recursive: true });
    fs.writeFileSync(path.join(costDir, 'report.md'), '# Cost & Latency Report\n\n- Total events: 3\n', 'utf-8');
    // healing/, flaky/, traceability/, promptVersions/ deliberately left absent.

    const written = writeSubReportPages();

    assert.deepEqual(written, [tenantDataPath('cost', 'report.html')]);
    assert.equal(fs.existsSync(tenantDataPath('cost', 'report.html')), true);
    assert.equal(fs.existsSync(tenantDataPath('healing', 'report.html')), false);
    const html = fs.readFileSync(tenantDataPath('cost', 'report.html'), 'utf-8');
    assert.match(html, /<h1>Cost &amp; Latency Report<\/h1>/);
    assert.match(html, /<li>Total events: 3<\/li>/);
    assert.match(html, /href="\.\.\/report\.html"/); // back-link to the dashboard
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
