import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toQaseSteps, aggregateExecutions } from './qaseClient';

test('toQaseSteps: attaches expected_result only to the last step', () => {
  const steps = toQaseSteps(['open the page', 'click login', 'submit the form'], 'user lands on the dashboard');

  assert.equal(steps.length, 3);
  assert.deepEqual(steps[0], { position: 1, action: 'open the page' });
  assert.deepEqual(steps[1], { position: 2, action: 'click login' });
  assert.deepEqual(steps[2], {
    position: 3,
    action: 'submit the form',
    expected_result: 'user lands on the dashboard',
  });
});

test('toQaseSteps: a single-step scenario still gets expected_result on that one step', () => {
  const steps = toQaseSteps(['open the page'], 'the page loads');

  assert.equal(steps.length, 1);
  assert.deepEqual(steps[0], { position: 1, action: 'open the page', expected_result: 'the page loads' });
});

test('toQaseSteps: positions are 1-indexed and sequential regardless of expected_result placement', () => {
  const steps = toQaseSteps(['a', 'b', 'c', 'd'], 'done');

  assert.deepEqual(
    steps.map((s) => s.position),
    [1, 2, 3, 4],
  );
});

test('aggregateExecutions: counts total runs and only "failed" as failures', () => {
  const agg = aggregateExecutions([
    { status: 'passed', end_time: '2026-09-01T10:00:00Z' },
    { status: 'failed', end_time: '2026-09-02T10:00:00Z' },
    { status: 'blocked', end_time: '2026-09-03T10:00:00Z' },
    { status: 'skipped', end_time: '2026-09-04T10:00:00Z' },
  ]);
  assert.equal(agg.totalRuns, 4);
  assert.equal(agg.failedRuns, 1);
  assert.equal(agg.lastRunAt, '2026-09-04T10:00:00Z');
});

test('aggregateExecutions: lastRunAt is the max timestamp regardless of input order', () => {
  const agg = aggregateExecutions([
    { status: 'passed', end_time: '2026-09-10T10:00:00Z' },
    { status: 'passed', end_time: '2026-09-02T10:00:00Z' },
    { status: 'passed', end_time: '2026-09-07T10:00:00Z' },
  ]);
  assert.equal(agg.lastRunAt, '2026-09-10T10:00:00Z');
});

test('aggregateExecutions: a never-run case is zero runs and null lastRunAt', () => {
  const agg = aggregateExecutions([]);
  assert.deepEqual(agg, { totalRuns: 0, failedRuns: 0, lastRunAt: null });
});

test('aggregateExecutions: missing end_time does not crash lastRunAt selection', () => {
  const agg = aggregateExecutions([
    { status: 'failed' },
    { status: 'failed', end_time: '2026-09-05T10:00:00Z' },
    { status: 'passed', end_time: null },
  ]);
  assert.equal(agg.totalRuns, 3);
  assert.equal(agg.failedRuns, 2);
  assert.equal(agg.lastRunAt, '2026-09-05T10:00:00Z');
});
