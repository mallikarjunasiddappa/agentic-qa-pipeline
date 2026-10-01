import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findDuplicateCoverage,
  toDuplicateGroups,
  candidateFromTmsCase,
  DUPLICATE_SIMILARITY_THRESHOLD,
  type DuplicateCandidate,
} from './findDuplicateCoverage';
import { collectSignals } from './collectSignals';
import { classifyCase } from './classify';

const NOW = new Date('2026-08-30T09:00:00.000Z');

function candidate(caseId: string, title: string, body: string[]): DuplicateCandidate {
  return { caseId, title, body };
}

const REFUND_STEPS = [
  'Open the orders list and select a delivered order',
  'Choose refund and confirm the amount shown',
  'The refund is recorded and the balance decreases',
];

// --- the basic judgement --------------------------------------------------------------------

test('two cases describing the same flow are paired', () => {
  const pairs = findDuplicateCoverage([
    candidate('C-1', 'Refund a delivered order', REFUND_STEPS),
    candidate('C-2', 'Refund a delivered order', REFUND_STEPS),
  ]);
  assert.equal(pairs.length, 1);
  assert.deepEqual(pairs[0].caseIds, ['C-1', 'C-2']);
  assert.equal(pairs[0].similarity, 1);
});

test('two unrelated cases are not paired', () => {
  const pairs = findDuplicateCoverage([
    candidate('C-1', 'Refund a delivered order', REFUND_STEPS),
    candidate('C-2', 'Change the newsletter language', [
      'Open account settings and pick a language',
      'The newsletter arrives in the chosen language',
    ]),
  ]);
  assert.deepEqual(pairs, []);
});

test('a pair carries the shared terms as evidence, rarest first', () => {
  // 'chargeback' appears in one pair only; 'order' appears in every case. The evidence has to
  // lead with the term that actually argues the case.
  const pairs = findDuplicateCoverage([
    candidate('C-1', 'Refund a delivered order', [...REFUND_STEPS, 'A chargeback is recorded']),
    candidate('C-2', 'Refund a delivered order', [...REFUND_STEPS, 'A chargeback is recorded']),
    candidate('C-3', 'Track a delivered order', ['Open the orders list and track the order']),
    candidate('C-4', 'Cancel a delivered order', ['Open the orders list and cancel the order']),
  ]);
  const refundPair = pairs.find((p) => p.caseIds.join('|') === 'C-1|C-2');
  assert.ok(refundPair);
  assert.ok(refundPair.sharedTerms.includes('chargeback'), 'the distinctive term survives the cap');
  assert.ok(!refundPair.sharedTerms.includes('order'), 'a term in every case is ranked out');
  assert.ok(!refundPair.sharedTerms.includes('delivered'));
});

test('the same corpus always produces the same evidence ordering', () => {
  const cases = [
    candidate('C-1', 'Refund a delivered order', REFUND_STEPS),
    candidate('C-2', 'Refund a delivered order', REFUND_STEPS),
  ];
  assert.deepEqual(
    findDuplicateCoverage(cases)[0].sharedTerms,
    findDuplicateCoverage([...cases].reverse())[0].sharedTerms,
  );
});

test('an empty corpus and a single case produce nothing', () => {
  assert.deepEqual(findDuplicateCoverage([]), []);
  assert.deepEqual(findDuplicateCoverage([candidate('C-1', 'Only case', REFUND_STEPS)]), []);
});

test('a case is never paired with itself', () => {
  const pairs = findDuplicateCoverage([
    candidate('C-1', 'Refund a delivered order', REFUND_STEPS),
    candidate('C-2', 'Refund a delivered order', REFUND_STEPS),
  ]);
  assert.ok(pairs.every((p) => p.caseIds[0] !== p.caseIds[1]));
});

test('each pair appears exactly once, not once per direction', () => {
  const pairs = findDuplicateCoverage([
    candidate('C-1', 'Refund a delivered order', REFUND_STEPS),
    candidate('C-2', 'Refund a delivered order', REFUND_STEPS),
    candidate('C-3', 'Refund a delivered order', REFUND_STEPS),
  ]);
  assert.equal(pairs.length, 3, 'three cases, three unordered pairs');
  const keys = pairs.map((p) => p.caseIds.join('|'));
  assert.equal(new Set(keys).size, keys.length);
});

