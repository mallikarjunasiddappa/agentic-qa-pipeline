import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideFlaky } from './evaluateFlakiness';

test('decideFlaky is false when every result is "fail"', () => {
  assert.equal(decideFlaky(['fail', 'fail', 'fail']), false);
});

test('decideFlaky is false when every result is "pass"', () => {
  assert.equal(decideFlaky(['pass', 'pass', 'pass']), false);
});

test('decideFlaky is true when results differ', () => {
  assert.equal(decideFlaky(['fail', 'pass', 'fail']), true);
});

test('decideFlaky is true for a single differing result among many', () => {
  assert.equal(decideFlaky(['fail', 'fail', 'pass']), true);
});

test('decideFlaky is false for a single-element array', () => {
  assert.equal(decideFlaky(['fail']), false);
});

test('decideFlaky throws on an empty array - there is nothing to compare', () => {
  assert.throws(() => decideFlaky([]));
});
