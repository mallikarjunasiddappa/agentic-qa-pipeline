import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyCase,
  summariseSuiteHealth,
  daysSince,
  COLD_MINIMUM_RUNS,
  type SuiteCaseRecord,
  type RecommendedAction,
} from './classify';

const NOW = new Date('2026-08-30T09:00:00.000Z');

/**
 * A HEALTHY case. Every test below starts from this and changes exactly one thing, so a failure
 * names the signal that broke rather than leaving you to diff two large literals.
 */
function healthyCase(overrides: Partial<SuiteCaseRecord> = {}): SuiteCaseRecord {
  return {
    caseId: 'C-1',
    title: 'Refund refused on a booking older than 30 days',
    riskBand: 'medium',
    assertion: { hasAutomation: true, cannotFail: false },
    suppression: null,
    traceability: 'IN_SYNC',
    duplicateOfCaseIds: [],
    execution: { totalRuns: 50, failedRuns: 3, lastRunAt: '2026-08-29T02:00:00.000Z' },
    ...overrides,
  };
}

// --------------------------------------------------------------------------- daysSince

test('daysSince floors to whole calendar days', () => {
  assert.equal(daysSince('2026-08-20T23:00:00.000Z', NOW), 9);
});

test('daysSince returns a negative number for a future date rather than clamping to 0', () => {
  // Clamping would let clock skew silently satisfy a positive threshold.
  assert.ok(daysSince('2026-09-05T09:00:00.000Z', NOW) < 0);
});

test('daysSince throws on an unparseable date rather than returning NaN', () => {
  assert.throws(() => daysSince('not-a-date', NOW));
});

// --------------------------------------------------------------------------- the seven verdicts

test('HEALTHY when it runs, can fail, has failed, and traces to a live requirement', () => {
  const result = classifyCase(healthyCase(), NOW);
  assert.equal(result.verdict, 'HEALTHY');
  assert.equal(result.action, 'none');
});

test('PROTECTING_NOTHING when the assertion cannot fail', () => {
  const result = classifyCase(
    healthyCase({
      assertion: { hasAutomation: true, cannotFail: true, cannotFailReason: 'always-true-matcher' },
    }),
    NOW,
  );
  assert.equal(result.verdict, 'PROTECTING_NOTHING');
  assert.equal(result.action, 'fix-assertion');
  assert.ok(result.reasons.some((r) => r.code === 'assertion-cannot-fail'));
});

test('PROTECTING_NOTHING quotes the reason assertionGuard gave', () => {
  const result = classifyCase(
    healthyCase({
      assertion: { hasAutomation: true, cannotFail: true, cannotFailReason: 'asserts-the-mock' },
    }),
    NOW,
  );
  const reason = result.reasons.find((r) => r.code === 'assertion-cannot-fail');
  assert.ok(reason?.message.includes('asserts-the-mock'));
});

test('a manual-only case is never PROTECTING_NOTHING - it has no assertion to weaken', () => {
  // hasAutomation:false must not be confused with cannotFail:true. A manual case reported as a
  // placebo would be a straightforward lie about a case a person executes by hand.
  const result = classifyCase(
    healthyCase({ assertion: { hasAutomation: false, cannotFail: false } }),
    NOW,
  );
  assert.notEqual(result.verdict, 'PROTECTING_NOTHING');
});

test('SUPPRESSED when quarantined, and the duration is reported', () => {
  const result = classifyCase(
    healthyCase({ suppression: { kind: 'quarantined', since: '2026-04-14T00:00:00.000Z' } }),
    NOW,
  );
  assert.equal(result.verdict, 'SUPPRESSED');
  assert.equal(result.action, 'unquarantine-or-accept-gap');
  const reason = result.reasons.find((r) => r.code === 'suppressed-quarantined');
  assert.ok(reason?.message.includes('138 days'));
  assert.ok(reason?.message.includes('still counted as covered'));
});

test('SUPPRESSED covers skip and fixme, not only quarantine', () => {
  for (const kind of ['skipped', 'fixme'] as const) {
    const result = classifyCase(
      healthyCase({ suppression: { kind, since: '2026-08-01T00:00:00.000Z' } }),
      NOW,
    );
    assert.equal(result.verdict, 'SUPPRESSED', `${kind} should be SUPPRESSED`);
  }
});

test('ORPHANED when never executed and no automation is linked', () => {
  const result = classifyCase(
    healthyCase({
      assertion: { hasAutomation: false, cannotFail: false },
      execution: { totalRuns: 0, failedRuns: 0, lastRunAt: null },
    }),
    NOW,
  );
  assert.equal(result.verdict, 'ORPHANED');
  assert.equal(result.action, 'verify-then-archive');
});

