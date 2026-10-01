import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildReport, runLocatorPriorityCheck, LOCATOR_SCAN_ROOTS } from './checkLocatorPriority';

test('runLocatorPriorityCheck: an unsuppressed .locator() call counts as unreviewed', () => {
  const content = `const x = page.locator('.foo');`;
  const result = runLocatorPriorityCheck([{ path: 'src/pages/X.ts', content }]);
  assert.equal(result.unsuppressedCount, 1);
  assert.equal(result.files[0].violations[0].suppressed, false);
});

test('runLocatorPriorityCheck: a suppression comment immediately above clears the violation', () => {
  const content = [
    '// locator-priority: approved — legacy widget has no accessible role yet, tracked in JIRA-42',
    `const x = page.locator('.foo');`,
  ].join('\n');
  const result = runLocatorPriorityCheck([{ path: 'src/pages/X.ts', content }]);
  assert.equal(result.unsuppressedCount, 0);
  assert.equal(result.files[0].violations[0].suppressed, true);
  assert.match(
    result.files[0].violations[0].suppressionReason ?? '',
    /legacy widget has no accessible role yet/,
  );
});

test('runLocatorPriorityCheck: a suppression comment two lines above does not clear it', () => {
  const content = [
    '// locator-priority: approved — reason',
    '',
    `const x = page.locator('.foo');`,
  ].join('\n');
  const result = runLocatorPriorityCheck([{ path: 'src/pages/X.ts', content }]);
  assert.equal(result.unsuppressedCount, 1);
});

test('runLocatorPriorityCheck: an assertion-integrity suppression comment does not clear a locator violation (different tag)', () => {
  const content = [
    '// assertion-integrity: approved — wrong tag for this rule',
    `const x = page.locator('.foo');`,
  ].join('\n');
  const result = runLocatorPriorityCheck([{ path: 'src/pages/X.ts', content }]);
  assert.equal(result.unsuppressedCount, 1);
});

test('runLocatorPriorityCheck: a bare tag with no reason does not suppress', () => {
  const content = ['// locator-priority: approved —', `const x = page.locator('.foo');`].join('\n');
  const result = runLocatorPriorityCheck([{ path: 'src/pages/X.ts', content }]);
  assert.equal(result.unsuppressedCount, 1);
});

test('buildReport: clean-bill message when there are no violations', () => {
  const result = runLocatorPriorityCheck([]);
  assert.match(buildReport(result), /No CSS\/XPath-style locator calls found/);
});

test('the real repo has zero locator-priority violations today', () => {
  const files: { path: string; content: string }[] = [];

  // Reuses the source module's own LOCATOR_SCAN_ROOTS rather than a second hardcoded list, so this
  // test can't silently drift out of sync with what checkLocatorPriority() actually scans.
  function collect(dir: string, suffix: string) {
    if (!fs.existsSync(dir)) return;
    for (const rel of fs.readdirSync(dir, { recursive: true }) as string[]) {
      const full = path.join(dir, rel);
      if (rel.endsWith(suffix) && fs.statSync(full).isFile()) {
        files.push({ path: full, content: fs.readFileSync(full, 'utf-8') });
      }
    }
  }
  for (const { dir, suffix } of LOCATOR_SCAN_ROOTS) collect(dir, suffix);

  assert.ok(files.length > 0, 'expected to find real page objects and spec files to scan');
  const result = runLocatorPriorityCheck(files);
  assert.equal(
    result.unsuppressedCount,
    0,
    `expected zero real violations, found: ${JSON.stringify(result.files.filter((f) => f.violations.length > 0))}`,
  );
});
