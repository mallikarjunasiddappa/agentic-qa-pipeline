import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, renderReportMarkdown, NOT_CHECKED, type BuildReportInput } from './buildReport';
import type { SuiteCaseRecord } from './classify';
import type { TestAssertionAnalysis } from './detectUnfailableAssertions';
import type { RiskScore } from './riskWeight';

const NOW = new Date('2026-08-30T09:00:00.000Z');

function record(overrides: Partial<SuiteCaseRecord> = {}): SuiteCaseRecord {
  return {
    caseId: 'C-1',
    title: 'Checkout total is correct',
    riskBand: 'high',
    assertion: { hasAutomation: true, cannotFail: false },
    suppression: null,
    traceability: 'IN_SYNC',
    duplicateOfCaseIds: [],
    execution: { totalRuns: 10, failedRuns: 1, lastRunAt: '2026-08-29T00:00:00.000Z' },
    ...overrides,
  };
}

function score(caseId: string, value: number): RiskScore {
  return {
    caseId,
    score: value,
    band: 'high',
    factors: { area: 3, blastRadius: 1, frequency: 1 },
    matchedAreas: ['payments'],
    areaConfigured: true,
  };
}

function analysis(overrides: Partial<TestAssertionAnalysis> = {}): TestAssertionAnalysis {
  return {
    filePath: 'tests/checkout.spec.ts',
    title: 'checkout total is correct',
    bodyStartLine: 3,
    isSkipped: false,
    isFixme: false,
    assertion: { hasAutomation: true, cannotFail: true, cannotFailReason: 'all-assertions-tautological' },
    weakOnly: false,
    evidence: ['line 4: expect(true).toBe(true)'],
    ...overrides,
  };
}

function input(overrides: Partial<BuildReportInput> = {}): BuildReportInput {
  return {
    records: [record()],
    riskScores: [score('C-1', 3)],
    analysisByCaseId: {},
    duplicatePairs: [],
    warnings: [],
    unlinkedTests: [],
    now: NOW,
    ...overrides,
  };
}

// --- the headline -----------------------------------------------------------------------------

test('the headline counts every verdict and the healthy share', () => {
  const report = buildReport(
    input({
      records: [record(), record({ caseId: 'C-2', assertion: { hasAutomation: true, cannotFail: true } })],
      riskScores: [score('C-1', 3), score('C-2', 3)],
    }),
  );
  assert.equal(report.headline.totalCases, 2);
  assert.equal(report.headline.healthyPercent, 50);
  assert.equal(report.headline.byVerdict.PROTECTING_NOTHING, 1);
  assert.equal(report.headline.byVerdict.HEALTHY, 1);
});

test('the protecting-nothing headline counts executions, not cases', () => {
  // "14 tests, 4,200 executions, zero possible failures" puts a cost on the placebo as well as a
  // risk. "14 tests" does not.
  const report = buildReport(
    input({
      records: [
        record({ assertion: { hasAutomation: true, cannotFail: true }, execution: { totalRuns: 300, failedRuns: 0, lastRunAt: '2026-08-29T00:00:00.000Z' } }),
        record({ caseId: 'C-2', assertion: { hasAutomation: true, cannotFail: true }, execution: { totalRuns: 120, failedRuns: 0, lastRunAt: '2026-08-29T00:00:00.000Z' } }),
      ],
      riskScores: [score('C-1', 3), score('C-2', 3)],
    }),
  );
  assert.equal(report.headline.byVerdict.PROTECTING_NOTHING, 2);
  assert.equal(report.headline.protectingNothingRunCount, 420);
});

test('an empty corpus reports zero percent healthy rather than dividing by zero', () => {
  const report = buildReport(input({ records: [], riskScores: [] }));
  assert.equal(report.headline.totalCases, 0);
  assert.equal(report.headline.healthyPercent, 0);
  assert.deepEqual(report.protectingNothing, []);
});

// --- sorted by risk, not by verdict --------------------------------------------------------------

test('protecting-nothing rows are sorted by risk, highest first', () => {
  const report = buildReport(
    input({
      records: [
        record({ caseId: 'C-low', assertion: { hasAutomation: true, cannotFail: true } }),
        record({ caseId: 'C-high', assertion: { hasAutomation: true, cannotFail: true } }),
      ],
      riskScores: [score('C-low', 1), score('C-high', 9)],
    }),
  );
  assert.deepEqual(
    report.protectingNothing.map((row) => row.caseId),
    ['C-high', 'C-low'],
  );
});

test('equal-risk rows keep a stable order so two runs can be diffed', () => {
  const report = buildReport(
    input({
      records: [
        record({ caseId: 'C-9', assertion: { hasAutomation: true, cannotFail: true } }),
        record({ caseId: 'C-2', assertion: { hasAutomation: true, cannotFail: true } }),
      ],
      riskScores: [score('C-9', 3), score('C-2', 3)],
    }),
  );
  assert.deepEqual(
    report.protectingNothing.map((row) => row.caseId),
    ['C-2', 'C-9'],
  );
});

