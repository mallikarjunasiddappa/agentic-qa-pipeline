import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildStandupDigestReport,
  buildAssigneeEmailMap,
  buildStandupDigestSlackMessage,
  planStandupDigestDelivery,
  StandupDigestAssigneeSummary,
  StandupDigestDeliveryConfig,
} from './standupDigest';
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

function noDelivery(): StandupDigestDeliveryConfig {
  return { dm: false, channel: null };
}

test('buildStandupDigestReport returns an empty assignees array when there are no issues (not an error)', () => {
  const report = buildStandupDigestReport(['35'], [], 'customfield_10016', noDelivery(), new Date('2026-08-15T00:00:00.000Z'));
  assert.equal(report.generatedAt, '2026-08-15T00:00:00.000Z');
  assert.deepEqual(report.boardIds, ['35']);
  assert.equal(report.storyPointsField, 'customfield_10016');
  assert.deepEqual(report.assignees, []);
});

test('buildStandupDigestReport echoes storyPointsField as null when scrum.json has none configured', () => {
  const report = buildStandupDigestReport([], [], null, noDelivery());
  assert.equal(report.storyPointsField, null);
});

test('buildStandupDigestReport echoes configuredDelivery verbatim without acting on it', () => {
  const report = buildStandupDigestReport([], [], null, { dm: true, channel: null });
  assert.deepEqual(report.configuredDelivery, { dm: true, channel: null });

  const channelReport = buildStandupDigestReport([], [], null, { dm: false, channel: 'team-standup' });
  assert.deepEqual(channelReport.configuredDelivery, { dm: false, channel: 'team-standup' });
});

test('buildStandupDigestReport buckets issues by statusCategory into notStarted/inProgress/doneThisSprint/unknownStatus', () => {
  const report = buildStandupDigestReport(
    ['35'],
    [
      boardSprint({
        issues: [
          issue({ key: 'PROJ-1', statusCategory: 'new' }),
          issue({ key: 'PROJ-2', statusCategory: 'indeterminate' }),
          issue({ key: 'PROJ-3', statusCategory: 'done' }),
          issue({ key: 'PROJ-4', statusCategory: 'unknown' }),
        ],
      }),
    ],
    'customfield_10016',
    noDelivery(),
  );
  const jane = report.assignees.find((a) => a.assignee === 'Jane Doe')!;
  assert.deepEqual(jane.notStarted.map((e) => e.key), ['PROJ-1']);
  assert.deepEqual(jane.inProgress.map((e) => e.key), ['PROJ-2']);
  assert.deepEqual(jane.doneThisSprint.map((e) => e.key), ['PROJ-3']);
  assert.deepEqual(jane.unknownStatus.map((e) => e.key), ['PROJ-4']);
});

test('buildStandupDigestReport has no blocked bucket - a "Blocked" status name still lands in inProgress', () => {
  // Explicit design decision: statusCategory is the only signal used, never a status-name text
  // match, so a status literally named "Blocked" (still Jira's indeterminate category) is not
  // pulled into a special bucket here.
  const report = buildStandupDigestReport(
    ['35'],
    [boardSprint({ issues: [issue({ key: 'PROJ-1', status: 'Blocked', statusCategory: 'indeterminate' })] })],
    'customfield_10016',
    noDelivery(),
  );
  const jane = report.assignees[0];
  assert.deepEqual(jane.inProgress.map((e) => e.key), ['PROJ-1']);
  assert.equal((jane as any).blocked, undefined);
});

test('buildStandupDigestReport excludes null storyPoints from sums and counts them as unestimated, not zero', () => {
  const report = buildStandupDigestReport(
    ['35'],
    [
      boardSprint({
        issues: [
          issue({ key: 'PROJ-1', storyPoints: 5 }),
          issue({ key: 'PROJ-2', storyPoints: null }),
          issue({ key: 'PROJ-3', storyPoints: 0 }),
        ],
      }),
    ],
    'customfield_10016',
    noDelivery(),
  );
  const jane = report.assignees[0];
  assert.equal(jane.totalStoryPoints, 5);
  assert.equal(jane.unestimatedIssueCount, 1);
  assert.equal(jane.totalIssueCount, 3);
});

