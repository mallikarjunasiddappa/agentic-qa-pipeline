import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapSprint, mapSprintIssue, AgileSprintRaw, AgileIssueRaw } from './agileClient';

function sprint(overrides: Partial<AgileSprintRaw> = {}): AgileSprintRaw {
  return {
    id: 42,
    name: 'Sprint 12',
    state: 'active',
    startDate: '2026-08-01T00:00:00.000Z',
    endDate: '2026-08-14T00:00:00.000Z',
    ...overrides,
  };
}

function issue(overrides: Partial<AgileIssueRaw> = {}): AgileIssueRaw {
  return {
    key: 'PROJ-101',
    fields: {
      summary: 'Fix the widget',
      status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
      assignee: { displayName: 'Jane Doe', emailAddress: 'jane@example.com' },
      updated: '2026-08-10T00:00:00.000Z',
      customfield_10016: 5,
    },
    ...overrides,
  };
}

test('mapSprint carries every field through unchanged', () => {
  const result = mapSprint(sprint());
  assert.deepEqual(result, {
    id: 42,
    name: 'Sprint 12',
    state: 'active',
    startDate: '2026-08-01T00:00:00.000Z',
    endDate: '2026-08-14T00:00:00.000Z',
  });
});

test('mapSprint tolerates a closed sprint with no start/end dates', () => {
  const result = mapSprint(sprint({ state: 'closed', startDate: undefined, endDate: undefined }));
  assert.equal(result.state, 'closed');
  assert.equal(result.startDate, undefined);
  assert.equal(result.endDate, undefined);
});

test('mapSprintIssue maps a fully-populated issue', () => {
  const result = mapSprintIssue(issue(), 'customfield_10016');
  assert.deepEqual(result, {
    key: 'PROJ-101',
    summary: 'Fix the widget',
    status: 'In Progress',
    statusCategory: 'indeterminate',
    assignee: 'Jane Doe',
    assigneeEmail: 'jane@example.com',
    storyPoints: 5,
    updated: '2026-08-10T00:00:00.000Z',
  });
});

test('mapSprintIssue statusCategory: "new" and "done" pass through as-is', () => {
  assert.equal(
    mapSprintIssue(
      issue({ fields: { ...issue().fields, status: { name: 'To Do', statusCategory: { key: 'new' } } } }),
      'customfield_10016',
    ).statusCategory,
    'new',
  );
  assert.equal(
    mapSprintIssue(
      issue({ fields: { ...issue().fields, status: { name: 'Done', statusCategory: { key: 'done' } } } }),
      'customfield_10016',
    ).statusCategory,
    'done',
  );
});

test('mapSprintIssue statusCategory falls back to "unknown" when Jira omits statusCategory', () => {
  const result = mapSprintIssue(
    issue({ fields: { ...issue().fields, status: { name: 'Custom Status' } } }),
    'customfield_10016',
  );
  assert.equal(result.statusCategory, 'unknown');
});

test('mapSprintIssue statusCategory falls back to "unknown" for an unrecognized category key', () => {
  const result = mapSprintIssue(
    issue({ fields: { ...issue().fields, status: { name: 'Blocked', statusCategory: { key: 'blocked' } } } }),
    'customfield_10016',
  );
  assert.equal(result.statusCategory, 'unknown');
});

test('mapSprintIssue assignee is null when the issue is unassigned', () => {
  const result = mapSprintIssue(issue({ fields: { ...issue().fields, assignee: null } }), 'customfield_10016');
  assert.equal(result.assignee, null);
  assert.equal(result.assigneeEmail, undefined);
});

test('mapSprintIssue assigneeEmail is absent (not thrown) when Jira omits it for a real assignee', () => {
  const result = mapSprintIssue(
    issue({ fields: { ...issue().fields, assignee: { displayName: 'Jane Doe' } } }),
    'customfield_10016',
  );
  assert.equal(result.assignee, 'Jane Doe');
  assert.equal(result.assigneeEmail, undefined);
});

test('mapSprintIssue storyPoints is null (not 0) when the field is missing', () => {
  const { customfield_10016, ...fieldsWithoutPoints } = issue().fields;
  const result = mapSprintIssue({ key: 'PROJ-102', fields: fieldsWithoutPoints }, 'customfield_10016');
  assert.equal(result.storyPoints, null);
});

test('mapSprintIssue storyPoints preserves a genuine zero', () => {
  const result = mapSprintIssue(
    issue({ fields: { ...issue().fields, customfield_10016: 0 } }),
    'customfield_10016',
  );
  assert.equal(result.storyPoints, 0);
});

test('mapSprintIssue storyPoints is null when the field holds a non-numeric value', () => {
  const result = mapSprintIssue(
    issue({ fields: { ...issue().fields, customfield_10016: 'unestimated' } }),
    'customfield_10016',
  );
  assert.equal(result.storyPoints, null);
});

test('mapSprintIssue reads storyPoints from whichever custom field id is passed in', () => {
  const result = mapSprintIssue(
    issue({
      fields: {
        summary: 'Different field id',
        status: { name: 'To Do', statusCategory: { key: 'new' } },
        assignee: null,
        updated: '2026-08-10T00:00:00.000Z',
        customfield_99999: 3,
      },
    }),
    'customfield_99999',
  );
  assert.equal(result.storyPoints, 3);
});
