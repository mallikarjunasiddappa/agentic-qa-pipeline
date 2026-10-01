import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildPlanScenario, toScenarioId, promoteInputFromSession, nextGroupIndex, buildNewSpecFile, PromoteInput } from './promote';
import { parseScenariosFromSpec } from '../specs/specParser';
import { mapVerdicts, parseAcceptanceCriteria } from './acVerification';
import { TicketVerifySession } from './sessionStore';

function writePlan(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promote-test-'));
  const file = path.join(dir, 'feature.plan.md');
  fs.writeFileSync(file, content, 'utf-8');
  return file;
}

test('toScenarioId slugifies free text to a kebab id', () => {
  assert.equal(toScenarioId('SCRUM-76 IELTS Reading/Question'), 'scrum-76-ielts-reading-question');
  assert.equal(toScenarioId('   '), 'scenario');
});

test('buildPlanScenario output parses back through parseScenariosFromSpec (round-trip)', () => {
  const input: PromoteInput = {
    groupName: 'Reading Question Types',
    scenarioId: 'scrum-76-reading-question-types',
    testFilePath: 'tests/ui/student/reading-question-types.spec.ts',
    precondition: 'Student is attempting a Reading paper.',
    priority: 'high',
    steps: ['Open the reading paper', 'Select option A', 'Select option B'],
    expectations: [
      'the answer is recorded and displayed back correctly',
      'the previous selection is replaced',
    ],
  };
  const scenarios = parseScenariosFromSpec(writePlan(buildPlanScenario(input)));
  assert.equal(scenarios.length, 1);
  const s = scenarios[0];
  assert.equal(s.id, 'scrum-76-reading-question-types');
  assert.equal(s.testFilePath, 'tests/ui/student/reading-question-types.spec.ts');
  assert.equal(s.preconditions, 'Student is attempting a Reading paper.');
  assert.equal(s.priority, 'high');
  assert.deepEqual(s.steps, ['Open the reading paper', 'Select option A', 'Select option B']);
  assert.equal(
    s.expectedResult,
    'the answer is recorded and displayed back correctly; the previous selection is replaced',
  );
  assert.equal(s.suite, 'Reading Question Types');
});

test('promoteInputFromSession takes steps from the trace and expectations from PASSED verdicts', () => {
  const description = `Precondition:
User is attempting a Reading paper.

Acceptance Criteria:
Given a type renders, When the user answers, Then the answer should be recorded.
Given a Multiple Choice question allows one answer, When a second option is selected, Then the previous selection should be replaced.
`;
  const criteria = parseAcceptanceCriteria(description);
  const session: TicketVerifySession = {
    kind: 'ticket-verify',
    createdAt: '2026-09-30T00:00:00.000Z',
    ticket: {
      key: 'SCRUM-76',
      summary: 'Answer types',
      precondition: 'User is attempting a Reading paper.',
      actionSteps: [],
      acceptanceCriteria: criteria,
    },
    observations: [],
    proposals: [],
    trace: [
      { action: 'Open the reading paper' },
      { action: 'Select option A', targetRole: 'radio', targetName: 'Returning to' },
      { action: 'Select option B', targetRole: 'radio', targetName: 'Concealing with' },
    ],
  };
  const verdicts = mapVerdicts(criteria, [
    { acId: 'AC-1', status: 'pass', observed: 'recorded' },
    { acId: 'AC-2', status: 'pass', observed: 'replaced' },
  ]);
  const input = promoteInputFromSession(session, verdicts, {
    groupName: 'Reading Question Types',
    testFilePath: 'tests/ui/student/reading-question-types.spec.ts',
    priority: 'high',
  });
  assert.deepEqual(input.steps, ['Open the reading paper', 'Select option A', 'Select option B']);
  assert.equal(input.expectations.length, 2);
  assert.match(input.expectations[0], /recorded/);
  assert.equal(input.precondition, 'User is attempting a Reading paper.');
  assert.equal(input.priority, 'high');
  const scenarios = parseScenariosFromSpec(writePlan(buildPlanScenario(input)));
  assert.equal(scenarios.length, 1);
  assert.equal(scenarios[0].suite, 'Reading Question Types');
});


test('nextGroupIndex returns 1 + the highest existing group, or 1 when there are none', () => {
  assert.equal(nextGroupIndex('## Test Scenarios\n\n### 1. A\n\n### 2. B\n'), 3);
  assert.equal(nextGroupIndex('# Title\n\nno groups here\n'), 1);
});

test('buildPlanScenario honours groupIndex for appended scenarios, and buildNewSpecFile round-trips', () => {
  const input: PromoteInput = {
    groupName: 'Renewal Funnel',
    scenarioId: 'scrum-9-renewal-funnel',
    testFilePath: 'tests/ui/student/renewal.spec.ts',
    precondition: 'Logged in with a near-expiry package.',
    priority: 'medium',
    steps: ['Open subscriptions', 'Click renew'],
    expectations: ['the checkout page is reached'],
  };
  const block = buildPlanScenario(input, 3);
  assert.match(block, /^### 3\. Renewal Funnel/);
  assert.match(block, /#### 3\.1\. scrum-9-renewal-funnel/);
  const file = writePlan(buildNewSpecFile('Renewal Test Plan', 'SCRUM-9', buildPlanScenario(input, 1)));
  const scenarios = parseScenariosFromSpec(file);
  assert.equal(scenarios.length, 1);
  assert.equal(scenarios[0].id, 'scrum-9-renewal-funnel');
  assert.equal(scenarios[0].suite, 'Renewal Funnel');
});
