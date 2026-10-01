import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, runAssertionIntegrityCheck } from './checkAssertionIntegrity';

test('runAssertionIntegrityCheck: clean file (no changes) has zero findings', () => {
  const source = `
test('x', async ({ page }) => {
  await expect(page.getByTestId('a')).toHaveText('foo');
});
`;
  const result = runAssertionIntegrityCheck([
    { path: 'tests/a.spec.ts', oldContent: source, newContent: source },
  ]);
  assert.equal(result.unsuppressedCount, 0);
  assert.equal(result.files[0].results.length, 0);
});

test('runAssertionIntegrityCheck: aggregates unsuppressed findings across multiple files', () => {
  const oldA = `test('x', async ({ page }) => { await expect(page.getByTestId('a')).toHaveText('foo'); });`;
  const newA = `test('x', async ({ page }) => { await expect(page.getByTestId('a')).toBeVisible(); });`;
  const oldB = `test('y', async ({ page }) => { await expect(page.getByTestId('b')).toHaveURL(/a/); });`;
  const newB = oldB; // unchanged

  const result = runAssertionIntegrityCheck([
    { path: 'tests/a.spec.ts', oldContent: oldA, newContent: newA },
    { path: 'tests/b.spec.ts', oldContent: oldB, newContent: newB },
  ]);

  assert.equal(result.unsuppressedCount, 1);
  assert.equal(result.files[0].results.length, 1);
  assert.equal(result.files[1].results.length, 0);
});

test('runAssertionIntegrityCheck: a suppressed finding does not count toward unsuppressedCount', () => {
  const oldSource = `test('x', async ({ page }) => { await expect(page.getByTestId('a')).toHaveText('foo'); });`;
  const newSource = `
test('x', async ({ page }) => {
  // assertion-integrity: approved — reason
  await expect(page.getByTestId('a')).toBeVisible();
});
`;
  const result = runAssertionIntegrityCheck([
    { path: 'tests/a.spec.ts', oldContent: oldSource, newContent: newSource },
  ]);
  assert.equal(result.unsuppressedCount, 0);
  assert.equal(result.files[0].results.length, 1);
  assert.equal(result.files[0].results[0].suppressed, true);
});

test('buildReport: renders a clean-bill message when there are no findings at all', () => {
  const result = runAssertionIntegrityCheck([]);
  const report = buildReport(result);
  assert.match(report, /No assertion-integrity findings/);
});

test('buildReport: labels unsuppressed findings UNREVIEWED and suppressed ones with their reason', () => {
  const oldSource = `test('x', async ({ page }) => { await expect(page.getByTestId('a')).toHaveText('foo'); });`;
  const newSource = `test('x', async ({ page }) => { await expect(page.getByTestId('a')).toBeVisible(); });`;
  const result = runAssertionIntegrityCheck([
    { path: 'tests/a.spec.ts', oldContent: oldSource, newContent: newSource },
  ]);
  const report = buildReport(result);

  assert.match(report, /tests\/a\.spec\.ts/);
  assert.match(report, /UNREVIEWED/);
  assert.match(report, /1 unreviewed finding/);
});
