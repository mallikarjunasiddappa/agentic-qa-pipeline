import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPreviousSyncStateMap, findNewlyDrifted, postDriftComments } from './jiraNotify';
import type { DriftReportEntry } from './traceabilityAgent';
import type { TraceabilityEntry } from '../types/schemas';

function driftEntry(overrides: Partial<DriftReportEntry>): DriftReportEntry {
  return {
    jiraKey: 'KAN-1',
    externalCaseId: '1',
    externalCaseHash: 'h1',
    externalCaseUpdatedAt: '2026-01-01T00:00:00Z',
    tmsProvider: 'qase',
    testFilePath: 'tests/a.spec.ts',
    testContentHash: 'h2',
    testLastModified: '2026-01-01T00:00:00Z',
    syncState: 'IN_SYNC',
    lastCheckedAt: '2026-01-01T00:00:00Z',
    currentExternalCaseHash: 'h1',
    currentTestContentHash: 'h2',
    ...overrides,
  };
}

test('findNewlyDrifted only includes entries that transitioned into a drifted state', () => {
  const previous = new Map([
    ['KAN-1::1::tests/a.spec.ts', 'IN_SYNC' as const],
    ['KAN-1::2::tests/b.spec.ts', 'CASE_DRIFTED' as const],
  ]);
  const entries = [
    driftEntry({ externalCaseId: '1', testFilePath: 'tests/a.spec.ts', syncState: 'CASE_DRIFTED' }), // new
    driftEntry({ externalCaseId: '2', testFilePath: 'tests/b.spec.ts', syncState: 'CASE_DRIFTED' }), // already drifted
    driftEntry({ externalCaseId: '3', testFilePath: 'tests/c.spec.ts', syncState: 'IN_SYNC' }), // not drifted
  ];

  const newlyDrifted = findNewlyDrifted(entries, previous);

  assert.equal(newlyDrifted.length, 1);
  assert.equal(newlyDrifted[0].externalCaseId, '1');
});

test('buildPreviousSyncStateMap round-trips through findNewlyDrifted for a fresh manifest', () => {
  const manifest: TraceabilityEntry[] = [
    {
      jiraKey: 'KAN-1',
      externalCaseId: '1',
      externalCaseHash: 'h1',
      externalCaseUpdatedAt: '2026-01-01T00:00:00Z',
      tmsProvider: 'qase',
      testFilePath: 'tests/a.spec.ts',
      testContentHash: 'h2',
      testLastModified: '2026-01-01T00:00:00Z',
      syncState: 'IN_SYNC',
      lastCheckedAt: '2026-01-01T00:00:00Z',
    },
  ];
  const previous = buildPreviousSyncStateMap(manifest);
  const entries = [driftEntry({ externalCaseId: '1', testFilePath: 'tests/a.spec.ts', syncState: 'BOTH_DRIFTED' })];

  assert.equal(findNewlyDrifted(entries, previous).length, 1);
});

test('postDriftComments groups entries by jiraKey into one comment per ticket', async () => {
  const newlyDrifted = [
    driftEntry({ jiraKey: 'KAN-1', externalCaseId: '1', testFilePath: 'tests/a.spec.ts', syncState: 'CASE_DRIFTED' }),
    driftEntry({ jiraKey: 'KAN-1', externalCaseId: '2', testFilePath: 'tests/b.spec.ts', syncState: 'BOTH_DRIFTED' }),
    driftEntry({ jiraKey: 'KAN-2', externalCaseId: '3', testFilePath: 'tests/c.spec.ts', syncState: 'CASE_DRIFTED' }),
  ];

  const calls: { key: string; text: string }[] = [];
  const mockJira = {
    async addComment(key: string, text: string) {
      calls.push({ key, text });
    },
  };

  const posted = await postDriftComments(newlyDrifted, mockJira);

  assert.equal(calls.length, 2);
  assert.deepEqual(
    posted.sort((a, b) => a.jiraKey.localeCompare(b.jiraKey)),
    [
      { jiraKey: 'KAN-1', entryCount: 2 },
      { jiraKey: 'KAN-2', entryCount: 1 },
    ],
  );

  const kan1Comment = calls.find((c) => c.key === 'KAN-1')!;
  assert.match(kan1Comment.text, /Case 1 \(tests\/a\.spec\.ts\) - CASE_DRIFTED/);
  assert.match(kan1Comment.text, /Case 2 \(tests\/b\.spec\.ts\) - BOTH_DRIFTED/);
});

test('postDriftComments does nothing when there is nothing newly drifted', async () => {
  let called = false;
  const mockJira = {
    async addComment() {
      called = true;
    },
  };
  const posted = await postDriftComments([], mockJira);
  assert.equal(called, false);
  assert.deepEqual(posted, []);
});
