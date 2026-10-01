import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Project, SyntaxKind } from 'ts-morph';
import { getTestTitle, isTestCallExpression, readTestModifier } from './testCallExpression';
import { findTestBlocks } from './testBlocks';
import { extractTestBlocks } from '../assertionGuard/astDiff';

function firstCall(source: string) {
  const project = new Project({ useInMemoryFileSystem: true });
  const file = project.createSourceFile('a.spec.ts', source, { overwrite: true });
  const call = file
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .find((c) => isTestCallExpression(c));
  assert.ok(call, 'expected a test call in the source');
  return call;
}

function spec(body: string): string {
  return `import { test, expect } from '@playwright/test';\n\n${body}\n`;
}

// --- what counts as a test ---------------------------------------------------------------------

test('a bare test(...) has no modifier', () => {
  assert.equal(readTestModifier(firstCall(spec("test('a', async () => {});"))), null);
});

test('every Playwright modifier that declares a runnable test is recognised', () => {
  for (const modifier of ['only', 'skip', 'fixme', 'slow', 'fail'] as const) {
    const call = firstCall(spec(`test.${modifier}('a', async () => {});`));
    assert.equal(readTestModifier(call), modifier, `test.${modifier} should be recognised`);
  }
});

test('test.describe and hooks are not tests', () => {
  const project = new Project({ useInMemoryFileSystem: true });
  const file = project.createSourceFile(
    'a.spec.ts',
    spec("test.describe('group', () => {\n  test.beforeEach(async () => {});\n});"),
    { overwrite: true },
  );
  const testCalls = file
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .filter((c) => isTestCallExpression(c));
  assert.deepEqual(testCalls, []);
});

test('an unrelated function named something else is not a test', () => {
  const project = new Project({ useInMemoryFileSystem: true });
  const file = project.createSourceFile('a.spec.ts', "check('a', () => {});", { overwrite: true });
  const call = file.getDescendantsOfKind(SyntaxKind.CallExpression)[0];
  assert.equal(readTestModifier(call), undefined);
  assert.equal(isTestCallExpression(call), false);
});

// --- titles -------------------------------------------------------------------------------------

test('a string-literal title is read', () => {
  assert.equal(getTestTitle(firstCall(spec("test('checkout works', async () => {});"))), 'checkout works');
});

test('a backtick title with no interpolation is read', () => {
  assert.equal(getTestTitle(firstCall(spec('test(`checkout works`, async () => {});'))), 'checkout works');
});

test('a computed title is refused rather than guessed', () => {
  // A title built at runtime cannot be matched back to a manifest entry or a test-management case.
  // Recording it under a guessed title attaches every later verdict to the wrong test.
  assert.equal(getTestTitle(firstCall(spec('test(`case ${id}`, async () => {});'))), null);
  assert.equal(getTestTitle(firstCall(spec('test(titleVar, async () => {});'))), null);
});

// --- the parity these two parsers used to lack ---------------------------------------------------

const PARITY_SOURCE = spec(
  "test.describe('Group', () => {\n" +
    "  test('plain title', async ({ page }) => {\n" +
    "    await expect(page.locator('#a')).toHaveText('x');\n" +
    '  });\n' +
    '  test.only(`focused with a backtick title`, async ({ page }) => {\n' +
    "    await expect(page.locator('#b')).toHaveText('y');\n" +
    '  });\n' +
    "  test.skip('skipped one', async () => {});\n" +
    "  test.fail('expected to fail', async () => {});\n" +
    "  test.slow('a slow one', async () => {});\n" +
    '});',
);

test('findTestBlocks and extractTestBlocks agree on which tests exist', () => {
  // They did not, and nothing failed when they disagreed. findTestBlocks ignored backtick titles;
  // extractTestBlocks ignored .only, .slow and .fail. Which guardrails applied to a test depended
  // on how it happened to be written.
  const fromTestBlocks = findTestBlocks(PARITY_SOURCE, 'a.spec.ts').map((b) => b.testTitle).sort();
  const fromAstDiff = extractTestBlocks(PARITY_SOURCE, 'a.spec.ts').map((b) => b.title).sort();
  assert.deepEqual(fromTestBlocks, fromAstDiff);
  assert.equal(fromTestBlocks.length, 5);
});

test('a focused test is visible to the assertion guard', () => {
  // This is the regression that mattered most: marking a test .only while iterating used to make
  // it invisible to extractTestBlocks, so an assertion weakened in the same pull request was never
  // diffed - at exactly the moment its author was editing it.
  const blocks = extractTestBlocks(
    spec("test.only('focused', async ({ page }) => {\n  await expect(page.locator('#a')).toHaveText('x');\n});"),
    'a.spec.ts',
  );
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].title, 'focused');
  assert.equal(blocks[0].assertions.length, 1);
});

test('a backtick-titled test is visible to the coverage and tag guards', () => {
  const blocks = findTestBlocks(spec('test(`backtick title`, async () => {});'), 'a.spec.ts');
  assert.deepEqual(blocks.map((b) => b.testTitle), ['backtick title']);
});

test('.only is still reported as not skipped', () => {
  // Recognising a modifier must not change what the modifier MEANS.
  const [block] = extractTestBlocks(spec("test.only('focused', async () => {});"), 'a.spec.ts');
  assert.equal(block.isSkipped, false);
  assert.equal(block.fixme, null);
});

test('.skip and .fixme keep their existing meaning', () => {
  const [skipped] = extractTestBlocks(spec("test.skip('s', async () => {});"), 'a.spec.ts');
  const [fixme] = extractTestBlocks(spec("test.fixme('f', async () => {});"), 'a.spec.ts');
  assert.equal(skipped.isSkipped, true);
  assert.equal(skipped.fixme, null);
  assert.equal(fixme.isSkipped, false);
  assert.ok(fixme.fixme);
});
