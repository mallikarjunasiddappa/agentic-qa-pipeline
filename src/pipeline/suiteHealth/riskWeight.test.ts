import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scoreRisk,
  scoreAllRisk,
  toRiskBands,
  compareByRisk,
  frequencyFactor,
  SUGGESTED_AREA_WEIGHTS,
  DEFAULT_AREA_WEIGHT,
  BLOCKING_MULTIPLIER,
  type AreaWeightConfig,
  type RiskInput,
} from './riskWeight';
import { classifyCase, type SuiteCaseRecord } from './classify';

const NOW = new Date('2026-08-30T09:00:00.000Z');

const CONFIG: AreaWeightConfig = {
  weights: { ...SUGGESTED_AREA_WEIGHTS },
  defaultWeight: DEFAULT_AREA_WEIGHT,
};

const UNCONFIGURED: AreaWeightConfig = { weights: {}, defaultWeight: DEFAULT_AREA_WEIGHT };

function riskInput(overrides: Partial<RiskInput> = {}): RiskInput {
  return {
    caseId: 'C-1',
    areas: ['payments'],
    blocksRelease: false,
    execution: { totalRuns: 0, failedRuns: 0, lastRunAt: null },
    ...overrides,
  };
}

// --- the three factors ----------------------------------------------------------------------

test('a configured area sets the area weight and is named as evidence', () => {
  const score = scoreRisk(riskInput(), CONFIG);
  assert.equal(score.factors.area, 3);
  assert.equal(score.areaConfigured, true);
  assert.deepEqual(score.matchedAreas, ['payments']);
});

test('area matching is case and whitespace insensitive', () => {
  const score = scoreRisk(riskInput({ areas: ['  Payments '] }), CONFIG);
  assert.equal(score.factors.area, 3);
  assert.deepEqual(score.matchedAreas, ['payments']);
});

test('the highest matching area wins rather than the average', () => {
  // A case tagged payments AND marketing is a payments case that also touches marketing.
  // Averaging would let the second label dilute a real risk.
  const score = scoreRisk(riskInput({ areas: ['marketing', 'payments'] }), CONFIG);
  assert.equal(score.factors.area, 3);
  assert.deepEqual(score.matchedAreas, ['marketing', 'payments']);
});

test('blocking a release doubles the score', () => {
  const notBlocking = scoreRisk(riskInput({ blocksRelease: false }), CONFIG);
  const blocking = scoreRisk(riskInput({ blocksRelease: true }), CONFIG);
  assert.equal(blocking.factors.blastRadius, BLOCKING_MULTIPLIER);
  assert.equal(blocking.score, notBlocking.score * BLOCKING_MULTIPLIER);
});

test('a never-run test keeps its full risk rather than being multiplied to nothing', () => {
  // "Never run" is itself a finding. A frequency factor of 0 would delete it from the report.
  assert.equal(frequencyFactor(0), 1);
  assert.equal(scoreRisk(riskInput(), CONFIG).score, 3);
});

test('more runs rank higher, but compressed enough that area weight still dominates', () => {
  assert.ok(frequencyFactor(4000) > frequencyFactor(40));
  assert.ok(frequencyFactor(4000) < 5, 'raw counts would be three orders of magnitude apart');

  const busyAboutPage = scoreRisk(
    riskInput({ areas: ['about'], execution: { totalRuns: 4000, failedRuns: 3, lastRunAt: null } }),
    CONFIG,
  );
  const quietAuth = scoreRisk(
    riskInput({ areas: ['auth'], execution: { totalRuns: 5, failedRuns: 0, lastRunAt: null } }),
    CONFIG,
  );
  assert.ok(
    quietAuth.score > busyAboutPage.score,
    'a quiet auth test must outrank a busy About-page test',
  );
});

// --- nothing is inferred ------------------------------------------------------------------------

test('an unmatched area falls back to the default weight and says so', () => {
  const score = scoreRisk(riskInput({ areas: ['reporting'] }), CONFIG);
  assert.equal(score.factors.area, DEFAULT_AREA_WEIGHT);
  assert.equal(score.areaConfigured, false);
  assert.deepEqual(score.matchedAreas, []);
});

test('a case with no areas at all is unconfigured, not zero-risk', () => {
  const score = scoreRisk(riskInput({ areas: [] }), CONFIG);
  assert.equal(score.factors.area, DEFAULT_AREA_WEIGHT);
  assert.equal(score.areaConfigured, false);
});

