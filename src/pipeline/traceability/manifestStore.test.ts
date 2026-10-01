import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadManifest,
  saveManifest,
  findWorkflowRecord,
  upsertWorkflowRecord,
  findEntry,
  upsertEntry,
  updateTestBaseline,
  findEntryByTestFilePath,
  removeEntry,
  updateManifest,
} from './manifestStore';
import type { TraceabilityEntry, WorkflowRecord } from '../types/schemas';

let tmpDir: string;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-store-test-'));
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function entry(overrides: Partial<TraceabilityEntry> = {}): TraceabilityEntry {
  return {
    jiraKey: 'KAN-1',
    externalCaseId: '1',
    externalCaseHash: 'h1',
    externalCaseUpdatedAt: '2026-01-01T00:00:00Z',
    tmsProvider: 'qase',
    testFilePath: 'tests/auth/x.spec.ts',
    testContentHash: 'th1',
    testLastModified: '2026-01-01T00:00:00Z',
    syncState: 'IN_SYNC',
    lastCheckedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

test('loadManifest returns an empty {workflow, entries} shape when the file does not exist', () => {
  assert.deepEqual(loadManifest(path.join(tmpDir, 'nope.json')), { workflow: [], entries: [] });
});

test('loadManifest upgrades a pre-approval-gates flat-array manifest into {workflow: [], entries}', () => {
  const legacyPath = path.join(tmpDir, 'legacy-manifest.json');
  fs.writeFileSync(legacyPath, JSON.stringify([entry()]), 'utf-8');

  const loaded = loadManifest(legacyPath);
  assert.deepEqual(loaded.workflow, []);
  assert.equal(loaded.entries.length, 1);
  assert.equal(loaded.entries[0].jiraKey, 'KAN-1');
});

test('saveManifest then loadManifest round-trips both workflow and entries', () => {
  const manifestPath = path.join(tmpDir, 'manifest.json');
  const workflow: WorkflowRecord[] = [{ jiraKey: 'KAN-2', scenariosApprovedAt: '2026-01-01T00:00:00Z' }];
  saveManifest({ workflow, entries: [entry()] }, manifestPath);

  const loaded = loadManifest(manifestPath);
  assert.deepEqual(loaded.workflow, workflow);
  assert.equal(loaded.entries.length, 1);
});

test('findWorkflowRecord finds by jiraKey and returns undefined when absent', () => {
  const workflow: WorkflowRecord[] = [{ jiraKey: 'KAN-2', scenariosApprovedAt: '2026-01-01T00:00:00Z' }];
  assert.equal(findWorkflowRecord(workflow, 'KAN-2')?.scenariosApprovedAt, '2026-01-01T00:00:00Z');
  assert.equal(findWorkflowRecord(workflow, 'KAN-99'), undefined);
});

test('upsertWorkflowRecord adds a new record when none exists for that jiraKey', () => {
  const next = upsertWorkflowRecord([], { jiraKey: 'KAN-3', scenariosApprovedAt: '2026-01-01T00:00:00Z' });
  assert.equal(next.length, 1);
  assert.equal(next[0].jiraKey, 'KAN-3');
});

test('upsertWorkflowRecord merges into an existing record without clobbering other fields', () => {
  const workflow: WorkflowRecord[] = [{ jiraKey: 'KAN-4', scenariosApprovedAt: '2026-01-01T00:00:00Z' }];
  const next = upsertWorkflowRecord(workflow, { jiraKey: 'KAN-4', testCasesApprovedAt: '2026-01-02T00:00:00Z' });

  assert.equal(next.length, 1);
  // Gate 1's timestamp must survive setting Gate 2 - this is what lets the two gates be recorded
  // independently, at different times, on the same jiraKey's workflow record.
  assert.equal(next[0].scenariosApprovedAt, '2026-01-01T00:00:00Z');
  assert.equal(next[0].testCasesApprovedAt, '2026-01-02T00:00:00Z');
});

test('existing per-case entry helpers (findEntry/upsertEntry) are unaffected by the manifest shape change', () => {
  const entries = upsertEntry([], entry());
  assert.equal(entries.length, 1);
  const found = findEntry(entries, { jiraKey: 'KAN-1', externalCaseId: '1', testFilePath: 'tests/auth/x.spec.ts' });
  assert.ok(found);
});

test('upsertEntry treats testTitle as part of the key - two entries sharing a file get separate rows', () => {
  let entries = upsertEntry([], entry({ externalCaseId: '1', testTitle: 'scenario a' }));
  entries = upsertEntry(entries, entry({ externalCaseId: '2', testTitle: 'scenario b' }));

  assert.equal(entries.length, 2);
  assert.equal(entries.find((e) => e.externalCaseId === '1')?.testTitle, 'scenario a');
  assert.equal(entries.find((e) => e.externalCaseId === '2')?.testTitle, 'scenario b');
});

test('upsertEntry replaces only the matching testTitle, leaving a sibling entry in the same file untouched', () => {
  let entries = upsertEntry([], entry({ externalCaseId: '1', testTitle: 'scenario a', syncState: 'IN_SYNC' }));
  entries = upsertEntry(entries, entry({ externalCaseId: '2', testTitle: 'scenario b', syncState: 'IN_SYNC' }));

  entries = upsertEntry(entries, entry({ externalCaseId: '1', testTitle: 'scenario a', syncState: 'TEST_DRIFTED' }));

  assert.equal(entries.length, 2);
  assert.equal(entries.find((e) => e.externalCaseId === '1')?.syncState, 'TEST_DRIFTED');
  assert.equal(entries.find((e) => e.externalCaseId === '2')?.syncState, 'IN_SYNC');
});

test('findEntryByTestFilePath returns every entry sharing a file, not just the first', () => {
  const entries = [
    entry({ externalCaseId: '1', testTitle: 'scenario a' }),
    entry({ externalCaseId: '2', testTitle: 'scenario b' }),
    entry({ externalCaseId: '3', testFilePath: 'tests/auth/other.spec.ts' }),
  ];
  const found = findEntryByTestFilePath(entries, 'tests/auth/x.spec.ts');
  assert.equal(found.length, 2);
});

test('updateTestBaseline updates only the entry matching both testFilePath and testTitle', () => {
  const entries = [
    entry({ externalCaseId: '1', testTitle: 'scenario a', testContentHash: 'old-a' }),
    entry({ externalCaseId: '2', testTitle: 'scenario b', testContentHash: 'old-b' }),
  ];
  const next = updateTestBaseline(entries, 'tests/auth/x.spec.ts', 'new-a', '2026-02-01T00:00:00Z', 'scenario a');

  assert.equal(next.find((e) => e.externalCaseId === '1')?.testContentHash, 'new-a');
  assert.equal(next.find((e) => e.externalCaseId === '2')?.testContentHash, 'old-b');
});

test('updateTestBaseline throws instead of guessing when a file has multiple entries and no testTitle is given', () => {
  const entries = [
    entry({ externalCaseId: '1', testTitle: 'scenario a' }),
    entry({ externalCaseId: '2', testTitle: 'scenario b' }),
  ];
  assert.throws(() => updateTestBaseline(entries, 'tests/auth/x.spec.ts', 'new-hash', '2026-02-01T00:00:00Z'));
});

test('updateTestBaseline still works with no testTitle when the file has exactly one entry (legacy path)', () => {
  const entries = [entry({ testContentHash: 'old' })];
  const next = updateTestBaseline(entries, 'tests/auth/x.spec.ts', 'new', '2026-02-01T00:00:00Z');
  assert.equal(next[0].testContentHash, 'new');
});

test('removeEntry removes the single entry matching the full key', () => {
  const entries = [entry({ jiraKey: 'KAN-1', externalCaseId: '1', testFilePath: 'tests/auth/x.spec.ts' })];
  const next = removeEntry(entries, {
    jiraKey: 'KAN-1',
    externalCaseId: '1',
    testFilePath: 'tests/auth/x.spec.ts',
  });
  assert.equal(next.length, 0);
});

test('removeEntry returns the same array reference when nothing matches (no accidental no-op write)', () => {
  const entries = [entry({ jiraKey: 'KAN-1', externalCaseId: '1', testFilePath: 'tests/auth/x.spec.ts' })];
  const next = removeEntry(entries, {
    jiraKey: 'KAN-1',
    externalCaseId: '999',
    testFilePath: 'tests/auth/x.spec.ts',
  });
  assert.equal(next, entries);
});

test('removeEntry only removes the entry matching testTitle, leaving a sibling entry in the same shared file untouched', () => {
  const entries = [
    entry({ externalCaseId: '1', testTitle: 'scenario a' }),
    entry({ externalCaseId: '2', testTitle: 'scenario b' }),
  ];
  const next = removeEntry(entries, {
    jiraKey: 'KAN-1',
    externalCaseId: '1',
    testFilePath: 'tests/auth/x.spec.ts',
    testTitle: 'scenario a',
  });

  assert.equal(next.length, 1);
  assert.equal(next[0].externalCaseId, '2');
});

test('removeEntry treats testTitle as part of the key - omitting it does not match an entry that has one', () => {
  const entries = [entry({ externalCaseId: '1', testTitle: 'scenario a' })];
  const next = removeEntry(entries, { jiraKey: 'KAN-1', externalCaseId: '1', testFilePath: 'tests/auth/x.spec.ts' });
  // testTitle omitted (undefined) does not equal 'scenario a', same "undefined is part of the key,
  // not a wildcard" rule findEntry/upsertEntry already use - this is a deliberate refuse-to-guess
  // case, not a bug.
  assert.equal(next, entries);
});

test('removeEntry never removes more than one entry even if the key were somehow ambiguous', () => {
  const entries = [
    entry({ externalCaseId: '1', testTitle: 'scenario a' }),
    entry({ externalCaseId: '1', testTitle: 'scenario a', testFilePath: 'tests/auth/other.spec.ts' }),
  ];
  const next = removeEntry(entries, {
    jiraKey: 'KAN-1',
    externalCaseId: '1',
    testFilePath: 'tests/auth/x.spec.ts',
    testTitle: 'scenario a',
  });
  assert.equal(next.length, 1);
  assert.equal(next[0].testFilePath, 'tests/auth/other.spec.ts');
});


// --- the approval-gate erasure ------------------------------------------------------------------

test('upsertWorkflowRecord: an undefined field does not erase a stored approval', () => {
  // Object spread copies a key even when its value is undefined, and callers pass
  // `x: condition ? value : undefined` routinely. Re-running gap detection after a human had
  // approved Gate 0 used to wipe requirementsClearedAt/By - silently re-locking the gate with no
  // record of who un-approved it, because nobody had.
  const approved: WorkflowRecord = {
    jiraKey: 'KAN-1',
    requirementsClearedAt: '2026-08-01T00:00:00.000Z',
    requirementsClearedBy: 'a.person',
  };
  const next = upsertWorkflowRecord([approved], {
    jiraKey: 'KAN-1',
    requirementGapsCheckedAt: '2026-08-30T00:00:00.000Z',
    requirementsClearedAt: undefined,
    requirementsClearedBy: undefined,
  });

  const record = findWorkflowRecord(next, 'KAN-1');
  assert.equal(record?.requirementsClearedAt, '2026-08-01T00:00:00.000Z');
  assert.equal(record?.requirementsClearedBy, 'a.person');
  assert.equal(record?.requirementGapsCheckedAt, '2026-08-30T00:00:00.000Z');
});

test('upsertWorkflowRecord: a defined field still overwrites', () => {
  const next = upsertWorkflowRecord(
    [{ jiraKey: 'KAN-1', requirementsClearedBy: 'first.person' }],
    { jiraKey: 'KAN-1', requirementsClearedBy: 'second.person' },
  );
  assert.equal(findWorkflowRecord(next, 'KAN-1')?.requirementsClearedBy, 'second.person');
});

test('upsertWorkflowRecord: a record for a new jiraKey is still appended whole', () => {
  const next = upsertWorkflowRecord([{ jiraKey: 'KAN-1' }], { jiraKey: 'KAN-2' });
  assert.equal(next.length, 2);
  assert.ok(findWorkflowRecord(next, 'KAN-2'));
});

// --- locked read-modify-write --------------------------------------------------------------------

test('updateManifest: applies the mutation and persists it', () => {
  const manifestPath = path.join(tmpDir, 'update-manifest.json');
  saveManifest({ workflow: [{ jiraKey: 'KAN-1' }], entries: [] }, manifestPath);

  const returned = updateManifest(
    (m) => ({ ...m, workflow: upsertWorkflowRecord(m.workflow, { jiraKey: 'KAN-2' }) }),
    manifestPath,
  );

  assert.equal(returned.workflow.length, 2);
  assert.equal(loadManifest(manifestPath).workflow.length, 2);
});

test('updateManifest: releases its lock, so a second update can follow', () => {
  const manifestPath = path.join(tmpDir, 'update-manifest-twice.json');
  saveManifest({ workflow: [], entries: [] }, manifestPath);
  updateManifest((m) => ({ ...m, workflow: [{ jiraKey: 'KAN-1' }] }), manifestPath);
  updateManifest((m) => ({ ...m, workflow: [...m.workflow, { jiraKey: 'KAN-2' }] }), manifestPath);
  assert.deepEqual(loadManifest(manifestPath).workflow.map((w) => w.jiraKey), ['KAN-1', 'KAN-2']);
});

test('updateManifest: a throwing mutator leaves the stored manifest untouched', () => {
  const manifestPath = path.join(tmpDir, 'update-manifest-throws.json');
  saveManifest({ workflow: [{ jiraKey: 'KAN-1' }], entries: [] }, manifestPath);
  assert.throws(() => updateManifest(() => { throw new Error('mutator failed'); }, manifestPath));
  assert.deepEqual(loadManifest(manifestPath).workflow.map((w) => w.jiraKey), ['KAN-1']);
  assert.equal(fs.existsSync(`${manifestPath}.lock`), false);
});

test('saveManifest: never leaves a partial file, and no temp files behind', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-atomic-'));
  const manifestPath = path.join(dir, 'manifest.json');
  saveManifest({ workflow: [], entries: [] }, manifestPath);
  saveManifest({ workflow: [{ jiraKey: 'KAN-9' }], entries: [] }, manifestPath);
  assert.deepEqual(fs.readdirSync(dir), ['manifest.json']);
  assert.equal(loadManifest(manifestPath).workflow[0].jiraKey, 'KAN-9');
});
