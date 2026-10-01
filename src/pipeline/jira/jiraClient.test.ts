import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyJiraFailure, JiraApiError } from './jiraClient';

describe('classifyJiraFailure', () => {
  it('null status = network/egress, never-reached, and points at the sandbox hand-off', () => {
    const { kind, message } = classifyJiraFailure({
      status: null,
      code: 'ECONNREFUSED',
      method: 'get',
      url: '/issue/SCRUM-73',
    });
    assert.equal(kind, 'network');
    assert.match(message, /network\/egress/);
    assert.match(message, /ECONNREFUSED/);
    assert.match(message, /AGENTS\.md/);
    // must not claim it reached Jira
    assert.doesNotMatch(message, /REACHED Jira/);
  });

  it('404 = not-found, explicitly NOT egress, names the Browse-permission cause', () => {
    const { kind, message } = classifyJiraFailure({
      status: 404,
      jiraMessages: ['Issue does not exist or you do not have permission to see it.'],
      method: 'get',
      url: '/issue/SCRUM-73',
    });
    assert.equal(kind, 'not-found');
    assert.match(message, /NOT a network or egress problem/);
    assert.match(message, /Browse permission/);
    assert.match(message, /GET \/issue\/SCRUM-73/);
    assert.match(message, /Jira said: Issue does not exist/);
  });

  it('401 = auth, flags the JIRA_EMAIL/JIRA_API_TOKEN pairing', () => {
    const { kind, message } = classifyJiraFailure({ status: 401, method: 'get', url: '/issue/X' });
    assert.equal(kind, 'auth');
    assert.match(message, /JIRA_EMAIL and JIRA_API_TOKEN/);
    assert.match(message, /NOT a network or egress problem/);
  });

  it('403 = permission', () => {
    const { kind, message } = classifyJiraFailure({ status: 403, method: 'post', url: '/issue/X/comment' });
    assert.equal(kind, 'permission');
    assert.match(message, /denied access \(403\)/);
    assert.match(message, /POST \/issue\/X\/comment/);
  });

  it('5xx = server/transient, not credential or egress', () => {
    const { kind, message } = classifyJiraFailure({ status: 503, method: 'get', url: '/issue/X' });
    assert.equal(kind, 'server');
    assert.match(message, /server error \(503\)/);
    assert.match(message, /retry shortly/);
  });

  it('other 4xx falls back to a generic reached-Jira message', () => {
    const { kind, message } = classifyJiraFailure({ status: 429, method: 'get', url: '/search' });
    assert.equal(kind, 'http');
    assert.match(message, /Jira returned 429/);
    assert.match(message, /NOT a network or egress problem/);
  });

  it('omits the "Jira said" clause when there are no errorMessages', () => {
    const { message } = classifyJiraFailure({ status: 404, method: 'get', url: '/issue/X' });
    assert.doesNotMatch(message, /Jira said:/);
  });
});

describe('JiraApiError', () => {
  it('reachedJira reflects whether a status came back, and cause is preserved', () => {
    const cause = new Error('raw axios');
    const reached = new JiraApiError({ kind: 'not-found', status: 404, method: 'GET', url: '/issue/X', message: 'm', cause });
    assert.equal(reached.reachedJira, true);
    assert.equal(reached.status, 404);
    assert.equal(reached.name, 'JiraApiError');
    assert.equal((reached as { cause?: unknown }).cause, cause);

    const never = new JiraApiError({ kind: 'network', status: null, method: 'GET', url: '/issue/X', message: 'm' });
    assert.equal(never.reachedJira, false);
    assert.equal(never.status, null);
  });
});
