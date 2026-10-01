import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildBlockerScanReport,
  buildBlockerEscalationComment,
  buildBlockerEscalationSlackMessage,
  computeIdleDays,
  assertSupportedChannel,
  BlockerScanFlaggedIssue,
} from './blockerScan';
import { SprintStatusBoardSprint } from './sprintStatus';
import { SprintInfo, SprintIssueSnapshot } from '../agileClient';

function sprint(overrides: Partial<SprintInfo> = {}): SprintInfo {
  return {
    id: 100,
    name: 'Sprint 12',
    state: 'active',
    startDate: '2026-08-01T00:00:00.000Z',
    endDate: '2026-08-14T00:00:00.000Z',
    ...overrides,
  };
}

function issue(overrides: Partial<SprintIssueSnapshot> = {}): SprintIssueSnapshot {
  return {
    key: 'PROJ-1',
    summary: 'Do the thing',
    status: 'In Progress',
    statusCategory: 'indeterminate',
    assignee: 'Jane Doe',
    assigneeEmail: 'jane@example.com',
    storyPoints: 3,
    updated: '2026-08-10T00:00:00.000Z',
    ...overrides,
  };
}

function boardSprint(overrides: Partial<SprintStatusBoardSprint> = {}): SprintStatusBoardSprint {
  return {
    boardId: '35',
    sprint: sprint(),
    issues: [],
    ...overrides,
  };
}

const NOW = new Date('2026-08-20T00:00:00.000Z');

// --- computeIdleDays ---

test('computeIdleDays returns whole calendar days between updated and now', () => {
  assert.equal(computeIdleDays('2026-08-10T00:00:00.000Z', NOW), 10);
});

test('computeIdleDays floors a partial day rather than rounding', () => {
  assert.equal(computeIdleDays('2026-08-10T12:00:00.000Z', NOW), 9);
});

test('computeIdleDays returns 0 when updated is exactly now', () => {
  assert.equal(computeIdleDays(NOW.toISOString(), NOW), 0);
});

test('computeIdleDays returns a negative number (not clamped) when updated is in the future', () => {
  assert.equal(computeIdleDays('2026-08-25T00:00:00.000Z', NOW), -5);
});

// --- assertSupportedChannel ---

test('assertSupportedChannel does not throw for slack-dm', () => {
  assert.doesNotThrow(() => assertSupportedChannel('slack-dm'));
});

test('assertSupportedChannel does not throw for slack-channel', () => {
  assert.doesNotThrow(() => assertSupportedChannel('slack-channel'));
});

test('assertSupportedChannel does not throw for email - it has a real client now (emailClient.ts)', () => {
  assert.doesNotThrow(() => assertSupportedChannel('email'));
});

test('assertSupportedChannel throws a clear error for an unimplemented channel like teams', () => {
  assert.throws(() => assertSupportedChannel('teams'), /not supported yet/);
});

test('assertSupportedChannel throws for a typo/unrecognized value', () => {
  assert.throws(() => assertSupportedChannel('slack-channell'), /not supported yet/);
});

// --- buildBlockerScanReport ---

test('buildBlockerScanReport returns no flagged issues when there are none idle past the threshold', () => {
  const report = buildBlockerScanReport(
    ['35'],
    [boardSprint({ issues: [issue({ updated: '2026-08-19T00:00:00.000Z' })] })],
    3,
    NOW,
  );
  assert.equal(report.flaggedCount, 0);
  assert.deepEqual(report.issues, []);
});

test('buildBlockerScanReport flags an issue whose idleDays meets the threshold exactly', () => {
  const report = buildBlockerScanReport(
    ['35'],
    [boardSprint({ issues: [issue({ key: 'PROJ-2', updated: '2026-08-17T00:00:00.000Z' })] })],
    3,
    NOW,
  );
  assert.equal(report.flaggedCount, 1);
  assert.equal(report.issues[0].key, 'PROJ-2');
  assert.equal(report.issues[0].idleDays, 3);
});

test('buildBlockerScanReport excludes done issues regardless of how idle they are', () => {
  const report = buildBlockerScanReport(
    ['35'],
    [
      boardSprint({
        issues: [issue({ key: 'PROJ-3', statusCategory: 'done', updated: '2026-01-01T00:00:00.000Z' })],
      }),
    ],
    3,
    NOW,
  );
  assert.equal(report.flaggedCount, 0);
});

test('buildBlockerScanReport flags issues regardless of status name - no status-name guessing', () => {
  const report = buildBlockerScanReport(
    ['35'],
    [
      boardSprint({
        issues: [
          issue({ key: 'PROJ-4', status: 'In Progress', statusCategory: 'indeterminate', updated: '2026-08-01T00:00:00.000Z' }),
          issue({ key: 'PROJ-5', status: 'To Do', statusCategory: 'new', updated: '2026-08-01T00:00:00.000Z' }),
          issue({ key: 'PROJ-6', status: 'Some Custom Status', statusCategory: 'unknown', updated: '2026-08-01T00:00:00.000Z' }),
        ],
      }),
    ],
    3,
    NOW,
  );
  assert.deepEqual(
    report.issues.map((i) => i.key).sort(),
    ['PROJ-4', 'PROJ-5', 'PROJ-6'],
  );
});

