import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadQuarantine,
  saveQuarantine,
  upsertQuarantineEntry,
  removeQuarantineEntry,
  updateQuarantine,
} from './quarantineStore';
import type { QuarantineEntry } from '../types/schemas';

let tmpDir: string;
let quarantinePath: string;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quarantine-store-test-'));
  quarantinePath = path.join(tmpDir, 'quarantine.json');
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function entry(overrides: Partial<QuarantineEntry> = {}): QuarantineEntry {
  return {
    testFilePath: 'tests/auth/x.spec.ts',
    suite: 'auth',
    quarantinedAt: '2026-01-01T00:00:00Z',
    evidence: [
      { attempt: 1, result: 'fail', timestamp: '2026-01-01T00:00:00Z' },
      { attempt: 2, result: 'pass', timestamp: '2026-01-01T00:01:00Z' },
    ],
    ...overrides,
  };
}

test('loadQuarantine returns an empty array when the file does not exist', () => {
  assert.deepEqual(loadQuarantine(path.join(tmpDir, 'nope.json')), []);
});

test('upsertQuarantineEntry adds a new entry and updates an existing one by testFilePath', () => {
  let entries = upsertQuarantineEntry([], entry());
  assert.equal(entries.length, 1);

  entries = upsertQuarantineEntry(entries, entry({ quarantinedAt: '2026-01-02T00:00:00Z' }));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].quarantinedAt, '2026-01-02T00:00:00Z');
});

test('removeQuarantineEntry removes only the matching testFilePath', () => {
  const entries = [entry(), entry({ testFilePath: 'tests/auth/y.spec.ts' })];
  const next = removeQuarantineEntry(entries, 'tests/auth/x.spec.ts');
  assert.equal(next.length, 1);
  assert.equal(next[0].testFilePath, 'tests/auth/y.spec.ts');
});

test('removeQuarantineEntry is a no-op when nothing matches', () => {
  const entries = [entry()];
  const next = removeQuarantineEntry(entries, 'tests/auth/nope.spec.ts');
  assert.equal(next.length, 1);
});

test('upsertQuarantineEntry treats testTitle as part of the key - two entries sharing a file stay separate', () => {
  let entries = upsertQuarantineEntry([], entry({ testTitle: 'scenario a' }));
  entries = upsertQuarantineEntry(entries, entry({ testTitle: 'scenario b' }));

  assert.equal(entries.length, 2);
});

test('upsertQuarantineEntry updates only the matching testTitle, leaving a sibling entry untouched', () => {
  let entries = upsertQuarantineEntry([], entry({ testTitle: 'scenario a', quarantinedAt: '2026-01-01T00:00:00Z' }));
  entries = upsertQuarantineEntry(entries, entry({ testTitle: 'scenario b', quarantinedAt: '2026-01-01T00:00:00Z' }));

  entries = upsertQuarantineEntry(entries, entry({ testTitle: 'scenario a', quarantinedAt: '2026-02-01T00:00:00Z' }));

  assert.equal(entries.find((e) => e.testTitle === 'scenario a')?.quarantinedAt, '2026-02-01T00:00:00Z');
  assert.equal(entries.find((e) => e.testTitle === 'scenario b')?.quarantinedAt, '2026-01-01T00:00:00Z');
});

test('removeQuarantineEntry removes only the matching (testFilePath, testTitle) pair', () => {
  const entries = [entry({ testTitle: 'scenario a' }), entry({ testTitle: 'scenario b' })];
  const next = removeQuarantineEntry(entries, 'tests/auth/x.spec.ts', 'scenario a');

  assert.equal(next.length, 1);
  assert.equal(next[0].testTitle, 'scenario b');
});

test('saveQuarantine then loadQuarantine round-trips', () => {
  saveQuarantine([entry()], quarantinePath);
  const loaded = loadQuarantine(quarantinePath);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].testFilePath, 'tests/auth/x.spec.ts');
});


test('updateQuarantine: applies the mutation, persists it, and releases the lock', () => {
  const quarantinePath = path.join(tmpDir, 'update-quarantine.json');
  saveQuarantine([], quarantinePath);

  const entry: QuarantineEntry = {
    testFilePath: 'tests/checkout.spec.ts',
    testTitle: 'refund over 30 days',
    suite: 'checkout',
    quarantinedAt: '2026-04-14T00:00:00.000Z',
    evidence: [
      { attempt: 1, result: 'fail', timestamp: '2026-04-13T00:00:00.000Z' },
      { attempt: 2, result: 'pass', timestamp: '2026-04-14T00:00:00.000Z' },
    ],
  };

  updateQuarantine((entries) => upsertQuarantineEntry(entries, entry), quarantinePath);

  assert.equal(loadQuarantine(quarantinePath).length, 1);
  assert.equal(fs.existsSync(`${quarantinePath}.lock`), false);
});

test('updateQuarantine: a throwing mutator leaves the stored list untouched', () => {
  const quarantinePath = path.join(tmpDir, 'update-quarantine-throws.json');
  saveQuarantine([], quarantinePath);
  assert.throws(() => updateQuarantine(() => { throw new Error('mutator failed'); }, quarantinePath));
  assert.deepEqual(loadQuarantine(quarantinePath), []);
  assert.equal(fs.existsSync(`${quarantinePath}.lock`), false);
});
