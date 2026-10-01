import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QaseAdapter } from './qaseAdapter';
import type { QaseClient, QaseCaseDetail, QaseResultStatus } from './qaseClient';
import type { Scenario, ScenarioWithCaseId } from '../types/schemas';
import type { TmsCreateCaseOptions } from './types';

/**
 * Minimal stand-in for QaseClient that records every call it receives, so these tests can assert
 * on exactly what QaseAdapter passes through - in particular the string<->number id conversion at
 * the adapter boundary, which is the part of this abstraction most likely to hide an off-by-type
 * bug (e.g. forgetting to convert, or double-converting).
 */
class FakeQaseClient {
  calls: Record<string, unknown[]> = {};

  private record(name: string, args: unknown[]): void {
    this.calls[name] = args;
  }

  async getCase(caseId: number): Promise<QaseCaseDetail> {
    this.record('getCase', [caseId]);
    return {
      id: caseId,
      title: 'Some case',
      description: 'desc',
      preconditions: null,
      steps: [{ action: 'do a thing', expected_result: 'it happens' }],
      updated_at: '2026-08-06T00:00:00Z',
    };
  }

  async createCase(scenario: Scenario, options?: TmsCreateCaseOptions): Promise<ScenarioWithCaseId> {
    this.record('createCase', [scenario, options]);
    return { ...scenario, externalCaseId: '42' };
  }

  async bulkUploadScenarios(
    scenarios: Scenario[],
    options?: TmsCreateCaseOptions,
  ): Promise<ScenarioWithCaseId[]> {
    this.record('bulkUploadScenarios', [scenarios, options]);
    return scenarios.map((s, i) => ({ ...s, externalCaseId: String(i + 1) }));
  }

  async createRun(caseIds: number[], title?: string): Promise<number> {
    this.record('createRun', [caseIds, title]);
    return 7;
  }

  setActiveRun(runId: number): void {
    this.record('setActiveRun', [runId]);
  }

  async submitResult(params: { caseId: number; status: QaseResultStatus; comment?: string }): Promise<void> {
    this.record('submitResult', [params]);
  }

  async resolveSuiteId(topLevelTitle?: string, subTitle?: string): Promise<number | undefined> {
    this.record('resolveSuiteId', [topLevelTitle, subTitle]);
    if (!topLevelTitle) return undefined;
    return 55;
  }

  async updateCaseSuite(caseId: number, suiteId: number): Promise<void> {
    this.record('updateCaseSuite', [caseId, suiteId]);
  }
}

function adapterWithFake(): { adapter: QaseAdapter; fake: FakeQaseClient } {
  const fake = new FakeQaseClient();
  const adapter = new QaseAdapter(fake as unknown as QaseClient);
  return { adapter, fake };
}

test('getCase: converts the string caseId to a number for QaseClient, and stringifies the result id', async () => {
  const { adapter, fake } = adapterWithFake();
  const result = await adapter.getCase('123');
  assert.deepEqual(fake.calls.getCase, [123]);
  assert.equal(result.id, '123');
  assert.deepEqual(result.steps, [{ action: 'do a thing', expectedResult: 'it happens' }]);
});

test('createRun: converts string caseIds to numbers going in, and stringifies the numeric runId coming back', async () => {
  const { adapter, fake } = adapterWithFake();
  const runId = await adapter.createRun(['1', '2', '3'], 'my run');
  assert.deepEqual(fake.calls.createRun, [[1, 2, 3], 'my run']);
  assert.equal(runId, '7');
  assert.equal(typeof runId, 'string');
});

test('setActiveRun: converts the string runId to a number for QaseClient', () => {
  const { adapter, fake } = adapterWithFake();
  adapter.setActiveRun('99');
  assert.deepEqual(fake.calls.setActiveRun, [99]);
});

test('submitResult: converts caseId to a number, passes status/comment through unchanged', async () => {
  const { adapter, fake } = adapterWithFake();
  await adapter.submitResult({ caseId: '5', status: 'passed', comment: 'looks good' });
  assert.deepEqual(fake.calls.submitResult, [{ caseId: 5, status: 'passed', comment: 'looks good' }]);
});

test('createCase/bulkCreateCases: pass straight through, no double conversion of the already-string externalCaseId', async () => {
  const { adapter, fake } = adapterWithFake();
  const scenario: Scenario = {
    id: 'should-do-a-thing',
    title: 'Should do a thing',
    preconditions: 'none',
    steps: ['do a thing'],
    expectedResult: 'it happens',
    priority: 'medium',
  };

  const created = await adapter.createCase(scenario);
  assert.equal(created.externalCaseId, '42');
  assert.deepEqual(fake.calls.createCase, [scenario, undefined]);

  const bulk = await adapter.bulkCreateCases([scenario, scenario]);
  assert.deepEqual(
    bulk.map((s) => s.externalCaseId),
    ['1', '2'],
  );
});

test('createCase/bulkCreateCases: pass the suiteTitle option straight through to QaseClient unchanged', async () => {
  const { adapter, fake } = adapterWithFake();
  const scenario: Scenario = {
    id: 'should-do-a-thing',
    title: 'Should do a thing',
    preconditions: 'none',
    steps: ['do a thing'],
    expectedResult: 'it happens',
    priority: 'medium',
    suite: 'Student Login',
  };

  await adapter.createCase(scenario, { suiteTitle: 'Profile Subscriptions' });
  assert.deepEqual(fake.calls.createCase, [scenario, { suiteTitle: 'Profile Subscriptions' }]);

  await adapter.bulkCreateCases([scenario], { suiteTitle: 'Profile Subscriptions' });
  assert.deepEqual(fake.calls.bulkUploadScenarios, [[scenario], { suiteTitle: 'Profile Subscriptions' }]);
});

test('moveCaseToSuite: resolves the suite id then patches the case, converting caseId to a number', async () => {
  const { adapter, fake } = adapterWithFake();
  await adapter.moveCaseToSuite('123', 'Profile Subscriptions', 'Student Login');
  assert.deepEqual(fake.calls.resolveSuiteId, ['Profile Subscriptions', 'Student Login']);
  assert.deepEqual(fake.calls.updateCaseSuite, [123, 55]);
});

test('moveCaseToSuite: no-ops (does not call updateCaseSuite) when resolveSuiteId returns undefined', async () => {
  const { adapter, fake } = adapterWithFake();
  // FakeQaseClient's resolveSuiteId returns undefined whenever topLevelTitle is falsy - mirrors
  // QaseClient's real behavior of never guessing a suite when there's no title to resolve.
  await adapter.moveCaseToSuite('123', '');
  assert.equal(fake.calls.updateCaseSuite, undefined);
});
