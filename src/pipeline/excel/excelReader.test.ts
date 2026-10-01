import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeScenarios, assignDisplayIds } from './excelWriter';
import { readScenarios, diffScenarios } from './excelReader';
import { Scenario } from '../types/schemas';

function scenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    id: 'should-do-a-thing',
    title: 'Widget: Should Do A Thing',
    suite: 'Widget',
    preconditions: 'Some concrete starting state',
    steps: ['Click the Save button', 'Confirm the dialog'],
    expectedResult: 'a confirmation toast appears',
    priority: 'medium',
    ...overrides,
  };
}

function tmpXlsxPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'excel-reader-test-'));
  return path.join(dir, 'scenarios.xlsx');
}

test('write then read round-trip: Case ID (displayId) survives, alongside every other field', async () => {
  const withDisplayIds = assignDisplayIds('KAN-3', [scenario()]);
  const filePath = tmpXlsxPath();
  await writeScenarios(withDisplayIds, filePath);

  const [readBack] = await readScenarios(filePath);
  assert.equal(readBack.displayId, 'KAN3-01');
  assert.equal(readBack.id, 'should-do-a-thing');
  assert.equal(readBack.suite, 'Widget');
  assert.deepEqual(readBack.steps, ['Click the Save button', 'Confirm the dialog']);
});

test('write then read round-trip: a sheet written without displayId reads back with it undefined (older-format compatibility)', async () => {
  const filePath = tmpXlsxPath();
  await writeScenarios([scenario()], filePath);

  const [readBack] = await readScenarios(filePath);
  assert.equal(readBack.displayId, undefined);
});

test('diffScenarios: matching by the kebab-case id is unaffected by displayId (same underlying identity)', () => {
  const before = assignDisplayIds('KAN-3', [scenario()]);
  const after = assignDisplayIds('KAN-3', [scenario({ title: 'Widget: Edited Title' })]);
  const diff = diffScenarios(before, after);
  assert.equal(diff.changed.length, 1);
  assert.equal(diff.changed[0].id, 'should-do-a-thing');
});
