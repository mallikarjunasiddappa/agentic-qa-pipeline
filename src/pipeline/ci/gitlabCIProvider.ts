import { GitlabClient } from './gitlabClient';
import { requireTenantEnv } from '../config/env';
import { runGuardrailChecks } from './guardrailRunner';
import { CIProvider, GuardrailCheckResult } from './types';

/**
 * Second CIProvider adapter (Production Roadmap Section 5: "CIProvider (GitHub Actions first,
 * GitLab second)"). runGuardrailChecks() is identical to GithubCIProvider's - the 8 guardrail
 * checks are pipeline-internal Node functions with no GitHub/GitLab dependency at all, so there is
 * nothing provider-specific to do there; only reportCheckStatus (which really does talk to a
 * specific host's API) differs between the two adapters.
 *
 * failed (not GitHub's 'failure') is GitLab's own real vocabulary for the Commit Status API - see
 * gitlabClient.ts's doc comment.
 */
export class GitlabCIProvider implements CIProvider {
  constructor(private readonly client: GitlabClient) {}

  async runGuardrailChecks(baseSha: string): Promise<GuardrailCheckResult[]> {
    return runGuardrailChecks(baseSha);
  }

  async reportCheckStatus(commitSha: string, result: GuardrailCheckResult): Promise<void> {
    const projectId = await requireTenantEnv('GITLAB_PROJECT_ID', 'GitLab CI Provider');
    await this.client.createCommitStatus(projectId, commitSha, {
      state: result.passed ? 'success' : 'failed',
      name: result.name,
      description: result.report.slice(0, 255), // GitLab's own description length limit
    });
  }
}
