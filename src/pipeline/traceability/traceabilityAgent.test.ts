import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkDrift, CaseReader } from './traceabilityAgent';
import { hashCase, hashTestFile, hashScenarioTestBlock } from './hashing';
import type { TmsCaseDetail } from '../testmgmt/types';
import type { TraceabilityEntry } from '../types/schemas';

let tmpDir: string;

const OLD_CASE: TmsCaseDetail = {
  id: '1',
  title: 'Old title',
  description: 'Old description',
  preconditions: '',
  steps: [{ action: 'Do the thing', expectedResult: 'It works' }],
};
const NEW_CASE: TmsCaseDetail = { ...OLD_CASE, title: 'New title' };

const OLD_SOURCE = "test('a', () => { expect(1).toBe(1); });\n";
const NEW_SOURCE = "test('a', () => { expect(2).toBe(2); });\n";

function notFoundError(): Error {
  return Object.assign(new Error('Not Found'), { isAxiosError: true, response: { status: 404 } });
}

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traceability-test-'));
  fs.writeFileSync(path.join(tmpDir, 'in-sync.spec.ts'), OLD_SOURCE);
  fs.writeFileSync(path.join(tmpDir, 'test-drifted.spec.ts'), NEW_SOURCE);
  fs.writeFileSync(path.join(tmpDir, 'case-drifted.spec.ts'), OLD_SOURCE);
  fs.writeFileSync(path.join(tmpDir, 'both-drifted.spec.ts'), NEW_SOURCE);
  fs.writeFileSync(path.join(tmpDir, 'orphaned-case.spec.ts'), OLD_SOURCE);
  // orphaned-test.spec.ts deliberately not created.
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('checkDrift classifies all six sync states correctly', async () => {
  const oldCaseHash = hashCase(OLD_CASE);
  const oldTestHash = await hashTestFile(OLD_SOURCE, 'x.spec.ts');

  const manifest: TraceabilityEntry[] = [
    entry('KAN-1', '1', path.join(tmpDir, 'in-sync.spec.ts'), oldCaseHash, oldTestHash),
    entry('KAN-1', '2', path.join(tmpDir, 'test-drifted.spec.ts'), oldCaseHash, oldTestHash),
    entry('KAN-1', '3', path.join(tmpDir, 'case-drifted.spec.ts'), oldCaseHash, oldTestHash),
    entry('KAN-1', '4', path.join(tmpDir, 'both-drifted.spec.ts'), oldCaseHash, oldTestHash),
    entry('KAN-1', '5', path.join(tmpDir, 'orphaned-case.spec.ts'), oldCaseHash, oldTestHash),
    entry('KAN-1', '6', path.join(tmpDir, 'orphaned-test.spec.ts'), oldCaseHash, oldTestHash),
  ];

  const tms: CaseReader = {
    async getCase(caseId: string): Promise<TmsCaseDetail> {
      if (caseId === '5') throw notFoundError();
      if (caseId === '3' || caseId === '4') return { ...NEW_CASE, id: caseId };
      return { ...OLD_CASE, id: caseId };
    },
  };

  const result = await checkDrift(manifest, tms);
  const stateOf = (externalCaseId: string) =>
    result.entries.find((e) => e.externalCaseId === externalCaseId)?.syncState;

  assert.equal(stateOf('1'), 'IN_SYNC');
  assert.equal(stateOf('2'), 'TEST_DRIFTED');
  assert.equal(stateOf('3'), 'CASE_DRIFTED');
  assert.equal(stateOf('4'), 'BOTH_DRIFTED');
  assert.equal(stateOf('5'), 'ORPHANED_CASE');
  assert.equal(stateOf('6'), 'ORPHANED_TEST');

  assert.deepEqual(result.counts, {
    IN_SYNC: 1,
    CASE_DRIFTED: 1,
    TEST_DRIFTED: 1,
    BOTH_DRIFTED: 1,
    ORPHANED_CASE: 1,
    ORPHANED_TEST: 1,
  });
});

test('checkDrift never rewrites baseline hashes even when drifted', async () => {
  const oldCaseHash = hashCase(OLD_CASE);
  const oldTestHash = await hashTestFile(OLD_SOURCE, 'x.spec.ts');
  const manifest: TraceabilityEntry[] = [
    entry('KAN-1', '4', path.join(tmpDir, 'both-drifted.spec.ts'), oldCaseHash, oldTestHash),
  ];
  const tms: CaseReader = { async getCase(id) { return { ...NEW_CASE, id }; } };

  const result = await checkDrift(manifest, tms);
  const [updated] = result.entries;

  assert.equal(updated.syncState, 'BOTH_DRIFTED');
  assert.equal(updated.externalCaseHash, oldCaseHash, 'baseline case hash must stay the recorded one');
  assert.equal(updated.testContentHash, oldTestHash, 'baseline test hash must stay the recorded one');
  assert.notEqual(updated.currentExternalCaseHash, oldCaseHash, 'current hash should reflect live content');
});

