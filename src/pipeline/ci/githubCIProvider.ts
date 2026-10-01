import { GithubClient } from '../scrum/vcsClient/githubClient';
import { requireTenantEnv } from '../config/env';
import { runGuardrailChecks } from './guardrailRunner';
import { CIProvider, GuardrailCheckResult } from './types';

/**
 * Wraps the existing GithubClient (auth/axios instance stay inside GithubClient, unchanged) behind
 * the provider-agnostic CIProvider interface. runGuardrailChecks() delegates straight to
 * guardrailRunner.ts, which itself reuses the exact same 8 check functions pipeline.ts's
 * 'verify-guardrails-locally' stage already calls.
 */
export class GithubCIProvider implements CIProvider {
  constructor(private readonly client: GithubClient) {}

  async runGuardrailChecks(baseSha: string): Promise<GuardrailCheckResult[]> {
    return runGuardrailChecks(baseSha);
  }

  async reportCheckStatus(commitSha: string, result: GuardrailCheckResult): Promise<void> {
    const repo = await requireTenantEnv('GITHUB_REPO', 'CI Provider');
    await this.client.createCommitStatus(repo, commitSha, {
      state: result.passed ? 'success' : 'failure',
      context: result.name,
      description: result.report.slice(0, 140), // GitHub truncates description at ~140 chars anyway
    });
  }
}
