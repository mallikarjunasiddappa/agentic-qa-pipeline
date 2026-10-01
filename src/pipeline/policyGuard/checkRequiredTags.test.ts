import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, findNewTestBlocks, runRequiredTagsCheck, FileWithNewBlocks } from './checkRequiredTags';

const SEED = `import { test } from '@playwright/test';
test('seed', async ({ page }) => {});
`;

const ONE_TAGGED_TEST = `import { test, expect } from '../../../src/ui/fixtures/profile';
test.describe('Group', () => {
  // scenario-id: should-do-a-thing
  test('should do a thing', { tag: ['@regression'] }, async ({ page }) => {
    await expect(page).toHaveURL(/\\/x/);
  });
});
`;

const ONE_UNTAGGED_TEST = `import { test, expect } from '../../../src/ui/fixtures/profile';
test.describe('Group', () => {
  // scenario-id: should-do-a-thing
  test('should do a thing', async ({ page }) => {
    await expect(page).toHaveURL(/\\/x/);
  });
});
`;

const TWO_TESTS_ONE_NEW = `import { test, expect } from '../../../src/ui/fixtures/profile';
test.describe('Group A', () => {
  // scenario-id: should-do-a-thing
  test('should do a thing', { tag: ['@regression'] }, async ({ page }) => {
    await expect(page).toHaveURL(/\\/x/);
  });
});
test.describe('Group B', () => {
  // scenario-id: should-do-another-thing
  test('should do another thing', async ({ page }) => {
    await expect(page).toHaveURL(/\\/y/);
  });
});
`;

test('findNewTestBlocks: a brand-new file (empty before) - every block is new', () => {
  const blocks = findNewTestBlocks('', ONE_TAGGED_TEST, 'a.spec.ts');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].scenarioId, 'should-do-a-thing');
});

test('findNewTestBlocks: identical before/after - nothing is new', () => {
  const blocks = findNewTestBlocks(ONE_TAGGED_TEST, ONE_TAGGED_TEST, 'a.spec.ts');
  assert.equal(blocks.length, 0);
});

test('findNewTestBlocks: an existing shared file gaining one more test - only the new one is flagged', () => {
  const blocks = findNewTestBlocks(ONE_TAGGED_TEST, TWO_TESTS_ONE_NEW, 'a.spec.ts');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].scenarioId, 'should-do-another-thing');
});

test('runRequiredTagsCheck: does nothing when policy.json has no requiredTestTags', () => {
  const files: FileWithNewBlocks[] = [
    { path: 'a.spec.ts', content: ONE_UNTAGGED_TEST, newBlocks: findNewTestBlocks('', ONE_UNTAGGED_TEST, 'a.spec.ts') },
  ];
  const result = runRequiredTagsCheck(files, []);
  assert.equal(result.items.length, 0);
});

test('runRequiredTagsCheck: flags a new test with no required tag', () => {
  const files: FileWithNewBlocks[] = [
    { path: 'a.spec.ts', content: ONE_UNTAGGED_TEST, newBlocks: findNewTestBlocks('', ONE_UNTAGGED_TEST, 'a.spec.ts') },
  ];
  const result = runRequiredTagsCheck(files, ['smoke', 'regression', 'critical']);
  assert.equal(result.unsuppressedCount, 1);
  assert.equal(result.items[0].testTitle, 'should do a thing');
});

test('runRequiredTagsCheck: passes a new test carrying one of the required tags', () => {
  const files: FileWithNewBlocks[] = [
    { path: 'a.spec.ts', content: ONE_TAGGED_TEST, newBlocks: findNewTestBlocks('', ONE_TAGGED_TEST, 'a.spec.ts') },
  ];
  const result = runRequiredTagsCheck(files, ['smoke', 'regression', 'critical']);
  assert.equal(result.unsuppressedCount, 0);
});

test('runRequiredTagsCheck: an already-existing untagged test is not re-flagged when a sibling new test is added', () => {
  const files: FileWithNewBlocks[] = [
    { path: 'a.spec.ts', content: TWO_TESTS_ONE_NEW, newBlocks: findNewTestBlocks(ONE_TAGGED_TEST, TWO_TESTS_ONE_NEW, 'a.spec.ts') },
  ];
  const result = runRequiredTagsCheck(files, ['smoke', 'regression', 'critical']);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].testTitle, 'should do another thing');
});

test('runRequiredTagsCheck: a suppression comment exempts a seed test', () => {
  const suppressedSeed = `// required-tags: approved — seed test, not a scenario\n${SEED}`;
  const files: FileWithNewBlocks[] = [
    { path: 'seed.spec.ts', content: suppressedSeed, newBlocks: findNewTestBlocks('', suppressedSeed, 'seed.spec.ts') },
  ];
  const result = runRequiredTagsCheck(files, ['smoke', 'regression', 'critical']);
  assert.equal(result.unsuppressedCount, 0);
  assert.equal(result.items[0].suppressed, true);
});

test('buildReport: passing case', () => {
  const report = buildReport({ items: [], unsuppressedCount: 0 });
  assert.match(report, /Every newly added test already carries a required tag/);
});

test('buildReport: failing case names the file/test and gives both remediation options', () => {
  const report = buildReport({
    items: [{ path: 'a.spec.ts', testTitle: 'should do a thing', suppressed: false, suppressionReason: null }],
    unsuppressedCount: 1,
  });
  assert.match(report, /a\.spec\.ts/);
  assert.match(report, /should do a thing/);
  assert.match(report, /tag: \['@regression'\]/);
  assert.match(report, /required-tags: approved/);
});
