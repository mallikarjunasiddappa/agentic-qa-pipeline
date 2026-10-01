import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectSignals,
  findUnlinkedTests,
  DEFAULT_RISK_BAND,
  type CollectSignalsInput,
} from './collectSignals';
import { classifyCase } from './classify';
import type { QuarantineEntry, TraceabilityEntry } from '../types/schemas';

const NOW = new Date('2026-08-30T09:00:00.000Z');
const SPEC_PATH = 'tests/checkout.spec.ts';

const REAL_ASSERTION = "  await expect(page.locator('#total')).toHaveText('120 kr');";
const PLACEBO_ASSERTION = '  expect(true).toBe(true);';

function specSource(
  body: string,
  title = 'checkout total is correct',
  declaration = 'test',
): string {
  return (
    "import { test, expect } from '@playwright/test';\n\n" +
    `${declaration}('${title}', async ({ page }) => {\n${body}\n});\n`
  );
}

function entry(overrides: Partial<TraceabilityEntry> = {}): TraceabilityEntry {
  return {
    jiraKey: 'UNI-1187',
    externalCaseId: 'C-1',
    externalCaseHash: 'aaa',
    externalCaseUpdatedAt: '2026-01-01T00:00:00.000Z',
    tmsProvider: 'qase',
    testFilePath: SPEC_PATH,
    testTitle: 'checkout total is correct',
    testContentHash: 'bbb',
    testLastModified: '2026-01-01T00:00:00.000Z',
    syncState: 'IN_SYNC',
    lastCheckedAt: '2026-08-30T00:00:00.000Z',
    ...overrides,
  };
}

function quarantineEntry(overrides: Partial<QuarantineEntry> = {}): QuarantineEntry {
  return {
    testFilePath: SPEC_PATH,
    testTitle: 'checkout total is correct',
    suite: 'checkout',
    quarantinedAt: '2026-04-14T00:00:00.000Z',
    evidence: [
      { attempt: 1, result: 'fail', timestamp: '2026-04-13T00:00:00.000Z' },
      { attempt: 2, result: 'pass', timestamp: '2026-04-14T00:00:00.000Z' },
    ],
    ...overrides,
  };
}

/** A fully resolvable case. Every test changes exactly one thing from here. */
function input(overrides: Partial<CollectSignalsInput> = {}): CollectSignalsInput {
  return {
    cases: [{ caseId: 'C-1', title: 'Checkout total is correct' }],
    traceability: [entry()],
    quarantine: [],
    specs: [{ path: SPEC_PATH, content: specSource(REAL_ASSERTION) }],
    execution: [
      { caseId: 'C-1', totalRuns: 340, failedRuns: 2, lastRunAt: '2026-08-29T00:00:00.000Z' },
    ],
    duplicateGroups: [],
    riskBands: { 'C-1': 'high' },
    now: NOW,
    ...overrides,
  };
}

function codes(result: ReturnType<typeof collectSignals>): string[] {
  return result.warnings.map((w) => w.code);
}

// --- the fully resolvable case ------------------------------------------------------------------

test('a fully linked case produces a complete record and no warnings', () => {
  const result = collectSignals(input());
  assert.equal(result.records.length, 1);
  assert.deepEqual(result.warnings, []);

  const record = result.records[0];
  assert.equal(record.caseId, 'C-1');
  assert.equal(record.title, 'Checkout total is correct');
  assert.equal(record.riskBand, 'high');
  assert.equal(record.assertion.hasAutomation, true);
  assert.equal(record.assertion.cannotFail, false);
  assert.equal(record.suppression, null);
  assert.equal(record.traceability, 'IN_SYNC');
  assert.deepEqual(record.duplicateOfCaseIds, []);
  assert.deepEqual(record.execution, {
    totalRuns: 340,
    failedRuns: 2,
    lastRunAt: '2026-08-29T00:00:00.000Z',
  });
});

