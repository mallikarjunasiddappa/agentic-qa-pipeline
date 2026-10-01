import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyseSpecFile,
  analyseSpecFiles,
  indexAnalyses,
  testKey,
  NO_AUTOMATION_ASSERTION_STATE,
} from './detectUnfailableAssertions';
import { classifyCase, type SuiteCaseRecord } from './classify';

const PATH = 'tests/checkout.spec.ts';

/** Wraps a body in a real Playwright test declaration so the ts-morph parse sees what it expects. */
function spec(body: string, declaration = "test('does a thing', async ({ page }) => {"): string {
  return `import { test, expect } from '@playwright/test';\n\n${declaration}\n${body}\n});\n`;
}

function only(source: string) {
  const analyses = analyseSpecFile(source, PATH);
  assert.equal(analyses.length, 1, 'expected exactly one test block to be parsed');
  return analyses[0];
}

// --- the ordinary case ------------------------------------------------------------------------

test('a test with a real assertion can fail', () => {
  const result = only(spec("  await expect(page.locator('#total')).toHaveText('120 kr');"));
  assert.equal(result.assertion.hasAutomation, true);
  assert.equal(result.assertion.cannotFail, false);
  assert.equal(result.assertion.cannotFailReason, undefined);
  assert.deepEqual(result.evidence, []);
});

test('the file path and title are carried through for the case lookup', () => {
  const result = only(spec("  await expect(page.locator('#total')).toHaveText('120 kr');"));
  assert.equal(result.filePath, PATH);
  assert.equal(result.title, 'does a thing');
  assert.ok(result.bodyStartLine > 0);
});

// --- no assertion at all ----------------------------------------------------------------------

test('a test body with no expect() call cannot fail', () => {
  const result = only(spec("  await page.goto('/checkout');\n  await page.click('#pay');"));
  assert.equal(result.assertion.cannotFail, true);
  assert.equal(result.assertion.cannotFailReason, 'no-assertions');
});

test('a no-assertion verdict still carries evidence', () => {
  const result = only(spec("  await page.goto('/checkout');"));
  assert.equal(result.evidence.length, 1);
  assert.match(result.evidence[0], /no expect\(\) call/);
});

// --- swallowed --------------------------------------------------------------------------------

test('an assertion inside try/catch with no rethrow cannot fail', () => {
  const result = only(
    spec(
      '  try {\n' +
        "    await expect(page.locator('#total')).toHaveText('120 kr');\n" +
        '  } catch (error) {\n' +
        "    console.log('ignored', error);\n" +
        '  }',
    ),
  );
  assert.equal(result.assertion.cannotFail, true);
  assert.equal(result.assertion.cannotFailReason, 'all-assertions-swallowed');
});

test('a try/catch that rethrows does NOT swallow the assertion', () => {
  const result = only(
    spec(
      '  try {\n' +
        "    await expect(page.locator('#total')).toHaveText('120 kr');\n" +
        '  } catch (error) {\n' +
        '    throw error;\n' +
        '  }',
    ),
  );
  assert.equal(result.assertion.cannotFail, false);
});

test('an assertion chained to .catch() cannot fail', () => {
  const result = only(
    spec("  await expect(page.locator('#total')).toHaveText('120 kr').catch(() => {});"),
  );
  assert.equal(result.assertion.cannotFail, true);
  assert.equal(result.assertion.cannotFailReason, 'all-assertions-swallowed');
});

test('one live assertion rescues a test that also has a swallowed one', () => {
  const result = only(
    spec(
      '  try {\n' +
        "    await expect(page.locator('#banner')).toBeVisible();\n" +
        '  } catch (error) {\n' +
        "    console.log('ignored', error);\n" +
        '  }\n' +
        "  await expect(page.locator('#total')).toHaveText('120 kr');",
    ),
  );
  assert.equal(result.assertion.cannotFail, false);
});

// --- tautological -----------------------------------------------------------------------------

test('expect(true).toBe(true) is decided before the test ever runs', () => {
  const result = only(spec('  expect(true).toBe(true);'));
  assert.equal(result.assertion.cannotFail, true);
  assert.equal(result.assertion.cannotFailReason, 'all-assertions-tautological');
});

test('a numeric comparison between two literals is tautological', () => {
  const result = only(spec('  expect(1).toBeGreaterThan(0);'));
  assert.equal(result.assertion.cannotFailReason, 'all-assertions-tautological');
});