test('a case with no risk score is ranked last but never dropped', () => {
  // Dropping it would hide a finding because of a configuration gap - the exact failure mode
  // this report exists to remove.
  const report = buildReport(
    input({
      records: [
        record({ caseId: 'C-unscored', assertion: { hasAutomation: true, cannotFail: true } }),
        record({ caseId: 'C-scored', assertion: { hasAutomation: true, cannotFail: true } }),
      ],
      riskScores: [score('C-scored', 5)],
    }),
  );
  assert.deepEqual(
    report.protectingNothing.map((row) => row.caseId),
    ['C-scored', 'C-unscored'],
  );
});

// --- evidence ------------------------------------------------------------------------------------

test('a protecting-nothing row quotes the assertion that cannot fail', () => {
  const report = buildReport(input({ records: [record({ assertion: { hasAutomation: true, cannotFail: true } })], analysisByCaseId: { 'C-1': analysis() } }));
  assert.equal(report.protectingNothing.length, 1);
  assert.ok(report.protectingNothing[0].evidence.some((e) => e.includes('expect(true).toBe(true)')));
  assert.ok(report.protectingNothing[0].evidence.some((e) => e.includes('tests/checkout.spec.ts')));
});

test('a weak-only test says so without being called protecting-nothing', () => {
  const report = buildReport(
    input({
      records: [record({ traceability: 'CASE_DRIFTED' })],
      analysisByCaseId: {
        'C-1': analysis({ assertion: { hasAutomation: true, cannotFail: false }, weakOnly: true, evidence: [] }),
      },
    }),
  );
  assert.equal(report.headline.byVerdict.PROTECTING_NOTHING, 0);
  assert.ok(report.stale[0].evidence.some((e) => e.includes('presence-only')));
});

test('every row carries the reasons classifyCase produced', () => {
  const report = buildReport(
    input({ records: [record({ assertion: { hasAutomation: true, cannotFail: true, cannotFailReason: 'no-assertions' } })] }),
  );
  assert.ok(report.protectingNothing[0].reasons.some((r) => r.code === 'assertion-cannot-fail'));
});

// --- suppression, where duration is the finding -----------------------------------------------------

test('suppressed rows are sorted by how long, longest first', () => {
  const report = buildReport(
    input({
      records: [
        record({ caseId: 'C-recent', suppression: { kind: 'quarantined', since: '2026-08-01T00:00:00.000Z' } }),
        record({ caseId: 'C-ancient', suppression: { kind: 'quarantined', since: '2026-04-14T00:00:00.000Z' } }),
      ],
      riskScores: [score('C-recent', 9), score('C-ancient', 1)],
    }),
  );
  assert.deepEqual(
    report.suppressed.map((row) => row.caseId),
    ['C-ancient', 'C-recent'],
    'duration outranks risk here, because duration is the finding',
  );
  assert.equal(report.headline.longestSuppressionDays, 138);
});

test('an unknown suppression date is reported as unknown, never as zero days', () => {
  const report = buildReport(
    input({ records: [record({ suppression: { kind: 'skipped', since: null } })] }),
  );
  assert.equal(report.suppressed[0].durationDays, null);
  assert.equal(report.headline.longestSuppressionDays, null);
  assert.equal(report.headline.suppressionsWithUnknownDuration, 1);
});

test('unknown durations sort last rather than claiming a position they cannot justify', () => {
  const report = buildReport(
    input({
      records: [
        record({ caseId: 'C-unknown', suppression: { kind: 'skipped', since: null } }),
        record({ caseId: 'C-known', suppression: { kind: 'quarantined', since: '2026-08-20T00:00:00.000Z' } }),
      ],
      riskScores: [score('C-unknown', 9), score('C-known', 1)],
    }),
  );
  assert.deepEqual(
    report.suppressed.map((row) => row.caseId),
    ['C-known', 'C-unknown'],
  );
});

test('the longest suppression ignores unknown dates instead of treating them as ancient', () => {
  const report = buildReport(
    input({
      records: [
        record({ caseId: 'C-unknown', suppression: { kind: 'skipped', since: null } }),
        record({ caseId: 'C-known', suppression: { kind: 'quarantined', since: '2026-08-20T00:00:00.000Z' } }),
      ],
      riskScores: [score('C-unknown', 1), score('C-known', 1)],
    }),
  );
  assert.equal(report.headline.longestSuppressionDays, 10);
  assert.equal(report.headline.suppressionsWithUnknownDuration, 1);
});

// --- consolidation, data quality, limits ------------------------------------------------------------

