import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRunFilePath } from './runFilePath';
import { env } from '../config/env';
import { tenantDataPath } from '../config/tenantContext';

test('buildRunFilePath: namespaces the run file by Jira key instead of a single shared name', () => {
  const kan3 = buildRunFilePath('KAN-3');
  const kan1 = buildRunFilePath('KAN-1');
  assert.notEqual(kan3, kan1);
  assert.equal(kan3, tenantDataPath(env.OUTPUT_DIR, 'tms-run-kan-3.json'));
  assert.equal(kan1, tenantDataPath(env.OUTPUT_DIR, 'tms-run-kan-1.json'));
});

test('buildRunFilePath: same Jira key always produces the same, stable path', () => {
  assert.equal(buildRunFilePath('KAN-3'), buildRunFilePath('KAN-3'));
});

test('buildRunFilePath: lower-cases the key and sanitizes characters that are not filename-safe', () => {
  const result = buildRunFilePath('kan 3!');
  assert.match(result, /tms-run-[a-z0-9-]+\.json$/);
});