// --- pairs, deliberately not clusters ---------------------------------------------------------

test('similarity is measured per pair and never inferred transitively', () => {
  // A and B overlap; B and C overlap; A and C do not. Chaining them into one group of three
  // would assert A~C, which no score ever showed.
  const a = candidate('C-1', 'Refund a delivered order', [
    'Open the orders list and select a delivered order',
    'Choose refund and confirm the amount shown',
  ]);
  const b = candidate('C-2', 'Refund a delivered order', [
    'Open the orders list and select a delivered order',
    'Choose refund and confirm the amount shown',
  ]);
  const c = candidate('C-3', 'Cancel a subscription plan', [
    'Open billing settings and pick the active plan',
    'Choose cancel and confirm the end date shown',
  ]);

  const pairs = findDuplicateCoverage([a, b, c]);
  const keys = pairs.map((p) => p.caseIds.join('|'));
  assert.ok(keys.includes('C-1|C-2'));
  assert.ok(!keys.includes('C-1|C-3'), 'no transitive claim');
});

// --- the survivor suggestion ---------------------------------------------------------------------

test('the case carrying more detail is suggested as the survivor', () => {
  const pairs = findDuplicateCoverage([
    candidate('C-1', 'Refund a delivered order', REFUND_STEPS),
    candidate('C-2', 'Refund a delivered order', [
      ...REFUND_STEPS,
      'A refund confirmation email is sent to the customer address',
    ]),
  ]);
  assert.equal(pairs[0].suggestedSurvivor, 'C-2');
});

test('an exact tie resolves to the lower id so the output is stable', () => {
  const pairs = findDuplicateCoverage([
    candidate('C-2', 'Refund a delivered order', REFUND_STEPS),
    candidate('C-1', 'Refund a delivered order', REFUND_STEPS),
  ]);
  assert.equal(pairs[0].suggestedSurvivor, 'C-1');
});

// --- determinism -----------------------------------------------------------------------------------

test('input order does not change the result', () => {
  const cases = [
    candidate('C-3', 'Cancel a subscription plan', ['Open billing settings and cancel the plan']),
    candidate('C-1', 'Refund a delivered order', REFUND_STEPS),
    candidate('C-2', 'Refund a delivered order', REFUND_STEPS),
  ];
  const forwards = findDuplicateCoverage(cases);
  const backwards = findDuplicateCoverage([...cases].reverse());
  assert.deepEqual(forwards, backwards);
});

test('pairs are sorted by similarity, strongest first', () => {
  const pairs = findDuplicateCoverage([
    candidate('C-1', 'Refund a delivered order', REFUND_STEPS),
    candidate('C-2', 'Refund a delivered order', REFUND_STEPS),
    candidate('C-3', 'Refund a delivered order', [
      ...REFUND_STEPS,
      'A refund confirmation email is sent to the customer address today',
    ]),
  ]);
  const scores = pairs.map((p) => p.similarity);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
});

// --- the threshold and the blocking optimisation ------------------------------------------------

test('the threshold matches the batch-scoped rule it has to agree with', () => {
  assert.equal(DUPLICATE_SIMILARITY_THRESHOLD, 0.6);
});

test('a lowered threshold widens the result, a raised one narrows it', () => {
  const cases = [
    candidate('C-1', 'Refund a delivered order', REFUND_STEPS),
    candidate('C-2', 'Refund a delivered order after the return window', [
      'Open the orders list and select an old delivered order',
      'Choose refund and read the rejection message shown',
    ]),
  ];
  assert.ok(findDuplicateCoverage(cases, { similarityThreshold: 0.2 }).length >= 1);
  assert.deepEqual(findDuplicateCoverage(cases, { similarityThreshold: 0.99 }), []);
});

test('candidate blocking never changes a verdict, only the work done to reach it', () => {
  // With commonTermRatio at 1, nothing is treated as common and every pair is considered
  // directly. The findings must be identical to the blocked run.
  const cases = [
    candidate('C-1', 'Refund a delivered order', REFUND_STEPS),
    candidate('C-2', 'Refund a delivered order', REFUND_STEPS),
    candidate('C-3', 'Cancel a subscription plan', ['Open billing settings and cancel the plan']),
  ];
  assert.deepEqual(findDuplicateCoverage(cases), findDuplicateCoverage(cases, { commonTermRatio: 1 }));
});

