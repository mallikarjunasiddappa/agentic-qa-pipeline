import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applySuppressions, findSuppressionComments } from './suppression';
import { compareTestBlocks, extractTestBlocks } from './astDiff';

test('findSuppressionComments matches em dash, double hyphen, and single hyphen separators', () => {
  const source = [
    '// assertion-integrity: approved — em dash reason',
    '// assertion-integrity: approved -- double hyphen reason',
    '// assertion-integrity: approved - single hyphen reason',
  ].join('\n');
  const comments = findSuppressionComments(source);
  assert.equal(comments.length, 3);
  assert.equal(comments[0].reason, 'em dash reason');
  assert.equal(comments[1].reason, 'double hyphen reason');
  assert.equal(comments[2].reason, 'single hyphen reason');
});

test('findSuppressionComments requires a real reason, not a bare tag', () => {
  const source = '// assertion-integrity: approved —';
  assert.deepEqual(findSuppressionComments(source), []);
});

test('findSuppressionComments ignores a trailing same-line comment (must be its own line)', () => {
  const source = "await x(); // assertion-integrity: approved — reason";
  assert.deepEqual(findSuppressionComments(source), []);
});

test('applySuppressions: line-anchored finding is cleared only by the exact preceding line', () => {
  const oldSource = `
test('x', async ({ page }) => {
  await expect(page.getByTestId('a')).toHaveText('foo');
});
`;
  const suppressedNew = `
test('x', async ({ page }) => {
  // assertion-integrity: approved — intentionally loosened, see JIRA-99
  await expect(page.getByTestId('a')).toBeVisible();
});
`;
  const oldBlocks = extractTestBlocks(oldSource);
  const newBlocks = extractTestBlocks(suppressedNew);
  const findings = compareTestBlocks(oldBlocks, newBlocks);
  assert.ok(findings.some((f) => f.type === 'strict_to_weak'));

  const results = applySuppressions(findings, suppressedNew);
  const swap = results.find((r) => r.finding.type === 'strict_to_weak')!;
  assert.equal(swap.suppressed, true);
  assert.equal(swap.suppressionReason, 'intentionally loosened, see JIRA-99');
});

test('applySuppressions: a comment two lines above (not immediately preceding) does not suppress', () => {
  const oldSource = `
test('x', async ({ page }) => {
  await expect(page.getByTestId('a')).toHaveText('foo');
});
`;
  const notImmediatelyAbove = `
test('x', async ({ page }) => {
  // assertion-integrity: approved — reason

  await expect(page.getByTestId('a')).toBeVisible();
});
`;
  const oldBlocks = extractTestBlocks(oldSource);
  const newBlocks = extractTestBlocks(notImmediatelyAbove);
  const findings = compareTestBlocks(oldBlocks, newBlocks);
  const results = applySuppressions(findings, notImmediatelyAbove);
  const swap = results.find((r) => r.finding.type === 'strict_to_weak')!;
  assert.equal(swap.suppressed, false);
});

test('applySuppressions: test-scoped fallback clears a fully-deleted-assertion finding from anywhere in that test body', () => {
  const oldSource = `
test('x', async ({ page }) => {
  await expect(page.getByTestId('a')).toBeVisible();
  await expect(page.getByTestId('b')).toHaveText('foo');
});
`;
  const newSource = `
test('x', async ({ page }) => {
  // assertion-integrity: approved — dropped the redundant visibility check
  await expect(page.getByTestId('b')).toHaveText('foo');
});
`;
  const oldBlocks = extractTestBlocks(oldSource);
  const newBlocks = extractTestBlocks(newSource);
  const findings = compareTestBlocks(oldBlocks, newBlocks);
  assert.ok(findings.length > 0);

  const results = applySuppressions(findings, newSource);
  assert.ok(results.every((r) => r.suppressed));
});

test('applySuppressions: a test-scoped comment in test a does not suppress a finding in test b (not file-scoped)', () => {
  const oldSource = `
test('a', async ({ page }) => {
  await expect(page.getByTestId('x')).toBeVisible();
  await expect(page.getByTestId('shared')).toHaveText('foo');
});
test('b', async ({ page }) => {
  await expect(page.getByTestId('y')).toBeVisible();
  await expect(page.getByTestId('shared')).toHaveText('bar');
});
`;
  const newSource = `
test('a', async ({ page }) => {
  // assertion-integrity: approved — dropped in test a only
  await expect(page.getByTestId('shared')).toHaveText('foo');
});
test('b', async ({ page }) => {
  await expect(page.getByTestId('shared')).toHaveText('bar');
});
`;
  const oldBlocks = extractTestBlocks(oldSource);
  const newBlocks = extractTestBlocks(newSource);
  const findings = compareTestBlocks(oldBlocks, newBlocks);
  const results = applySuppressions(findings, newSource);

  const testAFindings = results.filter((r) => r.finding.testTitle === 'a');
  const testBFindings = results.filter((r) => r.finding.testTitle === 'b');
  assert.ok(testAFindings.length > 0 && testAFindings.every((r) => r.suppressed));
  assert.ok(testBFindings.length > 0 && testBFindings.every((r) => !r.suppressed));
});
