import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTenantId, resetTenantIdForTests } from './tenantContext';
import {
  loadCapabilities,
  assertStageAllowed,
  resolveTmsProvider,
  resolveSecretsProvider,
  STAGE_CAPABILITY_MAP,
} from './capabilityStore';
import { TenantCapabilities, TenantCapabilitiesSchema } from '../types/schemas';

// Builds a capabilities object from scratch via the schema's own defaults plus explicit
// overrides - never by mutating an object returned from loadCapabilities()/fullAccessDefaults(),
// since node:test may run sibling tests concurrently and a shared/mutated object would make tests
// depend on execution order instead of being independent.
function capsWith(overrides: Record<string, unknown> = {}): TenantCapabilities {
  return TenantCapabilitiesSchema.parse({ tenantId: 'acme', ...overrides });
}

let tmpDir: string;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capability-store-test-'));
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  setTenantId('acme');
});

afterEach(() => {
  resetTenantIdForTests();
});

test('loadCapabilities returns full-permissive defaults when the file does not exist - opt-out, not opt-in', () => {
  const caps = loadCapabilities(path.join(tmpDir, 'nope.json'));
  assert.equal(caps.tenantId, 'acme');
  assert.equal(caps.integrations.jira.enabled, true);
  assert.equal(caps.integrations.tms.enabled, true);
  assert.equal(caps.integrations.tms.provider, undefined);
  assert.equal(caps.integrations.notifications.enabled, true);
  assert.deepEqual(caps.integrations.notifications.channels, {});
  for (const key of Object.keys(caps.stages) as (keyof typeof caps.stages)[]) {
    assert.equal(caps.stages[key], true, `expected stages.${key} to default true`);
  }
});

test('loadCapabilities parses a real config/tenants/<id>.json with a narrower plan', () => {
  const p = path.join(tmpDir, 'acme.json');
  fs.writeFileSync(
    p,
    JSON.stringify({
      tenantId: 'acme',
      plan: 'starter',
      integrations: { tms: { enabled: true, provider: 'xray' } },
      stages: { tmsUpload: false, healing: false },
    }),
    'utf-8',
  );
  const caps = loadCapabilities(p);
  assert.equal(caps.plan, 'starter');
  assert.equal(caps.integrations.tms.provider, 'xray');
  assert.equal(caps.stages.tmsUpload, false);
  assert.equal(caps.stages.healing, false);
  // Untouched flags still default true - a narrower plan only turns things off explicitly.
  assert.equal(caps.stages.traceability, true);
  assert.equal(caps.integrations.jira.enabled, true);
});

test('loadCapabilities throws when the file\'s declared tenantId does not match the tenant it was loaded for', () => {
  const p = path.join(tmpDir, 'mismatched.json');
  fs.writeFileSync(p, JSON.stringify({ tenantId: 'someone-else' }), 'utf-8');
  assert.throws(() => loadCapabilities(p), /declares tenantId "someone-else".*loaded for tenant "acme"/s);
});

test('assertStageAllowed does not throw when the mapped capability is enabled (default)', () => {
  assert.doesNotThrow(() => assertStageAllowed('tms-upload'));
});

test('assertStageAllowed throws an actionable error when the mapped capability is disabled', () => {
  const caps = capsWith({ stages: { tmsUpload: false } });
  assert.throws(
    () => assertStageAllowed('tms-upload', caps),
    /--stage tms-upload is disabled for tenant "acme".*capability "tmsUpload"/s,
  );
});

test('assertStageAllowed never gates a CI guardrail-check stage, even with every capability off', () => {
  const caps = capsWith({
    stages: {
      scenarioGeneration: false,
      tmsUpload: false,
      traceability: false,
      healing: false,
      flakyManagement: false,
      costAccounting: false,
      notifications: false,
      reporting: false,
      jiraWorkflowActions: false,
    },
  });
  assert.doesNotThrow(() => assertStageAllowed('secrets-check', caps));
  assert.doesNotThrow(() => assertStageAllowed('scenario-quality-check', caps));
});

test('assertStageAllowed treats a stage missing from the map as ungated rather than blocking it', () => {
  const caps = capsWith();
  assert.doesNotThrow(() => assertStageAllowed('some-future-stage-not-yet-mapped', caps));
});

test('STAGE_CAPABILITY_MAP has an entry for every real --stage value in pipeline.ts - no silently ungated stage by omission', () => {
  const pipelineSource = fs.readFileSync(
    path.join('src', 'pipeline', 'orchestrator', 'pipeline.ts'),
    'utf-8',
  );
  const realStages = [...pipelineSource.matchAll(/case '([a-z0-9-]+)':/g)].map((m) => m[1]);
  assert.ok(realStages.length > 0, 'expected to find at least one --stage case label in pipeline.ts');
  const missing = realStages.filter((stage) => !(stage in STAGE_CAPABILITY_MAP));
  assert.deepEqual(missing, [], `pipeline.ts has --stage values with no STAGE_CAPABILITY_MAP entry: ${missing.join(', ')}`);
});

test('resolveTmsProvider prefers the tenant\'s configured provider over the given fallback', () => {
  const caps = capsWith({ integrations: { tms: { provider: 'zephyr' } } });
  assert.equal(resolveTmsProvider('qase', caps), 'zephyr');
});

test('resolveTmsProvider falls back to the given default when the tenant has no provider configured', () => {
  const caps = capsWith();
  assert.equal(resolveTmsProvider('qase', caps), 'qase');
});

test('resolveSecretsProvider defaults to "env-file" for a tenant that has not opted into a real secrets manager', () => {
  const caps = capsWith();
  assert.equal(resolveSecretsProvider(caps), 'env-file');
});

test('resolveSecretsProvider returns the tenant\'s configured provider when set (e.g. "azure-key-vault")', () => {
  const caps = capsWith({ integrations: { secrets: { provider: 'azure-key-vault' } } });
  assert.equal(resolveSecretsProvider(caps), 'azure-key-vault');
});