test('cases made entirely of ubiquitous words are still compared to each other', () => {
  // Every case shares the same vocabulary, so every term is "common" and the inverted index is
  // empty. The fallback path has to catch these rather than silently dropping them.
  const shared = ['Open the record and verify the value shown'];
  const pairs = findDuplicateCoverage([
    candidate('C-1', 'Verify the record', shared),
    candidate('C-2', 'Verify the record', shared),
  ]);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].similarity, 1);
});

// --- adapting from the test management tool -------------------------------------------------------

test('a TMS case detail becomes a candidate including its expected results', () => {
  const result = candidateFromTmsCase({
    id: 'C-9',
    title: 'Refund a delivered order',
    description: 'Covers the happy path',
    preconditions: 'An order exists and is delivered',
    steps: [
      { action: 'Choose refund', expectedResult: 'The balance decreases' },
      { action: 'Close the dialog' },
    ],
  });
  assert.equal(result.caseId, 'C-9');
  assert.deepEqual(result.body, [
    'An order exists and is delivered',
    'Covers the happy path',
    'Choose refund',
    'The balance decreases',
    'Close the dialog',
  ]);
});

test('a TMS case with null description and preconditions still adapts', () => {
  const result = candidateFromTmsCase({
    id: 'C-9',
    title: 'Refund a delivered order',
    description: null,
    preconditions: null,
    steps: [{ action: 'Choose refund' }],
  });
  assert.deepEqual(result.body, ['Choose refund']);
});

// --- the seam into collectSignals and classify -------------------------------------------------

test('pairs become duplicateGroups and reach the DUPLICATE verdict', () => {
  const pairs = findDuplicateCoverage([
    candidate('C-1', 'Refund a delivered order', REFUND_STEPS),
    candidate('C-2', 'Refund a delivered order', REFUND_STEPS),
  ]);
  const groups = toDuplicateGroups(pairs);
  assert.deepEqual(groups, [['C-1', 'C-2']]);

  const result = collectSignals({
    cases: [
      { caseId: 'C-1', title: 'Refund a delivered order' },
      { caseId: 'C-2', title: 'Refund a delivered order' },
    ],
    traceability: [],
    quarantine: [],
    specs: [],
    execution: [
      { caseId: 'C-1', totalRuns: 10, failedRuns: 1, lastRunAt: '2026-08-29T00:00:00.000Z' },
      { caseId: 'C-2', totalRuns: 10, failedRuns: 1, lastRunAt: '2026-08-29T00:00:00.000Z' },
    ],
    duplicateGroups: groups,
    riskBands: { 'C-1': 'medium', 'C-2': 'medium' },
    now: NOW,
  });

  assert.deepEqual(result.records[0].duplicateOfCaseIds, ['C-2']);
  assert.equal(classifyCase(result.records[0], NOW).verdict, 'DUPLICATE');
  assert.equal(classifyCase(result.records[0], NOW).action, 'consolidate');
});

test('a suggested survivor is a suggestion, and consolidate is as far as the action goes', () => {
  const pairs = findDuplicateCoverage([
    candidate('C-1', 'Refund a delivered order', REFUND_STEPS),
    candidate('C-2', 'Refund a delivered order', REFUND_STEPS),
  ]);
  assert.ok(pairs[0].suggestedSurvivor);

  const result = collectSignals({
    cases: [{ caseId: 'C-1', title: 'Refund a delivered order' }],
    traceability: [],
    quarantine: [],
    specs: [],
    execution: [
      { caseId: 'C-1', totalRuns: 10, failedRuns: 1, lastRunAt: '2026-08-29T00:00:00.000Z' },
    ],
    duplicateGroups: toDuplicateGroups(pairs),
    riskBands: { 'C-1': 'medium' },
    now: NOW,
  });
  const health = classifyCase(result.records[0], NOW);
  assert.equal(health.action, 'consolidate');
  assert.notEqual(health.action as string, 'delete');
});