test('buildStandupDigestReport groups by assignee, sorted alphabetically with unassigned last', () => {
  const report = buildStandupDigestReport(
    ['35'],
    [
      boardSprint({
        issues: [
          issue({ key: 'PROJ-1', assignee: 'Zack' }),
          issue({ key: 'PROJ-2', assignee: null }),
          issue({ key: 'PROJ-3', assignee: 'Amy' }),
        ],
      }),
    ],
    'customfield_10016',
    noDelivery(),
  );
  assert.deepEqual(
    report.assignees.map((a) => a.assignee),
    ['Amy', 'Zack', null],
  );
});

test('buildStandupDigestReport combines an assignee\'s issues across different boards/sprints into one entry', () => {
  const report = buildStandupDigestReport(
    ['35', '40'],
    [
      boardSprint({ boardId: '35', sprint: sprint({ id: 1, name: 'Board 35 Sprint' }), issues: [issue({ key: 'PROJ-1', assignee: 'Amy' })] }),
      boardSprint({ boardId: '40', sprint: sprint({ id: 2, name: 'Board 40 Sprint' }), issues: [issue({ key: 'PROJ-2', assignee: 'Amy' })] }),
    ],
    'customfield_10016',
    noDelivery(),
  );
  assert.equal(report.assignees.length, 1);
  const amy = report.assignees[0];
  assert.equal(amy.totalIssueCount, 2);
  const boardIdsSeen = amy.inProgress.map((e) => e.boardId).sort();
  assert.deepEqual(boardIdsSeen, ['35', '40']);
});

test('buildStandupDigestReport issue entries never carry assigneeEmail - stays a pure, delivery-free mapper', () => {
  const report = buildStandupDigestReport(
    ['35'],
    [boardSprint({ issues: [issue({ key: 'PROJ-1', assigneeEmail: 'jane@example.com' })] })],
    'customfield_10016',
    noDelivery(),
  );
  const jane = report.assignees[0];
  const allEntries = [...jane.notStarted, ...jane.inProgress, ...jane.doneThisSprint, ...jane.unknownStatus];
  for (const entry of allEntries) {
    assert.equal((entry as any).assigneeEmail, undefined);
  }
});

test('buildStandupDigestReport sorts each bucket\'s issues by key for stable output', () => {
  const report = buildStandupDigestReport(
    ['35'],
    [
      boardSprint({
        issues: [
          issue({ key: 'PROJ-9', statusCategory: 'new' }),
          issue({ key: 'PROJ-2', statusCategory: 'new' }),
          issue({ key: 'PROJ-5', statusCategory: 'new' }),
        ],
      }),
    ],
    'customfield_10016',
    noDelivery(),
  );
  assert.deepEqual(
    report.assignees[0].notStarted.map((e) => e.key),
    ['PROJ-2', 'PROJ-5', 'PROJ-9'],
  );
});

// --- planStandupDigestDelivery ---

test('planStandupDigestDelivery returns skipped-unassigned for a null assignee regardless of config or email', () => {
  const result = planStandupDigestDelivery(null, { dm: true, channel: null }, 'someone@example.com');
  assert.equal(result?.outcome, 'skipped-unassigned');
});

test('planStandupDigestDelivery returns skipped-not-configured when dm is false and no channel is set', () => {
  const result = planStandupDigestDelivery('Amy', { dm: false, channel: null }, 'amy@example.com');
  assert.equal(result?.outcome, 'skipped-not-configured');
});

test('planStandupDigestDelivery returns skipped-not-configured (not channel delivery) when dm is false but a channel is configured', () => {
  // Channel-mode delivery is not implemented yet - dm:false always wins, even with a channel set.
  const result = planStandupDigestDelivery('Amy', { dm: false, channel: 'team-standup' }, 'amy@example.com');
  assert.equal(result?.outcome, 'skipped-not-configured');
  assert.match(result?.detail ?? '', /channel/i);
});

test('planStandupDigestDelivery returns skipped-no-email when dm is true but no email is available', () => {
  const result = planStandupDigestDelivery('Amy', { dm: true, channel: null }, undefined);
  assert.equal(result?.outcome, 'skipped-no-email');
});

test('planStandupDigestDelivery returns null (eligible for a real attempt) when dm is true and an email is available', () => {
  const result = planStandupDigestDelivery('Amy', { dm: true, channel: null }, 'amy@example.com');
  assert.equal(result, null);
});

