import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashCase, hashTestFile, hashScenarioTestBlock } from './hashing';
import { findTestBlocks, resolveTestBlock } from '../shared/testBlocks';
import type { TmsCaseDetail } from '../testmgmt/types';

function baseCase(overrides: Partial<TmsCaseDetail> = {}): TmsCaseDetail {
  return {
    id: '1',
    title: 'Should log in successfully',
    description: 'Verifies a student can log in with valid credentials.',
    preconditions: 'A registered student account exists.',
    steps: [
      { action: 'Enter valid email and password', expectedResult: 'Fields accept the input' },
      { action: 'Submit the login form', expectedResult: 'Redirected to the dashboard' },
    ],
    ...overrides,
  };
}

test('hashCase: identical content produces the same hash', () => {
  const a = hashCase(baseCase());
  const b = hashCase(baseCase());
  assert.equal(a, b);
});

test('hashCase: whitespace-only edits do not change the hash', () => {
  const a = hashCase(baseCase());
  const b = hashCase(
    baseCase({
      title: '  Should log in successfully  ',
      description: '\nVerifies a student can log in with valid credentials.\n',
      preconditions: 'A REGISTERED student account exists.',
      steps: [
        { action: '  Enter valid email and password', expectedResult: 'Fields accept the input  ' },
        { action: 'Submit the login form', expectedResult: '  Redirected to the dashboard' },
      ],
    }),
  );
  assert.equal(a, b);
});

test('hashCase: a real content change produces a different hash', () => {
  const a = hashCase(baseCase());
  const b = hashCase(baseCase({ title: 'Should log in with an expired password' }));
  assert.notEqual(a, b);
});

test('hashCase: a real step change produces a different hash', () => {
  const a = hashCase(baseCase());
  const b = hashCase(
    baseCase({
      steps: [
        { action: 'Enter valid email and password', expectedResult: 'Fields accept the input' },
        { action: 'Submit the login form', expectedResult: 'An error message is shown' },
      ],
    }),
  );
  assert.notEqual(a, b);
});

const SAMPLE_TS_SOURCE = `import { test, expect } from '../../src/fixtures/base';

test.describe('Student Login', () => {
  test('should log in successfully', async ({ page }) => {
    await page.goto('/login');
    await expect(page).toHaveURL(/dashboard/);
  });
});
`;

test('hashTestFile: identical content produces the same hash', async () => {
  const a = await hashTestFile(SAMPLE_TS_SOURCE, 'sample.spec.ts');
  const b = await hashTestFile(SAMPLE_TS_SOURCE, 'sample.spec.ts');
  assert.equal(a, b);
});

test('hashTestFile: formatting-only edits do not change the hash', async () => {
  const reformatted = `import   {test,expect} from '../../src/fixtures/base'

test.describe("Student Login", () => {
    test("should log in successfully", async ({page}) => {
        await page.goto("/login")
        await expect(page).toHaveURL(/dashboard/)
    })
})
`;
  const a = await hashTestFile(SAMPLE_TS_SOURCE, 'sample.spec.ts');
  const b = await hashTestFile(reformatted, 'sample.spec.ts');
  assert.equal(a, b);
});

test('hashTestFile: a real content change produces a different hash', async () => {
  const changed = SAMPLE_TS_SOURCE.replace('/dashboard/', '/login/');
  const a = await hashTestFile(SAMPLE_TS_SOURCE, 'sample.spec.ts');
  const b = await hashTestFile(changed, 'sample.spec.ts');
  assert.notEqual(a, b);
});

const MULTI_TEST_SOURCE = `import { test, expect } from '../../fixtures/profile';

test.describe('Student Profile', () => {
  // scenario-id: a
  test('scenario a', async ({ page }) => {
    await page.getByRole('link', { name: 'Profile' }).click();
  });

  // scenario-id: b
  test('scenario b', async ({ page }) => {
    await page.goto('/dashboard');
  });
});
`;

test('hashScenarioTestBlock: editing one scenario does not change a sibling scenario\'s hash', async () => {
  const before = findTestBlocks(MULTI_TEST_SOURCE);
  const bHashBefore = await hashScenarioTestBlock(resolveTestBlock(before, 'b')!.source);

  const editedA = MULTI_TEST_SOURCE.replace(
    "await page.getByRole('link', { name: 'Profile' }).click();",
    "await page.getByRole('link', { name: 'My Profile' }).click();",
  );
  const after = findTestBlocks(editedA);
  const bHashAfter = await hashScenarioTestBlock(resolveTestBlock(after, 'b')!.source);

  assert.equal(bHashBefore, bHashAfter);
});

test('hashScenarioTestBlock: formatting-only edits to a scenario do not change its own hash', async () => {
  const before = findTestBlocks(MULTI_TEST_SOURCE);
  const aHashBefore = await hashScenarioTestBlock(resolveTestBlock(before, 'a')!.source);

  const reformatted = MULTI_TEST_SOURCE.replace(
    "test('scenario a', async ({ page }) => {",
    "test(  'scenario a'   , async ({ page }) => {",
  );
  const after = findTestBlocks(reformatted);
  const aHashAfter = await hashScenarioTestBlock(resolveTestBlock(after, 'a')!.source);

  assert.equal(aHashBefore, aHashAfter);
});

test('hashScenarioTestBlock: a real change to a scenario changes its own hash', async () => {
  const before = findTestBlocks(MULTI_TEST_SOURCE);
  const aHashBefore = await hashScenarioTestBlock(resolveTestBlock(before, 'a')!.source);

  const editedA = MULTI_TEST_SOURCE.replace(
    "await page.getByRole('link', { name: 'Profile' }).click();",
    "await page.getByRole('link', { name: 'My Profile' }).click();",
  );
  const after = findTestBlocks(editedA);
  const aHashAfter = await hashScenarioTestBlock(resolveTestBlock(after, 'a')!.source);

  assert.notEqual(aHashBefore, aHashAfter);
});
