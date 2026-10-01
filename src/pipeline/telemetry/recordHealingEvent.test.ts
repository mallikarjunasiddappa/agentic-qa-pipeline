import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendHealingEvent, readHealingEvents } from './recordHealingEvent';
import type { HealingEvent } from '../types/schemas';

let tmpDir: string;
let logPath: string;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry-test-'));
  logPath = path.join(tmpDir, 'telemetry.jsonl');
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function healedEvent(overrides: Partial<HealingEvent> = {}): HealingEvent {
  return {
    timestamp: '2026-01-01T00:00:00Z',
    testFilePath: 'tests/auth/x.spec.ts',
    suite: 'auth',
    attemptNumber: 1,
    outcome: 'healed',
    category: 'locator_drift',
    ...overrides,
  };
}

test('readHealingEvents returns an empty array when the log does not exist', () => {
  assert.deepEqual(readHealingEvents(path.join(tmpDir, 'nope.jsonl')), []);
});

test('appendHealingEvent appends without rewriting prior lines', () => {
  appendHealingEvent(healedEvent({ testFilePath: 'tests/auth/a.spec.ts' }), logPath);
  appendHealingEvent(
    healedEvent({ testFilePath: 'tests/auth/b.spec.ts', outcome: 'escalated', category: 'real_regression' }),
    logPath,
  );

  const events = readHealingEvents(logPath);
  assert.equal(events.length, 2);
  assert.equal(events[0].testFilePath, 'tests/auth/a.spec.ts');
  assert.equal(events[1].testFilePath, 'tests/auth/b.spec.ts');
  assert.equal(events[1].outcome, 'escalated');
});

test('appendHealingEvent accepts passed_no_heal_needed with no category', () => {
  appendHealingEvent(
    healedEvent({
      testFilePath: 'tests/auth/c.spec.ts',
      outcome: 'passed_no_heal_needed',
      attemptNumber: 0,
      category: undefined,
    }),
    logPath,
  );
  const events = readHealingEvents(logPath);
  const last = events[events.length - 1];
  assert.equal(last.outcome, 'passed_no_heal_needed');
  assert.equal(last.category, undefined);
});

test('appendHealingEvent rejects "healed" with no category', () => {
  assert.throws(() =>
    appendHealingEvent(
      { ...healedEvent(), category: undefined },
      logPath,
    ),
  );
});
