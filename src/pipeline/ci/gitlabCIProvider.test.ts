import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitlabCIProvider } from './gitlabCIProvider';
import type { GitlabClient } from './gitlabClient';
import type { GuardrailCheckResult } from './types';

/**
 * Minimal stand-in for GitlabClient - same "records every call it receives" pattern as
 * testmgmt/qaseAdapter.test.ts's FakeQaseClient. In particular, this checks the one place a real
 * behavioral bug could hide: mapping GuardrailCheckResult.passed onto GitLab's own state
 * vocabulary ('failed', not GitHub's 'failure' - easy to get wrong copying the GitHub adapter).
 */
class FakeGitlabClient {
  calls: Record<string, unknown[]> = {};

  async createCommitStatus(projectId: string, sha: string, params: unknown): Promise<void> {
    this.calls.createCommitStatus = [projectId, sha, params];
  }
}

test('GitlabCIProvider.reportCheckStatus maps a passing check to state "success"', async () => {
  // GITLAB_PROJECT_ID has no schema default, so requireTenantEnv resolves it via
  // EnvFileSecretsProvider.getSecret(), which reads process.env live at call time - but only
  // through the tenant-scoped override key (envFileTenantKey('GITLAB_PROJECT_ID', 'default') =
  // 'GITLAB_PROJECT_ID__DEFAULT'), not the bare key. The bare-key fallback reads env.ts's `env`
  // object, which is parsed once at module import time - setting process.env.GITLAB_PROJECT_ID
  // directly here would be too late to affect it. resolveTenantEnv defaults to tenant "default"
  // when no tenant has been set (its own doc comment - true in this unit test, no setTenantId()
  // call), so "default" is the right tenant suffix here, not a guess.
  process.env.GITLAB_PROJECT_ID__DEFAULT = '17';
  const fake = new FakeGitlabClient();
  const provider = new GitlabCIProvider(fake as unknown as GitlabClient);
  const result: GuardrailCheckResult = { name: 'Locator Priority Check', passed: true, report: 'no findings' };

  await provider.reportCheckStatus('abc123', result);

  assert.deepEqual(fake.calls.createCommitStatus, [
    '17',
    'abc123',
    { state: 'success', name: 'Locator Priority Check', description: 'no findings' },
  ]);
});

test('GitlabCIProvider.reportCheckStatus maps a failing check to state "failed" (not GitHub\'s "failure")', async () => {
  // GITLAB_PROJECT_ID has no schema default, so requireTenantEnv resolves it via
  // EnvFileSecretsProvider.getSecret(), which reads process.env live at call time - but only
  // through the tenant-scoped override key (envFileTenantKey('GITLAB_PROJECT_ID', 'default') =
  // 'GITLAB_PROJECT_ID__DEFAULT'), not the bare key. The bare-key fallback reads env.ts's `env`
  // object, which is parsed once at module import time - setting process.env.GITLAB_PROJECT_ID
  // directly here would be too late to affect it. resolveTenantEnv defaults to tenant "default"
  // when no tenant has been set (its own doc comment - true in this unit test, no setTenantId()
  // call), so "default" is the right tenant suffix here, not a guess.
  process.env.GITLAB_PROJECT_ID__DEFAULT = '17';
  const fake = new FakeGitlabClient();
  const provider = new GitlabCIProvider(fake as unknown as GitlabClient);
  const result: GuardrailCheckResult = { name: 'Secrets Guardrail', passed: false, report: '1 finding' };

  await provider.reportCheckStatus('abc123', result);

  assert.deepEqual(fake.calls.createCommitStatus, [
    '17',
    'abc123',
    { state: 'failed', name: 'Secrets Guardrail', description: '1 finding' },
  ]);
});

test('GitlabCIProvider.reportCheckStatus truncates a long report to 255 chars for description', async () => {
  // GITLAB_PROJECT_ID has no schema default, so requireTenantEnv resolves it via
  // EnvFileSecretsProvider.getSecret(), which reads process.env live at call time - but only
  // through the tenant-scoped override key (envFileTenantKey('GITLAB_PROJECT_ID', 'default') =
  // 'GITLAB_PROJECT_ID__DEFAULT'), not the bare key. The bare-key fallback reads env.ts's `env`
  // object, which is parsed once at module import time - setting process.env.GITLAB_PROJECT_ID
  // directly here would be too late to affect it. resolveTenantEnv defaults to tenant "default"
  // when no tenant has been set (its own doc comment - true in this unit test, no setTenantId()
  // call), so "default" is the right tenant suffix here, not a guess.
  process.env.GITLAB_PROJECT_ID__DEFAULT = '17';
  const fake = new FakeGitlabClient();
  const provider = new GitlabCIProvider(fake as unknown as GitlabClient);
  const longReport = 'x'.repeat(400);
  const result: GuardrailCheckResult = { name: 'Assertion Integrity Check', passed: false, report: longReport };

  await provider.reportCheckStatus('abc123', result);

  const params = fake.calls.createCommitStatus[2] as { description: string };
  assert.equal(params.description.length, 255);
});
