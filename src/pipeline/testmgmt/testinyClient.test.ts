import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toTestinyStepsText, toTestinyResultStatus } from './testinyClient';

test('toTestinyStepsText: numbers each step, one per line', () => {
  const text = toTestinyStepsText(['open the page', 'click login', 'submit the form']);
  assert.equal(text, '1. open the page\n2. click login\n3. submit the form');
});

test('toTestinyStepsText: a single-step scenario still numbers it', () => {
  const text = toTestinyStepsText(['open the page']);
  assert.equal(text, '1. open the page');
});

test('toTestinyStepsText: empty steps array returns empty string', () => {
  assert.equal(toTestinyStepsText([]), '');
});

test('toTestinyResultStatus: maps every canonical TmsResultStatus to its Testiny uppercase equivalent', () => {
  assert.equal(toTestinyResultStatus('passed'), 'PASSED');
  assert.equal(toTestinyResultStatus('failed'), 'FAILED');
  assert.equal(toTestinyResultStatus('blocked'), 'BLOCKED');
  assert.equal(toTestinyResultStatus('skipped'), 'SKIPPED');
});

test('toTestinyResultStatus: throws on an unrecognized status rather than silently defaulting', () => {
  assert.throws(() => toTestinyResultStatus('invalid'), /Unknown TmsResultStatus "invalid"/);
});