test('a placebo assertion reaches the record and then PROTECTING_NOTHING', () => {
  const result = collectSignals(
    input({ specs: [{ path: SPEC_PATH, content: specSource(PLACEBO_ASSERTION) }] }),
  );
  assert.equal(result.records[0].assertion.cannotFail, true);
  assert.equal(classifyCase(result.records[0], NOW).verdict, 'PROTECTING_NOTHING');
});

// --- nothing is silently dropped -----------------------------------------------------------------

test('a case with no traceability entry still produces a record', () => {
  const result = collectSignals(input({ traceability: [] }));
  assert.equal(result.records.length, 1, 'the case must not vanish from the report');
  assert.equal(result.records[0].assertion.hasAutomation, false);
  assert.equal(result.records[0].traceability, 'UNLINKED');
  assert.deepEqual(codes(result), ['no-traceability-entry']);
});

test('a link to a spec file that is no longer there is a warning, not a silent drop', () => {
  const result = collectSignals(input({ specs: [] }));
  assert.equal(result.records.length, 1);
  assert.deepEqual(codes(result), ['spec-file-missing']);
  assert.match(result.warnings[0].message, /moved or been deleted/);
});

test('a link to a renamed test is reported as test-not-found', () => {
  const result = collectSignals(
    input({ specs: [{ path: SPEC_PATH, content: specSource(REAL_ASSERTION, 'renamed since') }] }),
  );
  assert.deepEqual(codes(result), ['test-not-found']);
  assert.equal(result.records[0].assertion.hasAutomation, false);
});

test('a shared spec file with no recorded testTitle is refused, not guessed', () => {
  const twoTests =
    "import { test, expect } from '@playwright/test';\n\n" +
    "test('first', async ({ page }) => {\n" +
    REAL_ASSERTION +
    '\n});\n\n' +
    "test('second', async () => {\n" +
    PLACEBO_ASSERTION +
    '\n});\n';

  const result = collectSignals(
    input({
      traceability: [entry({ testTitle: undefined })],
      specs: [{ path: SPEC_PATH, content: twoTests }],
    }),
  );
  assert.deepEqual(codes(result), ['ambiguous-test-title']);
  assert.equal(
    result.records[0].assertion.hasAutomation,
    false,
    'attributing a placebo to the wrong scenario is a false accusation against a named test',
  );
});

test('a single-test file with no recorded testTitle resolves without a warning', () => {
  const result = collectSignals(input({ traceability: [entry({ testTitle: undefined })] }));
  assert.deepEqual(result.warnings, []);
  assert.equal(result.records[0].assertion.hasAutomation, true);
});

// --- suppression ---------------------------------------------------------------------------------

test('a quarantined test carries its real quarantine date', () => {
  const result = collectSignals(input({ quarantine: [quarantineEntry()] }));
  assert.deepEqual(result.records[0].suppression, {
    kind: 'quarantined',
    since: '2026-04-14T00:00:00.000Z',
  });
  assert.equal(classifyCase(result.records[0], NOW).verdict, 'SUPPRESSED');
});

test('a file-scoped quarantine entry suppresses a test in that file', () => {
  const result = collectSignals(
    input({ quarantine: [quarantineEntry({ testTitle: undefined })] }),
  );
  assert.equal(result.records[0].suppression?.kind, 'quarantined');
});

test('a quarantine entry for a different test in the same file does not suppress this one', () => {
  const result = collectSignals(
    input({ quarantine: [quarantineEntry({ testTitle: 'some other test' })] }),
  );
  assert.equal(result.records[0].suppression, null);
});

test('a test.skip with a known start date carries that date', () => {
  const result = collectSignals(
    input({
      specs: [{ path: SPEC_PATH, content: specSource(REAL_ASSERTION, 'checkout total is correct', 'test.skip') }],
      suppressedSince: { [`${SPEC_PATH}::checkout total is correct`]: '2026-05-01T00:00:00.000Z' },
    }),
  );
  assert.deepEqual(result.records[0].suppression, {
    kind: 'skipped',
    since: '2026-05-01T00:00:00.000Z',
  });
  assert.deepEqual(result.warnings, []);
});

