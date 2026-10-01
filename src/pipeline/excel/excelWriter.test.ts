import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignDisplayIds, buildScenarioFileName } from './excelWriter';
import { Scenario } from '../types/schemas';

function scenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    id: 'should-do-a-thing',
    title: 'Widget: Should Do A Thing',
    preconditions: 'Some concrete starting state',
    steps: ['Click the Save button'],
    expectedResult: 'a confirmation toast appears',
    priority: 'medium',
    ...overrides,
  };
}

test('buildScenarioFileName: combines the Jira key and the spec feature slug', () => {
  const name = buildScenarioFileName('KAN-1', 'specs/profile-subscriptions.plan.md');
  assert.equal(name, 'kan-1-profile-subscriptions-scenarios.xlsx');
});

test('buildScenarioFileName: works with a nested spec path', () => {
  const name = buildScenarioFileName('PROJ-42', 'specs/nested/checkout-flow.plan.md');
  assert.equal(name, 'proj-42-checkout-flow-scenarios.xlsx');
});

test('buildScenarioFileName: two different tickets never collide on the same generic name', () => {
  const a = buildScenarioFileName('KAN-1', 'specs/profile-subscriptions.plan.md');
  const b = buildScenarioFileName('KAN-2', 'specs/checkout.plan.md');
  assert.notEqual(a, b);
});

test('buildScenarioFileName: same ticket + same spec produces the same, stable name', () => {
  const a = buildScenarioFileName('KAN-1', 'specs/profile-subscriptions.plan.md');
  const b = buildScenarioFileName('KAN-1', 'specs/profile-subscriptions.plan.md');
  assert.equal(a, b);
});

test('buildScenarioFileName: sanitizes characters that are not filename-safe', () => {
  const name = buildScenarioFileName('KAN 1!', 'specs/weird name!!.plan.md');
  assert.match(name, /^[a-z0-9-]+\.xlsx$/);
});

test('buildScenarioFileName: falls back gracefully when the spec basename has no feature slug left', () => {
  const name = buildScenarioFileName('KAN-1', 'specs/.plan.md');
  assert.equal(name, 'kan-1-scenarios.xlsx');
});

test('assignDisplayIds: assigns sequential, zero-padded, ticket-prefixed ids in order', () => {
  const result = assignDisplayIds('KAN-3', [
    scenario({ id: 'a' }),
    scenario({ id: 'b' }),
    scenario({ id: 'c' }),
  ]);
  assert.deepEqual(
    result.map((s) => s.displayId),
    ['KAN3-01', 'KAN3-02', 'KAN3-03'],
  );
});

test('assignDisplayIds: strips hyphens from the Jira key and upper-cases it for the prefix', () => {
  const result = assignDisplayIds('kan-3', [scenario()]);
  assert.equal(result[0].displayId, 'KAN3-01');
});

test('assignDisplayIds: leaves every other scenario field untouched', () => {
  const original = scenario({ id: 'should-do-a-thing', title: 'Widget: Should Do A Thing' });
  const [result] = assignDisplayIds('KAN-3', [original]);
  assert.equal(result.id, 'should-do-a-thing');
  assert.equal(result.title, 'Widget: Should Do A Thing');
});

test('assignDisplayIds: pads past 9 scenarios to 2 digits without breaking beyond 99', () => {
  const scenarios = Array.from({ length: 11 }, (_, i) => scenario({ id: `s${i}` }));
  const result = assignDisplayIds('KAN-3', scenarios);
  assert.equal(result[8].displayId, 'KAN3-09');
  assert.equal(result[9].displayId, 'KAN3-10');
  assert.equal(result[10].displayId, 'KAN3-11');
});