test('a matcher with no argument on a literal subject is tautological', () => {
  const result = only(spec('  expect(true).toBeTruthy();'));
  assert.equal(result.assertion.cannotFailReason, 'all-assertions-tautological');
});

test('negation does not rescue a tautology', () => {
  const result = only(spec('  expect(1).not.toBe(2);'));
  assert.equal(result.assertion.cannotFailReason, 'all-assertions-tautological');
});

test('two string literals compared to each other are tautological', () => {
  const result = only(spec("  expect('paid').toBe('paid');"));
  assert.equal(result.assertion.cannotFailReason, 'all-assertions-tautological');
});

test('a literal subject compared against a real value is NOT tautological', () => {
  // expect(true).toBe(status) can genuinely fail. Flagging it would be a false accusation, and
  // one false accusation in the top twenty rows is how the whole report stops being read.
  const result = only(spec('  expect(true).toBe(status);'));
  assert.equal(result.assertion.cannotFail, false);
});

test('a tautology verdict quotes the assertion as evidence', () => {
  const result = only(spec('  expect(true).toBe(true);'));
  assert.equal(result.evidence.length, 1);
  assert.match(result.evidence[0], /expect\(true\)\.toBe\(true\)/);
  assert.match(result.evidence[0], /^line \d+:/);
});

// --- mixed ------------------------------------------------------------------------------------

test('swallowed plus tautological, with nothing effective left, is reported as its own reason', () => {
  const result = only(
    spec(
      '  try {\n' +
        "    await expect(page.locator('#total')).toHaveText('120 kr');\n" +
        '  } catch (error) {\n' +
        "    console.log('ignored', error);\n" +
        '  }\n' +
        '  expect(true).toBe(true);',
    ),
  );
  assert.equal(result.assertion.cannotFail, true);
  assert.equal(result.assertion.cannotFailReason, 'no-effective-assertions');
  assert.equal(result.evidence.length, 2);
});

// --- weak-only, which is deliberately NOT cannot-fail -------------------------------------------

test('a test that only checks visibility is weakOnly but can still fail', () => {
  const result = only(
    spec(
      "  await expect(page.locator('#banner')).toBeVisible();\n" +
        "  await expect(page.locator('#total')).toBeAttached();",
    ),
  );
  assert.equal(result.weakOnly, true);
  assert.equal(result.assertion.cannotFail, false, 'toBeVisible can fail - the element can be gone');
  assert.equal(result.evidence.length, 2);
});

test('one strict matcher is enough to clear weakOnly', () => {
  const result = only(
    spec(
      "  await expect(page.locator('#banner')).toBeVisible();\n" +
        "  await expect(page.locator('#total')).toHaveText('120 kr');",
    ),
  );
  assert.equal(result.weakOnly, false);
});

test('an unclassified matcher is not treated as weak', () => {
  // classifyMatcher returns null for anything not in the table. Guessing "weak" for an unknown
  // matcher would grow the weak-only list every time somebody adds a custom matcher.
  const result = only(spec("  await expect(page.locator('#total')).toHaveScreenshot();"));
  assert.equal(result.weakOnly, false);
  assert.equal(result.assertion.cannotFail, false);
});

test('a test with no assertions is not weakOnly - it is already the harder finding', () => {
  const result = only(spec("  await page.goto('/checkout');"));
  assert.equal(result.weakOnly, false);
});

// --- suppression is recorded, never conflated ---------------------------------------------------

test('a skipped test is recorded as skipped and its assertion is judged on its own merits', () => {
  const result = only(
    spec(
      "  await expect(page.locator('#total')).toHaveText('120 kr');",
      "test.skip('does a thing', async ({ page }) => {",
    ),
  );
  assert.equal(result.isSkipped, true);
  assert.equal(
    result.assertion.cannotFail,
    false,
    'a skipped test is not running; that is a different problem from a broken assertion',
  );
});

test('a fixme test is recorded as fixme', () => {
  const result = only(
    spec(
      "  await expect(page.locator('#total')).toHaveText('120 kr');",
      "test.fixme('does a thing', async ({ page }) => {",
    ),
  );
  assert.equal(result.isFixme, true);
  assert.equal(result.isSkipped, false);
});

// --- multiple tests and files -------------------------------------------------------------------

