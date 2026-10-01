import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildEntriesForSpec } from './recordBaseline';
import type { TestManagementClient, TmsCaseDetail, TmsRunRecord } from '../testmgmt/types';

let tmpDir: string;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'record-baseline-test-'));
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function fakeTms(caseDetail: Partial<TmsCaseDetail> = {}): TestManagementClient {
  const detail: TmsCaseDetail = {
    id: '1',
    title: 'A case',
    description: 'desc',
    preconditions: null,
    steps: [],
    ...caseDetail,
  };
  return {
    getCase: async () => detail,
    createCase: async () => {
      throw new Error('not used in these tests');
    },
    bulkCreateCases: async () => {
      throw new Error('not used in these tests');
    },
    createRun: async () => {
      throw new Error('not used in these tests');
    },
    setActiveRun: () => {},
    submitResult: async () => {},
  };
}

function writeSpec(jiraKey: string, scenarios: { id: string; testFile: string }[]): string {
  const specPath = path.join(tmpDir, `${jiraKey}-${Math.random().toString(36).slice(2)}.plan.md`);
  const lines = [`<!-- Jira: ${jiraKey} -->`, '', '## Test Scenarios', '', '### 1. A Group', '', '**Seed:** `tests/seed.spec.ts`', ''];
  scenarios.forEach((s, i) => {
    lines.push(
      `#### 1.${i + 1}. ${s.id}`,
      '',
      `**File:** \`${s.testFile}\``,
      '',
      '**Steps:**',
      '  1. Do a thing',
      '    - expect: something happens',
      '',
    );
  });
  fs.writeFileSync(specPath, lines.join('\n'), 'utf-8');
  return specPath;
}

function runRecord(cases: { id: string; externalCaseId: string }[]): TmsRunRecord {
  return {
    provider: 'qase',
    jiraKey: 'KAN-9',
    runId: 'r1',
    cases: cases.map((c) => ({ id: c.id, title: c.id, externalCaseId: c.externalCaseId })),
  };
}

test('buildEntriesForSpec resolves testTitle and hashes only its own block for a single-test file', async () => {
  const testFile = path.join(tmpDir, 'single.spec.ts');
  fs.writeFileSync(
    testFile,
    `import { test } from '@playwright/test';\ntest.describe('Group', () => {\n  test('does a thing', async () => {\n    // step\n  });\n});\n`,
    'utf-8',
  );
  const specPath = writeSpec('KAN-9', [{ id: 'does-a-thing', testFile }]);

  const { entries, skipped } = await buildEntriesForSpec(specPath, runRecord([{ id: 'does-a-thing', externalCaseId: '100' }]), fakeTms());

  assert.equal(skipped.length, 0);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].testTitle, 'does a thing');
  assert.equal(entries[0].testFilePath, testFile);
  assert.equal(entries[0].externalCaseId, '100');
});

test('buildEntriesForSpec resolves each scenario in a shared multi-test file by its scenario-id marker', async () => {
  const testFile = path.join(tmpDir, 'shared.spec.ts');
  fs.writeFileSync(
    testFile,
    [
      "import { test } from '@playwright/test';",
      "test.describe('Group', () => {",
      '  // scenario-id: scenario-a',
      "  test('scenario a title', async () => {});",
      '',
      '  // scenario-id: scenario-b',
      "  test('scenario b title', async () => {});",
      '});',
      '',
    ].join('\n'),
    'utf-8',
  );
  const specPath = writeSpec('KAN-9', [
    { id: 'scenario-a', testFile },
    { id: 'scenario-b', testFile },
  ]);

  const { entries, skipped } = await buildEntriesForSpec(
    specPath,
    runRecord([
      { id: 'scenario-a', externalCaseId: '200' },
      { id: 'scenario-b', externalCaseId: '201' },
    ]),
    fakeTms(),
  );

  assert.equal(skipped.length, 0);
  assert.equal(entries.length, 2);
  assert.equal(entries.find((e) => e.externalCaseId === '200')?.testTitle, 'scenario a title');
  assert.equal(entries.find((e) => e.externalCaseId === '201')?.testTitle, 'scenario b title');
});

test('buildEntriesForSpec: editing one scenario in a shared file does not change a sibling entry\'s hash', async () => {
  const testFile = path.join(tmpDir, 'shared2.spec.ts');
  const source = (bText: string) =>
    [
      "import { test } from '@playwright/test';",
      "test.describe('Group', () => {",
      '  // scenario-id: scenario-a',
      "  test('scenario a title', async () => {});",
      '',
      '  // scenario-id: scenario-b',
      `  test('scenario b title', async () => { ${bText} });`,
      '});',
      '',
    ].join('\n');

  fs.writeFileSync(testFile, source(''), 'utf-8');
  const specPath = writeSpec('KAN-9', [
    { id: 'scenario-a', testFile },
    { id: 'scenario-b', testFile },
  ]);
  const record = runRecord([
    { id: 'scenario-a', externalCaseId: '300' },
    { id: 'scenario-b', externalCaseId: '301' },
  ]);

  const before = await buildEntriesForSpec(specPath, record, fakeTms());
  const aHashBefore = before.entries.find((e) => e.externalCaseId === '300')!.testContentHash;

  fs.writeFileSync(testFile, source('await Promise.resolve();'), 'utf-8');
  const after = await buildEntriesForSpec(specPath, record, fakeTms());
  const aHashAfter = after.entries.find((e) => e.externalCaseId === '300')!.testContentHash;

  assert.equal(aHashBefore, aHashAfter);
});

test('buildEntriesForSpec skips (does not guess) a scenario whose marker is missing from a multi-test file', async () => {
  const testFile = path.join(tmpDir, 'unmarked.spec.ts');
  fs.writeFileSync(
    testFile,
    [
      "import { test } from '@playwright/test';",
      "test.describe('Group', () => {",
      "  test('scenario a title', async () => {});",
      "  test('scenario b title', async () => {});",
      '});',
      '',
    ].join('\n'),
    'utf-8',
  );
  const specPath = writeSpec('KAN-9', [{ id: 'scenario-a', testFile }]);

  const { entries, skipped } = await buildEntriesForSpec(
    specPath,
    runRecord([{ id: 'scenario-a', externalCaseId: '400' }]),
    fakeTms(),
  );

  assert.equal(entries.length, 0);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0], /2 test\(\.\.\.\) blocks/);
});