test('consolidation candidates are sorted by overlap, strongest first', () => {
  const report = buildReport(
    input({
      duplicatePairs: [
        { caseIds: ['C-1', 'C-2'], similarity: 0.7, sharedTerms: ['refund'], suggestedSurvivor: 'C-1' },
        { caseIds: ['C-3', 'C-4'], similarity: 0.95, sharedTerms: ['refund'], suggestedSurvivor: 'C-3' },
      ],
    }),
  );
  assert.deepEqual(
    report.consolidation.map((pair) => pair.similarity),
    [0.95, 0.7],
  );
});

test('collection warnings and unlinked tests are printed, not swallowed', () => {
  const report = buildReport(
    input({
      warnings: [{ code: 'spec-file-missing', caseId: 'C-1', message: 'gone' }],
      unlinkedTests: [analysis({ filePath: 'tests/orphan.spec.ts', title: 'nobody counts me' })],
    }),
  );
  assert.equal(report.dataQuality.length, 1);
  assert.deepEqual(report.unlinkedTests, [
    { filePath: 'tests/orphan.spec.ts', title: 'nobody counts me' },
  ]);
});

test('the limits section is always present and always the same', () => {
  const empty = buildReport(input({ records: [], riskScores: [] }));
  const full = buildReport(input());
  assert.deepEqual(empty.notChecked, [...NOT_CHECKED]);
  assert.deepEqual(full.notChecked, [...NOT_CHECKED]);
  assert.ok(NOT_CHECKED.length >= 5);
});

test('the limits list cannot be mutated by a caller', () => {
  assert.throws(() => {
    (NOT_CHECKED as string[]).push('something convenient');
  });
});

// --- rendering ---------------------------------------------------------------------------------------

test('the rendered report leads with the executions headline', () => {
  const markdown = renderReportMarkdown(
    buildReport(
      input({
        records: [
          record({ assertion: { hasAutomation: true, cannotFail: true }, execution: { totalRuns: 4200, failedRuns: 0, lastRunAt: '2026-08-29T00:00:00.000Z' } }),
        ],
      }),
    ),
  );
  assert.match(markdown, /4200 total executions/);
  assert.match(markdown, /Zero possible failures/);
});

test('the rendered report prints "duration unknown" rather than a number it does not have', () => {
  const markdown = renderReportMarkdown(
    buildReport(input({ records: [record({ suppression: { kind: 'skipped', since: null } })] })),
  );
  assert.match(markdown, /duration unknown/);
  assert.doesNotMatch(markdown, /skipped, 0 days/);
});

test('the rendered report never recommends deleting anything', () => {
  const markdown = renderReportMarkdown(
    buildReport(
      input({
        records: [
          record({ assertion: { hasAutomation: true, cannotFail: true } }),
          record({ caseId: 'C-2', suppression: { kind: 'quarantined', since: '2026-04-14T00:00:00.000Z' } }),
          record({ caseId: 'C-3', traceability: 'ORPHANED_CASE' }),
          record({ caseId: 'C-4', duplicateOfCaseIds: ['C-5'] }),
        ],
        riskScores: [score('C-1', 3), score('C-2', 3), score('C-3', 3), score('C-4', 3)],
        duplicatePairs: [
          { caseIds: ['C-4', 'C-5'], similarity: 0.8, sharedTerms: ['refund'], suggestedSurvivor: 'C-4' },
        ],
      }),
    ),
  );
  assert.doesNotMatch(markdown, /\bdelete\b/i);
  assert.match(markdown, /consolidate and archive/);
});

test('the rendered report always ends with what was not checked', () => {
  const markdown = renderReportMarkdown(buildReport(input({ records: [], riskScores: [] })));
  assert.match(markdown, /## 7\. What we did not check/);
  assert.match(markdown, /Nothing here was executed/);
  assert.match(markdown, /word overlap, not semantic comparison/);
});

test('all six spec sections render even when every one of them is empty', () => {
  const markdown = renderReportMarkdown(buildReport(input({ records: [], riskScores: [] })));
  for (const heading of [
    '## 1. Headline',
    '## 2. Protecting nothing',
    '## 3. Coverage you think you have and do not',
    '## 4. Stale',
    '## 5. Consolidation candidates',
    '## 7. What we did not check',
  ]) {
    assert.ok(markdown.includes(heading), `missing ${heading}`);
  }
});

test('rendering is deterministic for the same report', () => {
  const report = buildReport(input());
  assert.equal(renderReportMarkdown(report), renderReportMarkdown(report));
});

test('the headline is grammatical for a single finding', () => {
  const markdown = renderReportMarkdown(
    buildReport(input({ records: [record({ assertion: { hasAutomation: true, cannotFail: true } })] })),
  );
  assert.match(markdown, /\*\*1 test\. 10 total executions/);
  assert.doesNotMatch(markdown, /1 tests/);
});
