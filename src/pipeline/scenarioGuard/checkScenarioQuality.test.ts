import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runScenarioQualityCheck, buildReport } from './checkScenarioQuality';
import { Scenario } from '../types/schemas';

function scenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    id: 'should-do-a-thing',
    title: 'Widget: Should Do A Thing',
    preconditions: 'User is logged in with an active Pro subscription',
    steps: ['Click the Save button'],
    expectedResult: 'a confirmation toast appears with the text "Saved"',
    priority: 'medium',
    ...overrides,
  };
}

test('runScenarioQualityCheck: a clean scenario has no findings (other than batch-level checks that need >1 scenario)', () => {
  const result = runScenarioQualityCheck([scenario()]);
  assert.equal(result.blockingCount, 0);
  assert.equal(result.warningCount, 0);
});

test('id-format: flags an empty id', () => {
  const result = runScenarioQualityCheck([scenario({ id: '' })]);
  assert.ok(result.findings.some((f) => f.rule === 'id-format'));
});

test('id-format: flags an id containing spaces', () => {
  const result = runScenarioQualityCheck([scenario({ id: 'not a valid id' })]);
  assert.ok(result.findings.some((f) => f.rule === 'id-format'));
});

test('id-uniqueness: flags two scenarios sharing the same id', () => {
  const result = runScenarioQualityCheck([
    scenario({ id: 'dup', title: 'A: One' }),
    scenario({ id: 'dup', title: 'B: Two' }),
  ]);
  assert.ok(result.findings.some((f) => f.rule === 'id-uniqueness'));
});

test('title-quality: flags an empty title', () => {
  const result = runScenarioQualityCheck([scenario({ title: '' })]);
  assert.ok(result.findings.some((f) => f.rule === 'title-quality'));
});

test('title-quality: flags a title that repeats words between its category prefix and the rest', () => {
  const result = runScenarioQualityCheck([
    scenario({ title: 'Student Login: Should Log In Successfully' }),
  ]);
  assert.ok(result.findings.some((f) => f.rule === 'title-quality'));
});

test('title-quality: does not flag a title with a distinct, non-redundant category and description', () => {
  const result = runScenarioQualityCheck([
    scenario({ title: 'Checkout: Applies a valid promo code to the order total' }),
  ]);
  assert.ok(!result.findings.some((f) => f.rule === 'title-quality'));
});

test('title-uniqueness: flags two scenarios sharing the same title', () => {
  const result = runScenarioQualityCheck([
    scenario({ id: 'a', title: 'Same Title' }),
    scenario({ id: 'b', title: 'Same Title' }),
  ]);
  assert.ok(result.findings.some((f) => f.rule === 'title-uniqueness'));
});

test('precondition-quality: flags an empty precondition', () => {
  const result = runScenarioQualityCheck([scenario({ preconditions: '' })]);
  assert.ok(result.findings.some((f) => f.rule === 'precondition-quality'));
});

test('precondition-quality: flags a too-short/vague precondition', () => {
  const result = runScenarioQualityCheck([scenario({ preconditions: 'Logged in' })]);
  assert.ok(result.findings.some((f) => f.rule === 'precondition-quality'));
});

test('precondition-quality: flags identical preconditions copy-pasted across every scenario', () => {
  const result = runScenarioQualityCheck([
    scenario({ id: 'a', title: 'A: One', preconditions: 'User logged into the web portal' }),
    scenario({ id: 'b', title: 'B: Two', preconditions: 'User logged into the web portal' }),
    scenario({ id: 'c', title: 'C: Three', preconditions: 'User logged into the web portal' }),
  ]);
  assert.ok(
    result.findings.some((f) => f.rule === 'precondition-quality' && f.scenarioId === null),
  );
});

test('step-granularity: flags a step combining multiple actions', () => {
  const result = runScenarioQualityCheck([
    scenario({
      steps: [
        'Enter the username, enter the password, solve the CAPTCHA if shown, and submit the login form',
      ],
    }),
  ]);
  assert.ok(result.findings.some((f) => f.rule === 'step-granularity'));
});

test('step-granularity: flags a single-step scenario with many expected-result clauses', () => {
  const result = runScenarioQualityCheck([
    scenario({
      steps: ['Navigate to My Subscriptions'],
      expectedResult: 'table is visible; row count matches total; every row shows Paid status',
    }),
  ]);
  assert.ok(
    result.findings.some(
      (f) => f.rule === 'step-granularity' && f.message.includes('compressed into a single step'),
    ),
  );
});

test('expected-result: flags a missing expected result', () => {
  const result = runScenarioQualityCheck([scenario({ expectedResult: '' })]);
  assert.ok(result.findings.some((f) => f.rule === 'expected-result'));
});

test('expected-result: flags too many semicolon-chained clauses', () => {
  const result = runScenarioQualityCheck([
    scenario({ expectedResult: 'a happens; b happens; c happens; d happens' }),
  ]);
  assert.ok(result.findings.some((f) => f.rule === 'expected-result'));
});