test('checkDrift: a shared multi-test file - each entry is hashed by its own scenario block, not the whole file', async () => {
  // Regression test for the real bug found via a live drift-check run: checkDrift used to hash
  // the *whole file* for every entry regardless of testTitle, while stageTraceabilityLink records
  // the baseline from just one scenario's block - so every entry in any shared file showed
  // TEST_DRIFTED forever, even ones nobody had touched, because two different things were being
  // compared as if they were the same.
  const sharedPath = path.join(tmpDir, 'shared.spec.ts');
  const sourceV1 = [
    "test('scenario a', () => { expect(1).toBe(1); });",
    "test('scenario b', () => { expect(2).toBe(2); });",
  ].join('\n');
  fs.writeFileSync(sharedPath, sourceV1);

  const blockA = "test('scenario a', () => { expect(1).toBe(1); })";
  const blockB = "test('scenario b', () => { expect(2).toBe(2); })";
  const caseHash = hashCase(OLD_CASE);

  const manifest: TraceabilityEntry[] = [
    { ...entry('KAN-9', '101', sharedPath, caseHash, await hashScenarioTestBlock(blockA)), testTitle: 'scenario a' },
    { ...entry('KAN-9', '102', sharedPath, caseHash, await hashScenarioTestBlock(blockB)), testTitle: 'scenario b' },
  ];
  const tms: CaseReader = { async getCase(id) { return { ...OLD_CASE, id }; } };

  // Neither scenario has changed yet - both should be IN_SYNC, not TEST_DRIFTED just because they
  // share a file.
  const before = await checkDrift(manifest, tms);
  assert.equal(before.entries.find((e) => e.externalCaseId === '101')?.syncState, 'IN_SYNC');
  assert.equal(before.entries.find((e) => e.externalCaseId === '102')?.syncState, 'IN_SYNC');

  // Now edit only scenario b's body in the shared file.
  const sourceV2 = [
    "test('scenario a', () => { expect(1).toBe(1); });",
    "test('scenario b', () => { expect(999).toBe(999); });",
  ].join('\n');
  fs.writeFileSync(sharedPath, sourceV2);

  const after = await checkDrift(manifest, tms);
  assert.equal(
    after.entries.find((e) => e.externalCaseId === '101')?.syncState,
    'IN_SYNC',
    "scenario a's own entry must stay IN_SYNC - its sibling changing in the same file is not its drift",
  );
  assert.equal(
    after.entries.find((e) => e.externalCaseId === '102')?.syncState,
    'TEST_DRIFTED',
    "scenario b's entry must reflect its own real change",
  );
});

test('checkDrift: an entry with no testTitle still uses the whole-file hash (legacy/single-test path unchanged)', async () => {
  const oldCaseHash = hashCase(OLD_CASE);
  const oldTestHash = await hashTestFile(OLD_SOURCE, 'x.spec.ts');
  const manifest: TraceabilityEntry[] = [
    entry('KAN-1', '1', path.join(tmpDir, 'in-sync.spec.ts'), oldCaseHash, oldTestHash),
  ];
  const tms: CaseReader = { async getCase(id) { return { ...OLD_CASE, id }; } };

  const result = await checkDrift(manifest, tms);
  assert.equal(result.entries[0].syncState, 'IN_SYNC');
});

test('checkDrift: testTitle set but no matching block in the current file - ORPHANED_TEST, not a hash mismatch', async () => {
  const sharedPath = path.join(tmpDir, 'renamed.spec.ts');
  fs.writeFileSync(sharedPath, "test('a totally different scenario', () => { expect(1).toBe(1); });\n");

  const caseHash = hashCase(OLD_CASE);
  const manifest: TraceabilityEntry[] = [
    {
      ...entry('KAN-9', '201', sharedPath, caseHash, await hashScenarioTestBlock("test('scenario that got renamed', () => {})")),
      testTitle: 'scenario that got renamed',
    },
  ];
  const tms: CaseReader = { async getCase(id) { return { ...OLD_CASE, id }; } };

  const result = await checkDrift(manifest, tms);
  assert.equal(result.entries[0].syncState, 'ORPHANED_TEST');
  assert.equal(result.entries[0].currentTestContentHash, null);
});

function entry(
  jiraKey: string,
  externalCaseId: string,
  testFilePath: string,
  externalCaseHash: string,
  testContentHash: string,
): TraceabilityEntry {
  return {
    jiraKey,
    externalCaseId,
    externalCaseHash,
    externalCaseUpdatedAt: '2026-01-01T00:00:00Z',
    tmsProvider: 'qase',
    testFilePath,
    testContentHash,
    testLastModified: '2026-01-01T00:00:00Z',
    syncState: 'IN_SYNC',
    lastCheckedAt: '2026-01-01T00:00:00Z',
  };
}
