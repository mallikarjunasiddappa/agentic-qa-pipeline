import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareTestBlocks, extractTestBlocks } from './astDiff';

function diff(oldSource: string, newSource: string) {
  const oldBlocks = extractTestBlocks(oldSource, 'old.spec.ts');
  const newBlocks = extractTestBlocks(newSource, 'new.spec.ts');
  return compareTestBlocks(oldBlocks, newBlocks);
}

test('extractTestBlocks finds title, matcher, subject, and line for a simple assertion', () => {
  const source = `
test('should log in', async ({ page }) => {
  await expect(page.getByRole('heading')).toHaveText('Welcome');
});
`;
  const [block] = extractTestBlocks(source);
  assert.equal(block.title, 'should log in');
  assert.equal(block.assertions.length, 1);
  assert.equal(block.assertions[0].matcher, 'toHaveText');
  assert.equal(block.assertions[0].subjectText, "page.getByRole('heading')");
  assert.equal(block.assertions[0].strength, 'strict');
});

test('extractTestBlocks handles a 3-arg test() with an options object', () => {
  const source = `
test('x', { tag: ['@smoke'] }, async ({ page }) => {
  await expect(page).toHaveURL(/dashboard/);
});
`;
  const [block] = extractTestBlocks(source);
  assert.equal(block.title, 'x');
  assert.equal(block.assertions[0].matcher, 'toHaveURL');
});

test('compareTestBlocks: a real assertion removal flags with a test-scoped anchor', () => {
  const oldSource = `
test('x', async ({ page }) => {
  await expect(page.getByTestId('a')).toBeVisible();
  await expect(page.getByTestId('b')).toHaveText('foo');
});
`;
  const newSource = `
test('x', async ({ page }) => {
  await expect(page.getByTestId('a')).toBeVisible();
});
`;
  const findings = diff(oldSource, newSource);
  const removed = findings.filter((f) => f.type === 'assertion_removed');
  assert.ok(removed.length >= 1);
  assert.ok(removed.some((f) => f.anchor.kind === 'test'));
});

test('compareTestBlocks: a strict-to-weak matcher swap on the same subject flags with a line anchor', () => {
  const oldSource = `
test('x', async ({ page }) => {
  await expect(page.getByTestId('refund-status')).toHaveText('Refunded');
});
`;
  const newSource = `
test('x', async ({ page }) => {
  await expect(page.getByTestId('refund-status')).toBeVisible();
});
`;
  const findings = diff(oldSource, newSource);
  const swap = findings.find((f) => f.type === 'strict_to_weak');
  assert.ok(swap);
  assert.equal(swap!.anchor.kind, 'line');
  assert.equal(swap!.subjectText, "page.getByTestId('refund-status')");
});

test('compareTestBlocks: strict-to-strict or weak-to-weak on the same subject does not flag', () => {
  const oldSource = `
test('x', async ({ page }) => {
  await expect(page.getByTestId('a')).toHaveText('foo');
  await expect(page.getByTestId('b')).toBeVisible();
});
`;
  const newSource = `
test('x', async ({ page }) => {
  await expect(page.getByTestId('a')).toHaveValue('foo');
  await expect(page.getByTestId('b')).toBeEnabled();
});
`;
  const findings = diff(oldSource, newSource);
  assert.deepEqual(findings, []);
});

test('compareTestBlocks: unmatched (new/renamed) test titles are ignored', () => {
  const oldSource = `
test('old title', async ({ page }) => {
  await expect(page.getByTestId('a')).toHaveText('foo');
});
`;
  const newSource = `
test('a totally different title', async ({ page }) => {
  await expect(page.getByTestId('a')).toBeVisible();
});
`;
  assert.deepEqual(diff(oldSource, newSource), []);
});

test('compareTestBlocks: a new bare test.skip flags; an already-skipped test does not', () => {
  const wasActive = `test('x', async ({ page }) => { await expect(page).toHaveURL(/a/); });`;
  const nowSkipped = `test.skip('x', async ({ page }) => { await expect(page).toHaveURL(/a/); });`;
  const findings = diff(wasActive, nowSkipped);
  assert.ok(findings.some((f) => f.type === 'new_skip'));

  const alreadySkipped = diff(nowSkipped, nowSkipped);
  assert.ok(!alreadySkipped.some((f) => f.type === 'new_skip'));
});

test('compareTestBlocks: a new test.fixme flags only when it has no comment', () => {
  const wasActive = `test('x', async ({ page }) => { await expect(page).toHaveURL(/a/); });`;
  const fixmeNoComment = `test.fixme('x', async ({ page }) => { await expect(page).toHaveURL(/a/); });`;
  const fixmeWithComment = `
// assertion-integrity: approved — flaky env, see JIRA-123
test.fixme('x', async ({ page }) => { await expect(page).toHaveURL(/a/); });
`;

  const flagged = diff(wasActive, fixmeNoComment);
  assert.ok(flagged.some((f) => f.type === 'fixme_missing_comment'));

  const notFlagged = diff(wasActive, fixmeWithComment);
  assert.ok(!notFlagged.some((f) => f.type === 'fixme_missing_comment'));
});

test('compareTestBlocks: a pre-existing uncommented fixme is not re-flagged as "new"', () => {
  const fixmeNoComment = `test.fixme('x', async ({ page }) => { await expect(page).toHaveURL(/a/); });`;
  const findings = diff(fixmeNoComment, fixmeNoComment);
  assert.ok(!findings.some((f) => f.type === 'fixme_missing_comment'));
});

test('compareTestBlocks: an assertion newly wrapped in try/catch that swallows flags', () => {
  const oldSource = `
test('x', async ({ page }) => {
  await expect(page.getByTestId('a')).toBeVisible();
});
`;
  const newSource = `
test('x', async ({ page }) => {
  try {
    await expect(page.getByTestId('a')).toBeVisible();
  } catch {
    // swallowed
  }
});
`;
  const findings = diff(oldSource, newSource);
  assert.ok(findings.some((f) => f.type === 'assertion_swallowed'));
});

test('compareTestBlocks: a try/catch that rethrows does not flag as swallowed', () => {
  const oldSource = `
test('x', async ({ page }) => {
  await expect(page.getByTestId('a')).toBeVisible();
});
`;
  const newSource = `
test('x', async ({ page }) => {
  try {
    await expect(page.getByTestId('a')).toBeVisible();
  } catch (e) {
    throw e;
  }
});
`;
  const findings = diff(oldSource, newSource);
  assert.ok(!findings.some((f) => f.type === 'assertion_swallowed'));
});

test('compareTestBlocks: an assertion newly wrapped in .catch() flags', () => {
  const oldSource = `
test('x', async ({ page }) => {
  await expect(page.getByTestId('a')).toBeVisible();
});
`;
  const newSource = `
test('x', async ({ page }) => {
  await expect(page.getByTestId('a')).toBeVisible().catch(() => {});
});
`;
  const findings = diff(oldSource, newSource);
  assert.ok(findings.some((f) => f.type === 'assertion_swallowed'));
});
