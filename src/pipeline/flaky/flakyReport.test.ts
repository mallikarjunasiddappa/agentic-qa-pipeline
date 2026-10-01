import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFlakyReport } from './flakyReport';
import type { FlakyEvent, QuarantineEntry } from '../types/schemas';

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

function quarantineEntry(overrides: Partial<QuarantineEntry> = {}): QuarantineEntry {
  return {
    testFilePath: 'tests/auth/x.spec.ts',
    suite: 'auth',
    quarantinedAt: '2026-01-01T00:00:00Z',
    evidence: quarantinedEvent().evidence,
    ...overrides,
  };
}

test('buildFlakyReport reports zeroes and null average with no events', () => {
  const report = buildFlakyReport([], []);
  assert.equal(report.totalQuarantinedAllTime, 0);
  assert.equal(report.currentlyActive, 0);
  assert.deepEqual(report.breakdownBySuite, []);
  assert.equal(report.avgRunsToDetect, null);
});

test('buildFlakyReport counts only quarantined (not cleared) events in the all-time total', () => {
  const events: FlakyEvent[] = [
    quarantinedEvent({ testFilePath: 'tests/auth/a.spec.ts' }),
    quarantinedEvent({ testFilePath: 'tests/auth/a.spec.ts', action: 'cleared' }),
    quarantinedEvent({ testFilePath: 'tests/checkout/b.spec.ts', suite: 'checkout' }),
  ];
  const report = buildFlakyReport(events, []);
  assert.equal(report.totalQuarantinedAllTime, 2);
});

test('buildFlakyReport currentlyActive and breakdownBySuite come from the quarantine snapshot, not the log', () => {
  const events: FlakyEvent[] = [quarantinedEvent()];
  const quarantine: QuarantineEntry[] = [
    quarantineEntry(),
    quarantineEntry({ testFilePath: 'tests/checkout/b.spec.ts', suite: 'checkout' }),
  ];
  const report = buildFlakyReport(events, quarantine);
  assert.equal(report.currentlyActive, 2);
  assert.deepEqual(report.breakdownBySuite, [
    { suite: 'auth', activeCount: 1 },
    { suite: 'checkout', activeCount: 1 },
  ]);
});

test('buildFlakyReport computes avgRunsToDetect from quarantined-event evidence length', () => {
  const events: FlakyEvent[] = [
    quarantinedEvent({ testFilePath: 'tests/auth/a.spec.ts' }), // 3 entries
    quarantinedEvent({
      testFilePath: 'tests/auth/b.spec.ts',
      evidence: [
        { attempt: 1, result: 'fail', timestamp: '2026-01-01T00:00:00Z' },
        { attempt: 2, result: 'pass', timestamp: '2026-01-01T00:01:00Z' },
      ], // 2 entries
    }),
  ];
  const report = buildFlakyReport(events, []);
  assert.equal(report.avgRunsToDetect, 2.5);
});