test('the suggested weights are a starting point, not something applied automatically', () => {
  const score = scoreRisk(riskInput({ areas: ['payments'] }), UNCONFIGURED);
  assert.equal(
    score.areaConfigured,
    false,
    'a project that configured nothing gets nothing, even for an obviously risky word',
  );
  assert.equal(score.band, 'medium');
});

test('the suggested weights cannot be mutated by a caller', () => {
  assert.throws(() => {
    (SUGGESTED_AREA_WEIGHTS as Record<string, number>).payments = 99;
  });
});

// --- banding, which is deliberately not the score -------------------------------------------------

test('a configured high-weight area produces the high band', () => {
  assert.equal(scoreRisk(riskInput({ areas: ['auth'] }), CONFIG).band, 'high');
});

test('a configured low-weight area produces the low band', () => {
  assert.equal(scoreRisk(riskInput({ areas: ['about'] }), CONFIG).band, 'low');
});

test('a mid-weight area produces the medium band', () => {
  assert.equal(scoreRisk(riskInput({ areas: ['checkout'] }), CONFIG).band, 'medium');
});

test('run count and blast radius cannot promote a case into the high band', () => {
  const score = scoreRisk(
    riskInput({
      areas: ['about'],
      blocksRelease: true,
      execution: { totalRuns: 9000, failedRuns: 0, lastRunAt: null },
    }),
    CONFIG,
  );
  assert.ok(score.score > scoreRisk(riskInput({ areas: ['auth'] }), CONFIG).score);
  assert.equal(score.band, 'low', 'band follows the configured area, never the score');
});

test('an unconfigured case cannot reach COLD_BUT_LOAD_BEARING', () => {
  // That verdict says "keep this, it is protecting something important". It must never rest on a
  // run count nobody configured.
  const bands = toRiskBands(scoreAllRisk([riskInput({ areas: ['reporting'] })], CONFIG));
  const record: SuiteCaseRecord = {
    caseId: 'C-1',
    title: 'Something in reporting',
    riskBand: bands['C-1'],
    assertion: { hasAutomation: true, cannotFail: false },
    suppression: null,
    traceability: 'IN_SYNC',
    duplicateOfCaseIds: [],
    execution: { totalRuns: 340, failedRuns: 0, lastRunAt: '2026-08-29T00:00:00.000Z' },
  };
  assert.equal(classifyCase(record, NOW).verdict, 'HEALTHY');

  const configuredRecord: SuiteCaseRecord = {
    ...record,
    riskBand: toRiskBands(scoreAllRisk([riskInput({ areas: ['auth'] })], CONFIG))['C-1'],
  };
  assert.equal(classifyCase(configuredRecord, NOW).verdict, 'COLD_BUT_LOAD_BEARING');
});

// --- the sort order ---------------------------------------------------------------------------------

test('scores sort highest risk first', () => {
  const scores = scoreAllRisk(
    [
      riskInput({ caseId: 'C-about', areas: ['about'] }),
      riskInput({ caseId: 'C-auth', areas: ['auth'] }),
      riskInput({ caseId: 'C-checkout', areas: ['checkout'] }),
    ],
    CONFIG,
  );
  assert.deepEqual(
    [...scores].sort(compareByRisk).map((s) => s.caseId),
    ['C-auth', 'C-checkout', 'C-about'],
  );
});

test('equal-risk rows keep a stable order so the report can be diffed', () => {
  const scores = scoreAllRisk(
    [
      riskInput({ caseId: 'C-9', areas: ['auth'] }),
      riskInput({ caseId: 'C-2', areas: ['payments'] }),
    ],
    CONFIG,
  );
  assert.equal(scores[0].score, scores[1].score);
  assert.deepEqual(
    [...scores].sort(compareByRisk).map((s) => s.caseId),
    ['C-2', 'C-9'],
  );
  assert.deepEqual(
    [...scores].reverse().sort(compareByRisk).map((s) => s.caseId),
    ['C-2', 'C-9'],
  );
});

test('toRiskBands keys every scored case', () => {
  const bands = toRiskBands(
    scoreAllRisk(
      [riskInput({ caseId: 'C-1', areas: ['auth'] }), riskInput({ caseId: 'C-2', areas: ['about'] })],
      CONFIG,
    ),
  );
  assert.deepEqual(bands, { 'C-1': 'high', 'C-2': 'low' });
});

test('scoring an empty set is not an error', () => {
  assert.deepEqual(scoreAllRisk([], CONFIG), []);
  assert.deepEqual(toRiskBands([]), {});
});
