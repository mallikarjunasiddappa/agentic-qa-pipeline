import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, runForbiddenPatternsCheck } from './checkForbiddenPlaywrightPatterns';

const PATTERNS = ['page.pause()', 'page.waitForTimeout(', 'waitForSelector('];

test('runForbiddenPatternsCheck: passes when no added line matches a forbidden pattern', () => {
  const result = runForbiddenPatternsCheck(
    [{ path: 'tests/ui/a.spec.ts', lines: ["await expect(page.getByRole('button')).toBeVisible();"] }],
    PATTERNS,
  );
  assert.equal(result.ok, true);
});

test('runForbiddenPatternsCheck: flags an added page.waitForTimeout call', () => {
  const result = runForbiddenPatternsCheck(
    [{ path: 'tests/ui/a.spec.ts', lines: ['await page.waitForTimeout(2000);'] }],
    PATTERNS,
  );
  assert.equal(result.ok, false);
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].pattern, 'page.waitForTimeout(');
});

test('runForbiddenPatternsCheck: flags page.pause() and waitForSelector independently in the same PR', () => {
  const result = runForbiddenPatternsCheck(
    [
      { path: 'tests/ui/a.spec.ts', lines: ['await page.pause();'] },
      { path: 'tests/ui/b.spec.ts', lines: ["await page.waitForSelector('.loaded');"] },
    ],
    PATTERNS,
  );
  assert.equal(result.ok, false);
  assert.equal(result.matches.length, 2);
});

test('runForbiddenPatternsCheck: only checks the lines given - a pre-existing (not newly-added) violation elsewhere is invisible to it', () => {
  // The CLI layer is responsible for only ever passing *added* lines in here - this test documents
  // that the pure core trusts its input rather than re-deriving "added" itself.
  const result = runForbiddenPatternsCheck(
    [{ path: 'tests/ui/a.spec.ts', lines: ["await expect(page.getByRole('button')).toBeVisible();"] }],
    PATTERNS,
  );
  assert.equal(result.ok, true);
});

test('buildReport: passing case', () => {
  const report = buildReport({ matches: [], ok: true });
  assert.match(report, /No newly-added lines/);
});

test('buildReport: failing case lists the file, pattern, and offending line, with no suppression mention', () => {
  const report = buildReport({
    matches: [{ path: 'tests/ui/a.spec.ts', line: 'await page.pause();', pattern: 'page.pause()' }],
  ok: false,
  });
  assert.match(report, /tests\/ui\/a\.spec\.ts/);
  assert.match(report, /page\.pause\(\)/);
  assert.match(report, /No suppression comment applies/);
});