test('SUPPRESSED, not ORPHANED, when automation exists but has never run', () => {
  // Different action: find out why the suite is not executing it, do not archive it.
  const result = classifyCase(
    healthyCase({ execution: { totalRuns: 0, failedRuns: 0, lastRunAt: null } }),
    NOW,
  );
  assert.equal(result.verdict, 'SUPPRESSED');
  assert.ok(result.reasons.some((r) => r.code === 'automated-but-never-run'));
});

test('ORPHANED on a traceability orphan state', () => {
  for (const state of ['ORPHANED_CASE', 'ORPHANED_TEST'] as const) {
    const result = classifyCase(healthyCase({ traceability: state }), NOW);
    assert.equal(result.verdict, 'ORPHANED', `${state} should be ORPHANED`);
  }
});

test('STALE on every drift state', () => {
  for (const state of ['CASE_DRIFTED', 'TEST_DRIFTED', 'BOTH_DRIFTED'] as const) {
    const result = classifyCase(healthyCase({ traceability: state }), NOW);
    assert.equal(result.verdict, 'STALE', `${state} should be STALE`);
    assert.equal(result.action, 'review-against-requirement');
  }
});

test('DUPLICATE names the cases it duplicates', () => {
  const result = classifyCase(healthyCase({ duplicateOfCaseIds: ['C-8', 'C-9'] }), NOW);
  assert.equal(result.verdict, 'DUPLICATE');
  assert.equal(result.action, 'consolidate');
  assert.ok(result.reasons.some((r) => r.message.includes('C-8, C-9')));
});

// --------------------------------------------------------------------------- the important one

test('COLD_BUT_LOAD_BEARING: never failed, high risk, assertion can fail -> KEEP', () => {
  // This is the verdict that exists to answer "no active story mentions it, so remove it".
  const result = classifyCase(
    healthyCase({
      riskBand: 'high',
      execution: { totalRuns: 340, failedRuns: 0, lastRunAt: '2026-08-29T02:00:00.000Z' },
    }),
    NOW,
  );
  assert.equal(result.verdict, 'COLD_BUT_LOAD_BEARING');
  assert.equal(result.action, 'keep');
  assert.ok(result.reasons.some((r) => r.code === 'never-failed'));
});

test('a never-failed case whose assertion CANNOT fail is a placebo, not load-bearing', () => {
  // Same execution history, same risk band. The assertion is the only thing that separates
  // "excellent regression coverage" from "has passed 340 times and guards nothing".
  const result = classifyCase(
    healthyCase({
      riskBand: 'high',
      assertion: { hasAutomation: true, cannotFail: true, cannotFailReason: 'no-assertion' },
      execution: { totalRuns: 340, failedRuns: 0, lastRunAt: '2026-08-29T02:00:00.000Z' },
    }),
    NOW,
  );
  assert.equal(result.verdict, 'PROTECTING_NOTHING');
});

test('a never-failed low-risk case is HEALTHY, not COLD_BUT_LOAD_BEARING', () => {
  const result = classifyCase(
    healthyCase({
      riskBand: 'low',
      execution: { totalRuns: 340, failedRuns: 0, lastRunAt: '2026-08-29T02:00:00.000Z' },
    }),
    NOW,
  );
  assert.equal(result.verdict, 'HEALTHY');
});

test('below COLD_MINIMUM_RUNS, "never failed" means "new" and is not reported', () => {
  const result = classifyCase(
    healthyCase({
      riskBand: 'high',
      execution: { totalRuns: COLD_MINIMUM_RUNS - 1, failedRuns: 0, lastRunAt: '2026-08-29T02:00:00.000Z' },
    }),
    NOW,
  );
  assert.equal(result.verdict, 'HEALTHY');
  assert.ok(!result.reasons.some((r) => r.code === 'never-failed'));
});

test('exactly COLD_MINIMUM_RUNS is enough to draw the conclusion', () => {
  const result = classifyCase(
    healthyCase({
      riskBand: 'high',
      execution: { totalRuns: COLD_MINIMUM_RUNS, failedRuns: 0, lastRunAt: '2026-08-29T02:00:00.000Z' },
    }),
    NOW,
  );
  assert.equal(result.verdict, 'COLD_BUT_LOAD_BEARING');
});

// --------------------------------------------------------------------------- precedence

test('an unfailable assertion outranks every other signal', () => {
  const result = classifyCase(
    healthyCase({
      assertion: { hasAutomation: true, cannotFail: true, cannotFailReason: 'no-assertion' },
      suppression: { kind: 'quarantined', since: '2026-01-01T00:00:00.000Z' },
      traceability: 'BOTH_DRIFTED',
      duplicateOfCaseIds: ['C-2'],
    }),
    NOW,
  );
  assert.equal(result.verdict, 'PROTECTING_NOTHING');
});