test('a test.skip with no known start date is still reported, with the date flagged unknown', () => {
  // Dropping it would restore exactly the false confidence the report exists to remove:
  // the case stays in the coverage figure while covering nothing.
  const result = collectSignals(
    input({
      specs: [{ path: SPEC_PATH, content: specSource(REAL_ASSERTION, 'checkout total is correct', 'test.skip') }],
    }),
  );
  assert.equal(result.records[0].suppression?.kind, 'skipped');
  assert.equal(result.records[0].suppression?.since, null);
  assert.deepEqual(codes(result), ['suppression-date-unknown']);
  assert.match(result.warnings[0].message, /not as zero/);
});

test('a test.fixme is recorded as fixme, not as skipped', () => {
  const result = collectSignals(
    input({
      specs: [{ path: SPEC_PATH, content: specSource(REAL_ASSERTION, 'checkout total is correct', 'test.fixme') }],
      suppressedSince: { [`${SPEC_PATH}::checkout total is correct`]: '2026-05-01T00:00:00.000Z' },
    }),
  );
  assert.equal(result.records[0].suppression?.kind, 'fixme');
});

test('quarantine wins over a static skip when both are present', () => {
  const result = collectSignals(
    input({
      quarantine: [quarantineEntry()],
      specs: [{ path: SPEC_PATH, content: specSource(REAL_ASSERTION, 'checkout total is correct', 'test.skip') }],
    }),
  );
  assert.equal(result.records[0].suppression?.since, '2026-04-14T00:00:00.000Z');
  assert.deepEqual(result.warnings, [], 'a real date is known, so nothing is unknown');
});

// --- traceability --------------------------------------------------------------------------------

test('the manifest sync state passes through unchanged', () => {
  const result = collectSignals(input({ traceability: [entry({ syncState: 'CASE_DRIFTED' })] }));
  assert.equal(result.records[0].traceability, 'CASE_DRIFTED');
  assert.equal(classifyCase(result.records[0], NOW).verdict, 'STALE');
});

test('a duplicated link keeps the first entry rather than depending on order', () => {
  const result = collectSignals(
    input({
      traceability: [entry({ syncState: 'IN_SYNC' }), entry({ syncState: 'ORPHANED_CASE' })],
    }),
  );
  assert.equal(result.records[0].traceability, 'IN_SYNC');
});

// --- duplicates ----------------------------------------------------------------------------------

test('duplicate groups become per-case sibling lists, excluding the case itself', () => {
  const result = collectSignals(
    input({
      cases: [
        { caseId: 'C-1', title: 'one' },
        { caseId: 'C-2', title: 'two' },
      ],
      riskBands: { 'C-1': 'high', 'C-2': 'high' },
      execution: [
        { caseId: 'C-1', totalRuns: 5, failedRuns: 1, lastRunAt: '2026-08-29T00:00:00.000Z' },
        { caseId: 'C-2', totalRuns: 5, failedRuns: 1, lastRunAt: '2026-08-29T00:00:00.000Z' },
      ],
      traceability: [entry(), entry({ externalCaseId: 'C-2' })],
      duplicateGroups: [['C-1', 'C-2']],
    }),
  );
  assert.deepEqual(result.records[0].duplicateOfCaseIds, ['C-2']);
  assert.deepEqual(result.records[1].duplicateOfCaseIds, ['C-1']);
});

test('an empty duplicateGroups means the DUPLICATE verdict never fires', () => {
  // checkDuplicateCoverage compares scenarios within one generated batch, not the whole corpus,
  // so until a corpus-wide pass exists this is the honest input.
  const result = collectSignals(input({ duplicateGroups: [] }));
  assert.notEqual(classifyCase(result.records[0], NOW).verdict, 'DUPLICATE');
});

// --- execution and risk ---------------------------------------------------------------------------

