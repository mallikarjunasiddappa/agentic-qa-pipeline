import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildBlockerEscalationEmail } from './emailClient';
import { BlockerScanFlaggedIssue } from '../scrum/stages/blockerScan';

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

// --- buildBlockerEscalationEmail ---

test('buildBlockerEscalationEmail includes the ticket key and idle days in the subject', () => {
  const message = buildBlockerEscalationEmail(flaggedIssue(), 3);
  assert.match(message.subject, /PROJ-1/);
  assert.match(message.subject, /idle for 10 day\(s\)/);
});

test('buildBlockerEscalationEmail body includes summary, status, and assignee', () => {
  const message = buildBlockerEscalationEmail(flaggedIssue(), 3);
  assert.match(message.text, /Summary: Do the thing/);
  assert.match(message.text, /Status: In Progress/);
  assert.match(message.text, /Assignee: Jane Doe/);
});

test('buildBlockerEscalationEmail labels a null assignee as Unassigned', () => {
  const message = buildBlockerEscalationEmail(flaggedIssue({ assignee: null }), 3);
  assert.match(message.text, /Assignee: Unassigned/);
});

test('buildBlockerEscalationEmail includes the configured idle threshold', () => {
  const message = buildBlockerEscalationEmail(flaggedIssue(), 7);
  assert.match(message.text, /7-day idle threshold/);
});

test('buildBlockerEscalationEmail notes this is a report only, nothing changed', () => {
  const message = buildBlockerEscalationEmail(flaggedIssue(), 3);
  assert.match(message.text, /report only/i);
});
