import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectLocatorViolations } from './detectLocatorViolations';

test('detectLocatorViolations flags .locator(...) unconditionally, even on a non-CSS-looking string', () => {
  const source = `const x = page.locator('some-weird-but-not-css-looking-thing');`;
  const violations = detectLocatorViolations(source);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].method, 'locator');
  assert.equal(violations[0].line, 1);
});

test('detectLocatorViolations flags page.$, page.$$, page.$eval, page.$$eval', () => {
  const source = `
const a = await page.$('.foo');
const b = await page.$$('.bar');
const c = await page.$eval('.baz', (el) => el.textContent);
const d = await page.$$eval('.qux', (els) => els.length);
`;
  const violations = detectLocatorViolations(source);
  const methods = violations.map((v) => v.method).sort();
  assert.deepEqual(methods, ['$', '$$', '$$eval', '$eval']);
});

test('detectLocatorViolations does not flag the allowed locator methods', () => {
  const source = `
const a = page.getByRole('button', { name: 'Submit' });
const b = page.getByLabel('Email');
const c = page.getByTestId('refund-status');
const d = page.getByText('Welcome');
`;
  assert.deepEqual(detectLocatorViolations(source), []);
});

test('detectLocatorViolations flags .locator() regardless of receiver name (chained off a page object)', () => {
  const source = `this.rows = page.getByRole('row').filter({ has: page.locator('td') });`;
  const violations = detectLocatorViolations(source);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].method, 'locator');
});
