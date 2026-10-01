import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendFlakyEvent, readFlakyEvents } from './recordFlakyEvent';
import type { FlakyEvent } from '../types/schemas';

let tmpDir: string;
let logPath: string;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flaky-telemetry-test-'));
  logPath = path.join(tmpDir, 'telemetry.jsonl');
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function quarantinedEvent(overrides: Partial<FlakyEvent> = {}): FlakyEvent {
  return {
    timestamp: '2026-01-01T00:00:00Z',
    testFilePath: 'tests/auth/x.spec.ts',
    suite: 'auth',
    evidence: [
      { attempt: 1, result: 'fail', timestamp: '2026-01-01T00:00:00Z' },
      { attempt: 2, result: 'pass', timestamp: '2026-01-01T00:01:00Z' },
      { attempt: 3, result: 'fail', timestamp: '2026-01-01T00:02:00Z' },
    ],
    action: 'quarantined',
    ...overrides,
  };
}

test('readFlakyEvents returns an empty array when the log does not exist', () => {
  assert.deepEqual(readFlakyEvents(path.join(tmpDir, 'nope.jsonl')), []);
});

test('appendFlakyEvent appends without rewriting prior lines', () => {
  appendFlakyEvent(quarantinedEvent({ testFilePath: 'tests/auth/a.spec.ts' }), logPath);
  appendFlakyEvent(
    quarantinedEvent({
      testFilePath: 'tests/auth/b.spec.ts',
      action: 'cleared',
      evidence: [
        { attempt: 1, result: 'pass', timestamp: '2026-01-02T00:00:00Z' },
        { attempt: 2, result: 'pass', timestamp: '2026-01-02T00:01:00Z' },
      ],
    }),
    logPath,
  );

  const events = readFlakyEvents(logPath);
  assert.equal(events.length, 2);
  assert.equal(events[0].testFilePath, 'tests/auth/a.spec.ts');
  assert.equal(events[1].testFilePath, 'tests/auth/b.spec.ts');
  assert.equal(events[1].action, 'cleared');
});

test('appendFlakyEvent rejects evidence with fewer than 2 entries', () => {
  assert.throws(() =>
    appendFlakyEvent(
      quarantinedEvent({
        testFilePath: 'tests/auth/c.spec.ts',
        evidence: [{ attempt: 1, result: 'fail', timestamp: '2026-01-01T00:00:00Z' }],
      }),
      logPath,
    ),
  );
});