// --- buildAssigneeEmailMap ---

test('buildAssigneeEmailMap returns an empty map when there are no issues', () => {
  const emails = buildAssigneeEmailMap([]);
  assert.equal(emails.size, 0);
});

test('buildAssigneeEmailMap maps each assignee to their email', () => {
  const emails = buildAssigneeEmailMap([
    boardSprint({
      issues: [
        issue({ key: 'PROJ-1', assignee: 'Amy', assigneeEmail: 'amy@example.com' }),
        issue({ key: 'PROJ-2', assignee: 'Zack', assigneeEmail: 'zack@example.com' }),
      ],
    }),
  ]);
  assert.equal(emails.get('Amy'), 'amy@example.com');
  assert.equal(emails.get('Zack'), 'zack@example.com');
});

test('buildAssigneeEmailMap skips issues with an assignee but no email, and issues with no assignee', () => {
  const emails = buildAssigneeEmailMap([
    boardSprint({
      issues: [
        issue({ key: 'PROJ-1', assignee: 'Amy', assigneeEmail: undefined }),
        issue({ key: 'PROJ-2', assignee: null, assigneeEmail: undefined }),
      ],
    }),
  ]);
  assert.equal(emails.size, 0);
});

test('buildAssigneeEmailMap keeps the first email found for an assignee across multiple issues', () => {
  const emails = buildAssigneeEmailMap([
    boardSprint({
      issues: [
        issue({ key: 'PROJ-1', assignee: 'Amy', assigneeEmail: 'amy-first@example.com' }),
        issue({ key: 'PROJ-2', assignee: 'Amy', assigneeEmail: 'amy-second@example.com' }),
      ],
    }),
  ]);
  assert.equal(emails.get('Amy'), 'amy-first@example.com');
});

test('buildAssigneeEmailMap fills in an assignee\'s email from a later issue if an earlier one lacked it', () => {
  const emails = buildAssigneeEmailMap([
    boardSprint({
      issues: [
        issue({ key: 'PROJ-1', assignee: 'Amy', assigneeEmail: undefined }),
        issue({ key: 'PROJ-2', assignee: 'Amy', assigneeEmail: 'amy@example.com' }),
      ],
    }),
  ]);
  assert.equal(emails.get('Amy'), 'amy@example.com');
});

// --- buildStandupDigestSlackMessage ---

function assigneeSummary(overrides: Partial<StandupDigestAssigneeSummary> = {}): StandupDigestAssigneeSummary {
  return {
    assignee: 'Amy',
    notStarted: [],
    inProgress: [],
    doneThisSprint: [],
    unknownStatus: [],
    totalIssueCount: 0,
    totalStoryPoints: 0,
    unestimatedIssueCount: 0,
    ...overrides,
  };
}

test('buildStandupDigestSlackMessage includes the assignee name and produces non-empty text and blocks', () => {
  const message = buildStandupDigestSlackMessage(assigneeSummary({ assignee: 'Amy' }));
  assert.match(message.text, /Amy/);
  assert.ok(message.blocks.length > 0);
});

test('buildStandupDigestSlackMessage labels a null assignee as "Unassigned"', () => {
  const message = buildStandupDigestSlackMessage(assigneeSummary({ assignee: null }));
  assert.match(message.text, /Unassigned/);
});

test('buildStandupDigestSlackMessage reflects bucket counts and story points in the text', () => {
  const message = buildStandupDigestSlackMessage(
    assigneeSummary({
      notStarted: [{ key: 'PROJ-1', summary: 'A', status: 'To Do', boardId: '1', sprintName: 'S1', storyPoints: 2 }],
      inProgress: [],
      doneThisSprint: [],
      totalStoryPoints: 2,
      unestimatedIssueCount: 0,
    }),
  );
  assert.match(message.text, /Not started:\* 1/);
  assert.match(message.text, /Story points:\* 2/);
  assert.match(message.text, /PROJ-1/);
});

test('buildStandupDigestSlackMessage renders "none" for an empty bucket rather than omitting it', () => {
  const message = buildStandupDigestSlackMessage(assigneeSummary());
  assert.match(message.text, /In progress:\* none/);
  assert.match(message.text, /Not started:\* none/);
  assert.match(message.text, /Done this sprint:\* none/);
});
