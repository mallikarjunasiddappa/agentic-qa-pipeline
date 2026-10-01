import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JiraAdapter } from './jiraAdapter';
import type { JiraClient, JiraIssueRaw } from '../jira/jiraClient';
import type { BugReport, JiraIssueSummary } from '../types/schemas';

/**
 * Minimal stand-in for JiraClient that records every call it receives, so these tests can assert
 * on exactly what JiraAdapter passes through - same pattern as testmgmt/qaseAdapter.test.ts's
 * FakeQaseClient. In particular, this checks that getRequirement() correctly collapses
 * JiraClient's two-call getIssue()+extractDescription() sequence into one RequirementSummary.
 */
class FakeJiraClient {
  calls: Record<string, unknown[]> = {};

  private record(name: string, args: unknown[]): void {
    this.calls[name] = args;
  }

  async getIssue(key: string): Promise<JiraIssueRaw> {
    this.record('getIssue', [key]);
    return { key, fields: { summary: 'Some summary', description: null } };
  }

  extractDescription(issue: JiraIssueRaw): JiraIssueSummary {
    this.record('extractDescription', [issue]);
    return { key: issue.key, summary: issue.fields.summary, description: 'flattened description text' };
  }

  async createBug(bug: BugReport): Promise<{ key: string; url: string }> {
    this.record('createBug', [bug]);
    return { key: 'BUG-1', url: 'https://example.atlassian.net/browse/BUG-1' };
  }

  async addComment(key: string, text: string): Promise<void> {
    this.record('addComment', [key, text]);
  }

  async getTransitions(key: string): Promise<{ id: string; name: string }[]> {
    this.record('getTransitions', [key]);
    return [{ id: '31', name: 'Done' }];
  }

  async transitionIssue(key: string, transitionId: string): Promise<void> {
    this.record('transitionIssue', [key, transitionId]);
  }
}

test('JiraAdapter.getRequirement collapses getIssue+extractDescription into one RequirementSummary', async () => {
  const fake = new FakeJiraClient();
  const adapter = new JiraAdapter(fake as unknown as JiraClient);

  const result = await adapter.getRequirement('SCRUM-18');

  assert.deepEqual(fake.calls.getIssue, ['SCRUM-18']);
  assert.ok(fake.calls.extractDescription);
  assert.deepEqual(result, {
    key: 'SCRUM-18',
    summary: 'Some summary',
    description: 'flattened description text',
  });
});

test('JiraAdapter.createBug passes through to JiraClient.createBug unchanged', async () => {
  const fake = new FakeJiraClient();
  const adapter = new JiraAdapter(fake as unknown as JiraClient);
  const bug = { summary: 'Bug summary', description: 'Bug description', labels: ['auto-filed'] };

  const result = await adapter.createBug(bug);

  assert.deepEqual(fake.calls.createBug, [bug]);
  assert.deepEqual(result, { key: 'BUG-1', url: 'https://example.atlassian.net/browse/BUG-1' });
});

test('JiraAdapter.addComment passes through key and text unchanged', async () => {
  const fake = new FakeJiraClient();
  const adapter = new JiraAdapter(fake as unknown as JiraClient);

  await adapter.addComment('SCRUM-18', 'a comment');

  assert.deepEqual(fake.calls.addComment, ['SCRUM-18', 'a comment']);
});

test('JiraAdapter.getTransitions passes through JiraClient.getTransitions result unchanged', async () => {
  const fake = new FakeJiraClient();
  const adapter = new JiraAdapter(fake as unknown as JiraClient);

  const result = await adapter.getTransitions('SCRUM-18');

  assert.deepEqual(fake.calls.getTransitions, ['SCRUM-18']);
  assert.deepEqual(result, [{ id: '31', name: 'Done' }]);
});

test('JiraAdapter.transitionRequirement maps onto JiraClient.transitionIssue', async () => {
  const fake = new FakeJiraClient();
  const adapter = new JiraAdapter(fake as unknown as JiraClient);

  await adapter.transitionRequirement('SCRUM-18', '31');

  assert.deepEqual(fake.calls.transitionIssue, ['SCRUM-18', '31']);
});
