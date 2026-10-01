import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildGroomCheckFetchReport, buildGroomCheckComment, GroomCheckTicket } from './groomCheck';

function ticket(overrides: Partial<GroomCheckTicket> = {}): GroomCheckTicket {
  return {
    key: 'SCRUM-6',
    summary: 'View Practice Papers & Start Selected Paper',
    description: 'As a student, I want to view practice papers so that I can start one.',
    issueType: 'Task',
    status: 'To Do',
    boardId: '1',
    sprintName: 'SCRUM Sprint 0',
    ...overrides,
  };
}

const NOW = new Date('2026-08-22T00:00:00.000Z');

// --- buildGroomCheckFetchReport ---

test('buildGroomCheckFetchReport stamps generatedAt and echoes boardIds/ticketCount', () => {
  const report = buildGroomCheckFetchReport(['1'], [ticket()], NOW);
  assert.equal(report.generatedAt, NOW.toISOString());
  assert.deepEqual(report.boardIds, ['1']);
  assert.equal(report.ticketCount, 1);
});

test('buildGroomCheckFetchReport returns an empty ticket list untouched', () => {
  const report = buildGroomCheckFetchReport(['1'], [], NOW);
  assert.equal(report.ticketCount, 0);
  assert.deepEqual(report.tickets, []);
});

test('buildGroomCheckFetchReport sorts tickets by key', () => {
  const report = buildGroomCheckFetchReport(
    ['1'],
    [ticket({ key: 'SCRUM-9' }), ticket({ key: 'SCRUM-2' }), ticket({ key: 'SCRUM-10' })],
    NOW,
  );
  assert.deepEqual(
    report.tickets.map((t) => t.key),
    ['SCRUM-10', 'SCRUM-2', 'SCRUM-9'],
  );
});

test('buildGroomCheckFetchReport carries every ticket field through untouched (issueType, status, description)', () => {
  const report = buildGroomCheckFetchReport(
    ['1'],
    [ticket({ issueType: 'Bug', status: 'In Progress', description: 'full description text' })],
    NOW,
  );
  assert.equal(report.tickets[0].issueType, 'Bug');
  assert.equal(report.tickets[0].status, 'In Progress');
  assert.equal(report.tickets[0].description, 'full description text');
});

test('buildGroomCheckFetchReport is a pure mapper - never invents an issueType/QA-vs-dev label', () => {
  const report = buildGroomCheckFetchReport(['1'], [ticket()], NOW);
  const keys = Object.keys(report.tickets[0]);
  assert.ok(!keys.includes('ticketLane'));
  assert.ok(!keys.includes('qaOrDev'));
});

// --- buildGroomCheckComment ---

test('buildGroomCheckComment lists every gap as its own bullet', () => {
  const comment = buildGroomCheckComment(['No acceptance criteria', 'Unclear expected result']);
  assert.match(comment, /- No acceptance criteria/);
  assert.match(comment, /- Unclear expected result/);
});

test('buildGroomCheckComment frames the finding as a backlog grooming pass', () => {
  const comment = buildGroomCheckComment(['gap one']);
  assert.match(comment, /backlog grooming pass/i);
});

test('buildGroomCheckComment notes this is informational, not a blocking gate', () => {
  const comment = buildGroomCheckComment(['gap one']);
  assert.match(comment, /not a blocking gate/i);
});

test('buildGroomCheckComment does not include an override-command line (unlike Gate 0s comment - there is no gate here)', () => {
  const comment = buildGroomCheckComment(['gap one']);
  assert.doesNotMatch(comment, /approve-requirements/);
  assert.doesNotMatch(comment, /approve-/);
});