test('every test in a file is judged separately', () => {
  const source =
    "import { test, expect } from '@playwright/test';\n\n" +
    "test('good', async ({ page }) => {\n" +
    "  await expect(page.locator('#total')).toHaveText('120 kr');\n" +
    '});\n\n' +
    "test('placebo', async () => {\n" +
    '  expect(true).toBe(true);\n' +
    '});\n';

  const analyses = analyseSpecFile(source, PATH);
  assert.equal(analyses.length, 2);
  assert.equal(analyses[0].assertion.cannotFail, false);
  assert.equal(analyses[1].assertion.cannotFail, true);
});

test('analysing many files preserves input order so the report is reproducible', () => {
  const analyses = analyseSpecFiles([
    { path: 'b.spec.ts', content: spec('  expect(true).toBe(true);') },
    { path: 'a.spec.ts', content: spec("  await expect(page.locator('#x')).toHaveText('y');") },
  ]);
  assert.deepEqual(
    analyses.map((a) => a.filePath),
    ['b.spec.ts', 'a.spec.ts'],
  );
});

// --- the index the collector uses ---------------------------------------------------------------

test('analyses are addressable by (file path, test title)', () => {
  const analyses = analyseSpecFile(spec('  expect(true).toBe(true);'), PATH);
  const index = indexAnalyses(analyses);
  const found = index.get(testKey(PATH, 'does a thing'));
  assert.ok(found);
  assert.equal(found.assertion.cannotFailReason, 'all-assertions-tautological');
});

test('a duplicated test title keeps the first occurrence rather than depending on order', () => {
  const source =
    "import { test, expect } from '@playwright/test';\n\n" +
    "test('same title', async ({ page }) => {\n" +
    "  await expect(page.locator('#total')).toHaveText('120 kr');\n" +
    '});\n\n' +
    "test('same title', async () => {\n" +
    '  expect(true).toBe(true);\n' +
    '});\n';

  const index = indexAnalyses(analyseSpecFile(source, PATH));
  assert.equal(index.size, 1);
  assert.equal(index.get(testKey(PATH, 'same title'))!.assertion.cannotFail, false);
});

// --- the seam with classify.ts ------------------------------------------------------------------

function caseWith(assertion: SuiteCaseRecord['assertion']): SuiteCaseRecord {
  return {
    caseId: 'C-1',
    title: 'Checkout total is correct',
    riskBand: 'high',
    assertion,
    suppression: null,
    traceability: 'IN_SYNC',
    duplicateOfCaseIds: [],
    execution: { totalRuns: 340, failedRuns: 0, lastRunAt: '2026-08-29T00:00:00.000Z' },
  };
}

test('an unfailable assertion reaches PROTECTING_NOTHING through classifyCase unchanged', () => {
  const result = only(spec('  expect(true).toBe(true);'));
  const health = classifyCase(caseWith(result.assertion), new Date('2026-08-30T09:00:00.000Z'));
  assert.equal(health.verdict, 'PROTECTING_NOTHING');
  assert.equal(health.action, 'fix-assertion');
  assert.ok(health.reasons.some((r) => r.message.includes('all-assertions-tautological')));
});

test('a real assertion on a cold high-risk case reaches COLD_BUT_LOAD_BEARING, not PROTECTING_NOTHING', () => {
  const result = only(spec("  await expect(page.locator('#total')).toHaveText('120 kr');"));
  const health = classifyCase(caseWith(result.assertion), new Date('2026-08-30T09:00:00.000Z'));
  assert.equal(health.verdict, 'COLD_BUT_LOAD_BEARING');
  assert.equal(health.action, 'keep');
});

test('a case with no automation is not accused of having a broken assertion', () => {
  assert.equal(NO_AUTOMATION_ASSERTION_STATE.hasAutomation, false);
  assert.equal(NO_AUTOMATION_ASSERTION_STATE.cannotFail, false);

  const record = caseWith(NO_AUTOMATION_ASSERTION_STATE);
  record.execution = { totalRuns: 0, failedRuns: 0, lastRunAt: null };
  const health = classifyCase(record, new Date('2026-08-30T09:00:00.000Z'));
  assert.equal(health.verdict, 'ORPHANED');
  assert.equal(health.action, 'verify-then-archive');
});

test('nothing this analyser produces recommends a deletion', () => {
  const sources = [
    spec('  expect(true).toBe(true);'),
    spec("  await page.goto('/checkout');"),
    spec("  await expect(page.locator('#banner')).toBeVisible();"),
  ];
  const now = new Date('2026-08-30T09:00:00.000Z');
  for (const source of sources) {
    const health = classifyCase(caseWith(only(source).assertion), now);
    assert.notEqual(health.action as string, 'delete');
    assert.notEqual(health.action, 'consolidate');
  }
});
