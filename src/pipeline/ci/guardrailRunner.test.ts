import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runGuardrailCheckDefinitions, GuardrailCheckDefinition } from './guardrailRunner';

test('runGuardrailCheckDefinitions maps a passing check (exitCode 0) to passed: true', () => {
  const checks: GuardrailCheckDefinition[] = [
    { name: 'Locator Priority Check', run: () => ({ exitCode: 0, report: 'no findings' }) },
  ];

  const results = runGuardrailCheckDefinitions(checks);

  assert.deepEqual(results, [{ name: 'Locator Priority Check', passed: true, report: 'no findings' }]);
});

test('runGuardrailCheckDefinitions maps a failing check (non-zero exitCode) to passed: false', () => {
  const checks: GuardrailCheckDefinition[] = [
    { name: 'Secrets Guardrail', run: () => ({ exitCode: 1, report: '1 finding' }) },
  ];

  const results = runGuardrailCheckDefinitions(checks);

  assert.deepEqual(results, [{ name: 'Secrets Guardrail', passed: false, report: '1 finding' }]);
});

test('runGuardrailCheckDefinitions catches a thrown check without losing the other results', () => {
  const checks: GuardrailCheckDefinition[] = [
    {
      name: 'Manifest Provenance Check',
      run: () => {
        throw new Error('invalid base sha');
      },
    },
    { name: 'Required Test Tags Check', run: () => ({ exitCode: 0, report: 'ok' }) },
  ];

  const results = runGuardrailCheckDefinitions(checks);

  assert.equal(results.length, 2);
  assert.equal(results[0].passed, false);
  assert.equal(results[0].report, 'THREW: invalid base sha');
  assert.deepEqual(results[1], { name: 'Required Test Tags Check', passed: true, report: 'ok' });
});