test('buildBlockerScanReport sorts most-idle first, then by key for ties', () => {
  const report = buildBlockerScanReport(
    ['35'],
    [
      boardSprint({
        issues: [
          issue({ key: 'PROJ-B', updated: '2026-08-10T00:00:00.000Z' }), // 10 days idle
          issue({ key: 'PROJ-A', updated: '2026-08-05T00:00:00.000Z' }), // 15 days idle
          issue({ key: 'PROJ-C', updated: '2026-08-05T00:00:00.000Z' }), // 15 days idle, tie on key
        ],
      }),
    ],
    3,
    NOW,
  );
  assert.deepEqual(
    report.issues.map((i) => i.key),
    ['PROJ-A', 'PROJ-C', 'PROJ-B'],
  );
});

test('buildBlockerScanReport combines issues across multiple boards/sprints', () => {
  const report = buildBlockerScanReport(
    ['35', '40'],
    [
      boardSprint({ boardId: '35', issues: [issue({ key: 'PROJ-7', updated: '2026-08-01T00:00:00.000Z' })] }),
      boardSprint({
        boardId: '40',
        sprint: sprint({ id: 200, name: 'Sprint 13' }),
        issues: [issue({ key: 'PROJ-8', updated: '2026-08-01T00:00:00.000Z' })],
      }),
    ],
    3,
    NOW,
  );
  assert.deepEqual(
    report.issues.map((i) => `${i.key}:${i.boardId}:${i.sprintName}`).sort(),
    ['PROJ-7:35:Sprint 12', 'PROJ-8:40:Sprint 13'],
  );
});

test('buildBlockerScanReport echoes boardIds and idleDaysThreshold onto the report', () => {
  const report = buildBlockerScanReport(['35', '40'], [], 5, NOW);
  assert.deepEqual(report.boardIds, ['35', '40']);
  assert.equal(report.idleDaysThreshold, 5);
  assert.equal(report.generatedAt, NOW.toISOString());
});

test('buildBlockerScanReport never sets escalations - stays a pure, delivery-free mapper', () => {
  const report = buildBlockerScanReport(
    ['35'],
    [boardSprint({ issues: [issue({ updated: '2026-08-01T00:00:00.000Z' })] })],
    3,
    NOW,
  );
  assert.equal(report.issues[0].escalations, undefined);
});

// --- buildBlockerEscalationComment ---

function flaggedIssue(overrides: Partial<BlockerScanFlaggedIssue> = {}): BlockerScanFlaggedIssue {
  return {
    key: 'PROJ-1',
    summary: 'Do the thing',
    status: 'In Progress',
    statusCategory: 'indeterminate',
    assignee: 'Jane Doe',
    assigneeEmail: 'jane@example.com',
    boardId: '35',
    sprintName: 'Sprint 12',
    updated: '2026-08-10T00:00:00.000Z',
    idleDays: 10,
    ...overrides,
  };
}

test('buildBlockerEscalationComment includes idle days, updated timestamp, and threshold', () => {
  const comment = buildBlockerEscalationComment(flaggedIssue(), 3);
  assert.match(comment, /idle for 10 day\(s\)/);
  assert.match(comment, /2026-08-10T00:00:00\.000Z/);
  assert.match(comment, /3-day idle threshold/);
});

test('buildBlockerEscalationComment includes status and assignee', () => {
  const comment = buildBlockerEscalationComment(flaggedIssue(), 3);
  assert.match(comment, /Status: In Progress/);
  assert.match(comment, /Assignee: Jane Doe/);
});

test('buildBlockerEscalationComment labels a null assignee as Unassigned', () => {
  const comment = buildBlockerEscalationComment(flaggedIssue({ assignee: null }), 3);
  assert.match(comment, /Assignee: Unassigned/);
});

test('buildBlockerEscalationComment notes this is a report only, nothing changed', () => {
  const comment = buildBlockerEscalationComment(flaggedIssue(), 3);
  assert.match(comment, /report only/i);
});

// --- buildBlockerEscalationSlackMessage ---

test('buildBlockerEscalationSlackMessage includes the ticket key and idle days in the headline', () => {
  const message = buildBlockerEscalationSlackMessage(flaggedIssue(), 3);
  assert.match(message.text, /PROJ-1/);
  assert.match(message.text, /idle for 10 day\(s\)/);
});

test('buildBlockerEscalationSlackMessage produces non-empty blocks', () => {
  const message = buildBlockerEscalationSlackMessage(flaggedIssue(), 3);
  assert.ok(message.blocks.length > 0);
});

test('buildBlockerEscalationSlackMessage labels a null assignee as Unassigned', () => {
  const message = buildBlockerEscalationSlackMessage(flaggedIssue({ assignee: null }), 3);
  assert.match(message.text, /Assignee:\* Unassigned/);
});

test('buildBlockerEscalationSlackMessage includes the configured idle threshold', () => {
  const message = buildBlockerEscalationSlackMessage(flaggedIssue(), 7);
  assert.match(message.text, /Idle threshold:\* 7 day\(s\)/);
});