test('priority-variance: flags every scenario in a batch sharing the same priority', () => {
  const result = runScenarioQualityCheck([
    scenario({ id: 'a', title: 'A: One', priority: 'medium' }),
    scenario({ id: 'b', title: 'B: Two', priority: 'medium' }),
  ]);
  assert.ok(result.findings.some((f) => f.rule === 'priority-variance'));
});

test('priority-variance: does not flag a batch with mixed priorities', () => {
  const result = runScenarioQualityCheck([
    scenario({ id: 'a', title: 'A: One', priority: 'critical' }),
    scenario({ id: 'b', title: 'B: Two', priority: 'low' }),
  ]);
  assert.ok(!result.findings.some((f) => f.rule === 'priority-variance'));
});

test('observability: flags vague, unobservable expected-result language', () => {
  const result = runScenarioQualityCheck([scenario({ expectedResult: 'the page works correctly' })]);
  assert.ok(result.findings.some((f) => f.rule === 'observability'));
});

test('no-implementation-details: flags a data-test-id reference in tester-facing text', () => {
  const result = runScenarioQualityCheck([
    scenario({ steps: ['Click the element with data-test-id="save-btn"'] }),
  ]);
  assert.ok(result.findings.some((f) => f.rule === 'no-implementation-details'));
});

test('no-implementation-details: does not flag the Precondition field for a seed-file reference (sanctioned pipeline metadata)', () => {
  const result = runScenarioQualityCheck([
    scenario({ preconditions: 'Seed: should-match-subscriptions-between-my-subscriptions.spec.ts' }),
  ]);
  assert.ok(!result.findings.some((f) => f.rule === 'no-implementation-details'));
});

test('no-implementation-details: still flags a source-code file reference outside the Precondition field', () => {
  const result = runScenarioQualityCheck([
    scenario({ steps: ['Open src/ui/pages/DashboardPage.ts and click Save'] }),
  ]);
  assert.ok(result.findings.some((f) => f.rule === 'no-implementation-details'));
});

test('traceability-to-ticket: flags a scenario with zero keyword overlap with the ticket text', () => {
  const result = runScenarioQualityCheck(
    [
      scenario({
        title: 'Weather Widget: Displays forecast',
        steps: ['Open the weather panel'],
        expectedResult: 'the forecast temperature is shown',
      }),
    ],
    'As a student I want to renew my subscription so my access does not lapse',
  );
  assert.ok(result.findings.some((f) => f.rule === 'traceability-to-ticket'));
});

test('traceability-to-ticket: does not flag a scenario that shares real keywords with the ticket', () => {
  const result = runScenarioQualityCheck(
    [
      scenario({
        title: 'Subscription: Renews an expiring plan',
        steps: ['Click Renew Subscription on the active plan'],
        expectedResult: 'the subscription expiry date is extended by one billing cycle',
      }),
    ],
    'As a student I want to renew my subscription so my access does not lapse',
  );
  assert.ok(!result.findings.some((f) => f.rule === 'traceability-to-ticket'));
});

test('ticket-aware checks are skipped entirely when no ticket text is supplied', () => {
  const result = runScenarioQualityCheck([
    scenario({
      title: 'Weather Widget: Displays forecast',
      steps: ['Open the weather panel'],
      expectedResult: 'the forecast temperature is shown',
    }),
  ]);
  assert.ok(!result.findings.some((f) => f.rule === 'traceability-to-ticket'));
  assert.ok(!result.findings.some((f) => f.rule === 'invented-business-rule'));
});

test('invented-business-rule (warn-only): flags a specific value absent from the ticket text', () => {
  const result = runScenarioQualityCheck(
    [scenario({ expectedResult: 'access is revoked exactly 72 hours after cancellation' })],
    'As a student I want to cancel my subscription',
  );
  const finding = result.findings.find((f) => f.rule === 'invented-business-rule');
  assert.ok(finding);
  assert.equal(finding?.severity, 'warn');
  assert.equal(result.blockingCount, 0);
});

test('duplicate-coverage (warn-only): flags two scenarios with heavily overlapping wording', () => {
  const result = runScenarioQualityCheck([
    scenario({
      id: 'a',
      title: 'Dashboard: Shows active subscription count',
      steps: ['Navigate to the dashboard and check the active subscription count'],
      expectedResult: 'the active subscription count is displayed and greater than zero',
    }),
    scenario({
      id: 'b',
      title: 'Dashboard: Displays active subscription count',
      steps: ['Navigate to the dashboard and check the active subscription count value'],
      expectedResult: 'the active subscription count value is displayed and greater than zero',
    }),
  ]);
  const finding = result.findings.find((f) => f.rule === 'duplicate-coverage');
  assert.ok(finding);
  assert.equal(finding?.severity, 'warn');
});

test('buildReport: blockingCount of 0 reports nothing blocking even with warnings present', () => {
  const result = runScenarioQualityCheck(
    [scenario({ expectedResult: 'access is revoked exactly 72 hours after cancellation' })],
    'As a student I want to cancel my subscription',
  );
  const report = buildReport(result, 1, true);
  assert.match(report, /Nothing blocking/);
});

test('buildReport: notes when ticket text was unavailable', () => {
  const result = runScenarioQualityCheck([scenario()]);
  const report = buildReport(result, 1, false);
  assert.match(report, /ticket text was not available/);
});
