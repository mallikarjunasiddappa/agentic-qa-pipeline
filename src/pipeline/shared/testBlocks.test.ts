import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findTestBlocks, resolveTestBlock, buildScenarioIdComment } from './testBlocks';

const MULTI_TEST_SOURCE = `import { test, expect } from '../../fixtures/profile';

test.describe('Student Profile', () => {
  // scenario-id: should-open-my-profile-from-account-menu
  test('should open my profile from account menu', async ({ page }) => {
    await page.getByRole('link', { name: 'Profile' }).click();
    await expect(page).toHaveURL(/profile/);
  });

  // scenario-id: should-reopen-profile-after-navigating-away
  test('should reopen profile after navigating away', async ({ page }) => {
    await page.goto('/dashboard');
    await page.getByRole('link', { name: 'Profile' }).click();
    await expect(page).toHaveURL(/profile/);
  });
});
`;

const SINGLE_TEST_SOURCE = `import { test, expect } from '../../fixtures/profile';

test.describe('Student Profile', () => {
  test('should list all profile sections', async ({ page }) => {
    await expect(page.getByRole('heading')).toBeVisible();
  });
});
`;

test('findTestBlocks finds every test(...) in a multi-test file, not test.describe itself', () => {
  const blocks = findTestBlocks(MULTI_TEST_SOURCE);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].testTitle, 'should open my profile from account menu');
  assert.equal(blocks[1].testTitle, 'should reopen profile after navigating away');
});

test('findTestBlocks reads the // scenario-id: marker directly above each test', () => {
  const blocks = findTestBlocks(MULTI_TEST_SOURCE);
  assert.equal(blocks[0].scenarioId, 'should-open-my-profile-from-account-menu');
  assert.equal(blocks[1].scenarioId, 'should-reopen-profile-after-navigating-away');
});

test('findTestBlocks leaves scenarioId undefined when there is no marker', () => {
  const blocks = findTestBlocks(SINGLE_TEST_SOURCE);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].scenarioId, undefined);
});

test('findTestBlocks does not match test.only/test.skip as describe, but does match them as tests', () => {
  const src = `import { test } from '@playwright/test';
test.describe('Group', () => {
  test.only('a focused test', async () => {});
  test.skip('a skipped test', async () => {});
});
`;
  const blocks = findTestBlocks(src);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].testTitle, 'a focused test');
  assert.equal(blocks[1].testTitle, 'a skipped test');
});

test('resolveTestBlock returns the only block unconditionally when the file has exactly one test', () => {
  const blocks = findTestBlocks(SINGLE_TEST_SOURCE);
  const resolved = resolveTestBlock(blocks, 'anything-not-matching-anything');
  assert.equal(resolved?.testTitle, 'should list all profile sections');
});

test('resolveTestBlock matches by scenario-id marker when the file has multiple tests', () => {
  const blocks = findTestBlocks(MULTI_TEST_SOURCE);
  const resolved = resolveTestBlock(blocks, 'should-reopen-profile-after-navigating-away');
  assert.equal(resolved?.testTitle, 'should reopen profile after navigating away');
});

test('resolveTestBlock returns undefined (never a guess) when no marker matches in a multi-test file', () => {
  const blocks = findTestBlocks(MULTI_TEST_SOURCE);
  assert.equal(resolveTestBlock(blocks, 'no-such-scenario'), undefined);
});

test('resolveTestBlock returns undefined on a marker collision rather than picking the first match', () => {
  const src = `import { test } from '@playwright/test';
test.describe('Group', () => {
  // scenario-id: dup
  test('first', async () => {});
  // scenario-id: dup
  test('second', async () => {});
});
`;
  const blocks = findTestBlocks(src);
  assert.equal(resolveTestBlock(blocks, 'dup'), undefined);
});

test('findTestBlocks captures each test block source scoped to just that test', () => {
  const blocks = findTestBlocks(MULTI_TEST_SOURCE);
  assert.match(blocks[0].source, /should open my profile from account menu/);
  assert.doesNotMatch(blocks[0].source, /should reopen profile/);
});

test('buildScenarioIdComment produces the exact marker findTestBlocks looks for', () => {
  const comment = buildScenarioIdComment('should-do-a-thing');
  const src = `import { test } from '@playwright/test';
test.describe('Group', () => {
  ${comment}
  test('a', async () => {});
  test('b', async () => {});
});
`;
  const blocks = findTestBlocks(src);
  assert.equal(resolveTestBlock(blocks, 'should-do-a-thing')?.testTitle, 'a');
});
