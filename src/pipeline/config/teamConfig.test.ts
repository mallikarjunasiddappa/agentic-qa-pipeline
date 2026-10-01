import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveOperator, allowSlackNotify, allowEmailNotify } from './teamConfig';

test('resolveOperator prefers PIPELINE_OPERATOR over JIRA_EMAIL when both are set', () => {
  assert.equal(resolveOperator('ci-bot', 'dev@example.com'), 'ci-bot');
});

test('resolveOperator falls back to JIRA_EMAIL when PIPELINE_OPERATOR is unset', () => {
  assert.equal(resolveOperator(undefined, 'dev@example.com'), 'dev@example.com');
});

test('resolveOperator treats an empty-string PIPELINE_OPERATOR as unset', () => {
  assert.equal(resolveOperator('', 'dev@example.com'), 'dev@example.com');
});

test('resolveOperator returns undefined when neither is set', () => {
  assert.equal(resolveOperator(undefined, undefined), undefined);
});

test('allowSlackNotify always allows in CI regardless of SLACK_NOTIFY_LOCAL', () => {
  assert.equal(allowSlackNotify(true, undefined), true);
  assert.equal(allowSlackNotify(true, 'false'), true);
});

test('allowSlackNotify blocks local runs by default', () => {
  assert.equal(allowSlackNotify(false, undefined), false);
  assert.equal(allowSlackNotify(false, 'false'), false);
});

test('allowSlackNotify allows local runs when explicitly opted in', () => {
  assert.equal(allowSlackNotify(false, 'true'), true);
});

test('allowEmailNotify always allows in CI regardless of SMTP_NOTIFY_LOCAL', () => {
  assert.equal(allowEmailNotify(true, undefined), true);
  assert.equal(allowEmailNotify(true, 'false'), true);
});

test('allowEmailNotify blocks local runs by default', () => {
  assert.equal(allowEmailNotify(false, undefined), false);
  assert.equal(allowEmailNotify(false, 'false'), false);
});

test('allowEmailNotify allows local runs when explicitly opted in', () => {
  assert.equal(allowEmailNotify(false, 'true'), true);
});
