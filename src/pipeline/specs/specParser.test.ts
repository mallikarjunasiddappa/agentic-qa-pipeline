import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseScenariosFromSpec, parseJiraKeyFromSpec, parseSuiteFromSpec } from './specParser';

function writeSpec(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specparser-test-'));
  const file = path.join(dir, 'feature.plan.md');
  fs.writeFileSync(file, content, 'utf-8');
  return file;
}

test('parseScenariosFromSpec: captures a scenario-specific Precondition line, not the group Seed path', () => {
  const specFile = writeSpec(`
## Test Scenarios

### 1. Student Login

**Seed:** \`tests/seed.spec.ts\`

#### 1.1. should-log-in-with-valid-credentials

**File:** \`tests/student/should-log-in-with-valid-credentials.spec.ts\`

**Precondition:** Student has a registered account with a verified email address.

**Steps:**
  1. Enter valid credentials and submit
    - expect: the dashboard is displayed
`);

  const [scenario] = parseScenariosFromSpec(specFile);
  assert.equal(
    scenario.preconditions,
    'Student has a registered account with a verified email address.',
  );
});

test('parseScenariosFromSpec: falls back to "Seed: <path>" when no Precondition line is present (older specs)', () => {
  const specFile = writeSpec(`
## Test Scenarios

### 1. Student Login

**Seed:** \`tests/seed.spec.ts\`

#### 1.1. should-log-in-with-valid-credentials

**File:** \`tests/student/should-log-in-with-valid-credentials.spec.ts\`

**Steps:**
  1. Enter valid credentials and submit
    - expect: the dashboard is displayed
`);

  const [scenario] = parseScenariosFromSpec(specFile);
  assert.equal(scenario.preconditions, 'Seed: tests/seed.spec.ts');
});

test('parseScenariosFromSpec: each scenario captures its own distinct Precondition, not the previous scenario\'s', () => {
  const specFile = writeSpec(`
## Test Scenarios

### 1. Subscriptions

**Seed:** \`tests/seed.spec.ts\`

#### 1.1. should-renew-an-expiring-subscription

**File:** \`tests/subs/should-renew-an-expiring-subscription.spec.ts\`

**Precondition:** Student has an active Pro subscription expiring within 3 days.

**Steps:**
  1. Click Renew
    - expect: the subscription is renewed

#### 1.2. should-show-renew-cta-for-cancelled-subscription

**File:** \`tests/subs/should-show-renew-cta-for-cancelled-subscription.spec.ts\`

**Precondition:** Student has a cancelled subscription with no active plan.

**Steps:**
  1. Open My Subscriptions
    - expect: a Renew call-to-action is displayed
`);

  const [first, second] = parseScenariosFromSpec(specFile);
  assert.equal(first.preconditions, 'Student has an active Pro subscription expiring within 3 days.');
  assert.equal(second.preconditions, 'Student has a cancelled subscription with no active plan.');
});

test('parseScenariosFromSpec: reads a group-level Priority line, applied to every scenario in that group', () => {
  const specFile = writeSpec(`
## Test Scenarios

### 1. Navigation

**Seed:** \`tests/seed.spec.ts\`

**Priority:** critical

#### 1.1. should-open-my-profile

**File:** \`tests/student/should-open-my-profile.spec.ts\`

**Steps:**
  1. Click Profile
    - expect: the profile opens

#### 1.2. should-reopen-profile

**File:** \`tests/student/should-reopen-profile.spec.ts\`

**Steps:**
  1. Reopen it
    - expect: it reopens
`);

  const [first, second] = parseScenariosFromSpec(specFile);
  assert.equal(first.priority, 'critical');
  assert.equal(second.priority, 'critical');
});

test('parseScenariosFromSpec: falls back to "medium" when no Priority line is present anywhere (older specs)', () => {
  const specFile = writeSpec(`
## Test Scenarios

### 1. Navigation

**Seed:** \`tests/seed.spec.ts\`

#### 1.1. should-open-my-profile

**File:** \`tests/student/should-open-my-profile.spec.ts\`

**Steps:**
  1. Click Profile
    - expect: the profile opens
`);

  const [scenario] = parseScenariosFromSpec(specFile);
  assert.equal(scenario.priority, 'medium');
});

test('parseScenariosFromSpec: a scenario-level Priority line overrides the group default', () => {
  const specFile = writeSpec(`
## Test Scenarios

### 1. Subscriptions

**Seed:** \`tests/seed.spec.ts\`

**Priority:** high

#### 1.1. should-renew-a-subscription

**File:** \`tests/subs/should-renew-a-subscription.spec.ts\`

**Priority:** critical

**Steps:**
  1. Click Renew
    - expect: the subscription is renewed

#### 1.2. should-view-billing-history

**File:** \`tests/subs/should-view-billing-history.spec.ts\`

**Steps:**
  1. Open billing history
    - expect: past invoices are listed
`);

  const [overridden, groupDefault] = parseScenariosFromSpec(specFile);
  assert.equal(overridden.priority, 'critical');
  assert.equal(groupDefault.priority, 'high');
});

test('parseScenariosFromSpec: Priority line is case-insensitive', () => {
  const specFile = writeSpec(`
## Test Scenarios

### 1. Navigation

**Seed:** \`tests/seed.spec.ts\`

**PRIORITY:** Low

#### 1.1. should-open-my-profile

**File:** \`tests/student/should-open-my-profile.spec.ts\`

**Steps:**
  1. Click Profile
    - expect: the profile opens
`);

  const [scenario] = parseScenariosFromSpec(specFile);
  assert.equal(scenario.priority, 'low');
});

test('parseJiraKeyFromSpec: still reads the Jira key marker unaffected by the Precondition change', () => {
  const specFile = writeSpec(`<!-- Jira: KAN-3 -->
# Feature Test Plan

## Test Scenarios

### 1. Group

**Seed:** \`tests/seed.spec.ts\`

#### 1.1. some-scenario

**File:** \`tests/group/some-scenario.spec.ts\`

**Precondition:** Some starting state.

**Steps:**
  1. Do a thing
    - expect: it happens
`);

  assert.equal(parseJiraKeyFromSpec(specFile), 'KAN-3');
});


test('parseSuiteFromSpec: reads the <!-- Suite: X --> marker, allowing spaces in the name', () => {
  const specFile = writeSpec('<!-- Jira: SCRUM-19 -->\n<!-- Suite: Student Login Flow -->\n\n## Test Scenarios\n');
  assert.equal(parseSuiteFromSpec(specFile), 'Student Login Flow');
});

test('parseSuiteFromSpec: returns null when the spec declares no suite', () => {
  const specFile = writeSpec('<!-- Jira: SCRUM-19 -->\n\n## Test Scenarios\n');
  assert.equal(parseSuiteFromSpec(specFile), null);
});