test('a case with no run history counts as never executed and says so', () => {
  const result = collectSignals(input({ execution: [] }));
  assert.deepEqual(result.records[0].execution, { totalRuns: 0, failedRuns: 0, lastRunAt: null });
  assert.deepEqual(codes(result), ['no-execution-history']);
});

test('an unconfigured risk band falls to the middle band and is warned about', () => {
  const result = collectSignals(input({ riskBands: {} }));
  assert.equal(result.records[0].riskBand, DEFAULT_RISK_BAND);
  assert.deepEqual(codes(result), ['risk-band-not-configured']);
  assert.match(result.warnings[0].message, /never inferred/);
});

test('an unconfigured risk band cannot produce COLD_BUT_LOAD_BEARING', () => {
  // That verdict says "keep this, it is protecting something important". It must never rest on a
  // guessed risk band.
  const result = collectSignals(
    input({
      riskBands: {},
      execution: [{ caseId: 'C-1', totalRuns: 340, failedRuns: 0, lastRunAt: '2026-08-29T00:00:00.000Z' }],
    }),
  );
  assert.equal(classifyCase(result.records[0], NOW).verdict, 'HEALTHY');
});

// --- determinism ------------------------------------------------------------------------------------

test('records follow case input order so two runs produce identical output', () => {
  const cases = [
    { caseId: 'C-3', title: 'three' },
    { caseId: 'C-1', title: 'one' },
    { caseId: 'C-2', title: 'two' },
  ];
  const result = collectSignals(input({ cases, traceability: [], execution: [], riskBands: {} }));
  assert.deepEqual(
    result.records.map((r) => r.caseId),
    ['C-3', 'C-1', 'C-2'],
  );
  assert.deepEqual(
    result.warnings.map((w) => w.caseId),
    ['C-3', 'C-3', 'C-3', 'C-1', 'C-1', 'C-1', 'C-2', 'C-2', 'C-2'],
  );
});

test('collecting an empty corpus is not an error', () => {
  const result = collectSignals(
    input({ cases: [], traceability: [], specs: [], execution: [], riskBands: {} }),
  );
  assert.deepEqual(result.records, []);
  assert.deepEqual(result.warnings, []);
});

// --- automation nobody is counting ---------------------------------------------------------------

test('a test linked to no case at all is reported separately', () => {
  const unlinked = findUnlinkedTests(
    [
      { path: SPEC_PATH, content: specSource(REAL_ASSERTION) },
      { path: 'tests/orphan.spec.ts', content: specSource(PLACEBO_ASSERTION, 'nobody counts me') },
    ],
    [entry()],
  );
  assert.equal(unlinked.length, 1);
  assert.equal(unlinked[0].title, 'nobody counts me');
  assert.equal(unlinked[0].assertion.cannotFail, true);
});

test('a file-scoped link claims every test in that file', () => {
  const twoTests =
    "import { test, expect } from '@playwright/test';\n\n" +
    "test('first', async ({ page }) => {\n" +
    REAL_ASSERTION +
    '\n});\n\n' +
    "test('second', async ({ page }) => {\n" +
    REAL_ASSERTION +
    '\n});\n';

  const unlinked = findUnlinkedTests(
    [{ path: SPEC_PATH, content: twoTests }],
    [entry({ testTitle: undefined })],
  );
  assert.deepEqual(unlinked, []);
});

test('a title-scoped link claims only its own test, not its siblings', () => {
  const twoTests =
    "import { test, expect } from '@playwright/test';\n\n" +
    "test('first', async ({ page }) => {\n" +
    REAL_ASSERTION +
    '\n});\n\n' +
    "test('second', async ({ page }) => {\n" +
    REAL_ASSERTION +
    '\n});\n';

  const unlinked = findUnlinkedTests(
    [{ path: SPEC_PATH, content: twoTests }],
    [entry({ testTitle: 'first' })],
  );
  assert.equal(unlinked.length, 1);
  assert.equal(unlinked[0].title, 'second');
});
