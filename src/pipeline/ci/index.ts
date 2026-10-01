import { env } from '../config/env';
import { getGithubClient } from '../scrum/vcsClient/githubClient';
import { GithubCIProvider } from './githubCIProvider';
import { getGitlabClient } from './gitlabClient';
import { GitlabCIProvider } from './gitlabCIProvider';
import { CIProvider } from './types';

export type { CIProvider, GuardrailCheckName, GuardrailCheckResult, CommitStatusState } from './types';
export { runGuardrailChecks, runGuardrailCheckDefinitions, buildRealGuardrailChecks } from './guardrailRunner';
export type { GuardrailCheckDefinition } from './guardrailRunner';

let provider: CIProvider | null = null;

/**
 * Returns the configured CI provider. Provider comes from the global CI_PROVIDER env var
 * (defaults to 'github', the first-built adapter) - same "global env var, sensible default" shape
 * as TMS_PROVIDER, not yet wired into capabilityStore.ts's per-tenant resolution (see env.ts's
 * CI_PROVIDER doc comment for why). 'github' and 'gitlab' both have real adapters today
 * (Production Roadmap Section 5: "CIProvider (GitHub Actions first, GitLab second)") -
 * GitlabCIProvider is unverified against a real GitLab project, see gitlabClient.ts's doc comment.
 */
export async function getCIProvider(): Promise<CIProvider> {
  if (provider) return provider;

  switch (env.CI_PROVIDER) {
    case 'github':
      provider = new GithubCIProvider(await getGithubClient());
      return provider;
    case 'gitlab':
      provider = new GitlabCIProvider(await getGitlabClient());
      return provider;
    default:
      throw new Error(
        `Unknown CI provider "${env.CI_PROVIDER}". Only "github" and "gitlab" are supported today - no other CI adapter has been built yet.`,
      );
  }
}