test('every matched signal appears in reasons, not just the deciding one', () => {
  const result = classifyCase(
    healthyCase({
      assertion: { hasAutomation: true, cannotFail: true, cannotFailReason: 'no-assertion' },
      suppression: { kind: 'quarantined', since: '2026-01-01T00:00:00.000Z' },
      traceability: 'BOTH_DRIFTED',
      duplicateOfCaseIds: ['C-2'],
    }),
    NOW,
  );
  const codes = result.reasons.map((r) => r.code);
  assert.ok(codes.includes('assertion-cannot-fail'));
  assert.ok(codes.includes('suppressed-quarantined'));
  assert.ok(codes.includes('traceability-drifted'));
  assert.ok(codes.includes('duplicate-coverage'));
});

test('suppression outranks drift and duplication', () => {
  const result = classifyCase(
    healthyCase({
      suppression: { kind: 'quarantined', since: '2026-01-01T00:00:00.000Z' },
      traceability: 'CASE_DRIFTED',
      duplicateOfCaseIds: ['C-2'],
    }),
    NOW,
  );
  assert.equal(result.verdict, 'SUPPRESSED');
});

test('drift outranks duplication', () => {
  const result = classifyCase(
    healthyCase({ traceability: 'CASE_DRIFTED', duplicateOfCaseIds: ['C-2'] }),
    NOW,
  );
  assert.equal(result.verdict, 'STALE');
});

// --------------------------------------------------------------------------- the no-delete rule

test('no verdict ever recommends deleting anything', () => {
  const permitted: RecommendedAction[] = [
    'fix-assertion',
    'unquarantine-or-accept-gap',
    'verify-then-archive',
    'review-against-requirement',
    'consolidate',
    'keep',
    'none',
  ];

  const everyShape: SuiteCaseRecord[] = [
    healthyCase(),
    healthyCase({ assertion: { hasAutomation: true, cannotFail: true } }),
    healthyCase({ suppression: { kind: 'quarantined', since: '2026-01-01T00:00:00.000Z' } }),
    healthyCase({ traceability: 'ORPHANED_CASE' }),
    healthyCase({ traceability: 'BOTH_DRIFTED' }),
    healthyCase({ duplicateOfCaseIds: ['C-2'] }),
    healthyCase({ riskBand: 'high', execution: { totalRuns: 340, failedRuns: 0, lastRunAt: '2026-08-29T02:00:00.000Z' } }),
    healthyCase({
      assertion: { hasAutomation: false, cannotFail: false },
      execution: { totalRuns: 0, failedRuns: 0, lastRunAt: null },
    }),
  ];

  for (const record of everyShape) {
    const result = classifyCase(record, NOW);
    assert.ok(
      permitted.includes(result.action),
      `${result.verdict} produced a non-permitted action: ${result.action}`,
    );
  }
});

// --------------------------------------------------------------------------- summary

test('summariseSuiteHealth counts EXECUTIONS of placebos, not just cases', () => {
  // "14 tests, 4,200 executions, zero possible failures" puts a cost on the placebo, not only a
  // risk. "14 tests" alone does not.
  const records = [
    healthyCase({
      caseId: 'C-1',
      assertion: { hasAutomation: true, cannotFail: true },
      execution: { totalRuns: 300, failedRuns: 0, lastRunAt: '2026-08-29T02:00:00.000Z' },
    }),
    healthyCase({
      caseId: 'C-2',
      assertion: { hasAutomation: true, cannotFail: true },
      execution: { totalRuns: 200, failedRuns: 0, lastRunAt: '2026-08-29T02:00:00.000Z' },
    }),
    healthyCase({ caseId: 'C-3' }),
  ];
  const results = records.map((record) => classifyCase(record, NOW));
  const summary = summariseSuiteHealth(results, records, NOW);

  assert.equal(summary.total, 3);
  assert.equal(summary.byVerdict.PROTECTING_NOTHING, 2);
  assert.equal(summary.byVerdict.HEALTHY, 1);
  assert.equal(summary.protectingNothingRunCount, 500);
});

test('summariseSuiteHealth reports the longest suppression, not the average', () => {
  const records = [
    healthyCase({ caseId: 'C-1', suppression: { kind: 'quarantined', since: '2026-08-20T00:00:00.000Z' } }),
    healthyCase({ caseId: 'C-2', suppression: { kind: 'skipped', since: '2026-04-14T00:00:00.000Z' } }),
  ];
  const results = records.map((record) => classifyCase(record, NOW));
  const summary = summariseSuiteHealth(results, records, NOW);

  assert.equal(summary.longestSuppressionDays, 138);
});

test('summariseSuiteHealth handles an empty suite without dividing by anything', () => {
  const summary = summariseSuiteHealth([], [], NOW);
  assert.equal(summary.total, 0);
  assert.equal(summary.protectingNothingRunCount, 0);
  assert.equal(summary.longestSuppressionDays, 0);
});
