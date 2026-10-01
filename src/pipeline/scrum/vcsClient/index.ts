import { loadScrumConfig } from '../../config/scrumConfigStore';
import { resolveTenantEnv } from '../../config/env';
import { getGithubClient } from './githubClient';
import { GithubAdapter } from './githubAdapter';
import { VcsClient } from './types';

export type { VcsClient, PullRequestInfo, PullRequestReviewState, BranchInfo } from './types';

let client: VcsClient | null = null;

/**
 * Returns the configured VCS provider's client. Provider comes from this tenant's
 * config/tenants/<id>/scrum.json vcs.provider (ScrumConfigSchema) - not an env var or
 * capabilities.json - since which VCS a tenant's tickets live in is a scrum-config concern, the
 * same file that already holds vcs.branchKeyConvention. Falls back to "github" when a tenant has
 * no scrum.json yet or leaves vcs.provider unset, matching getTestManagementClient()'s "default to
 * the one adapter that actually exists" reasoning (testmgmt/index.ts) - "github" is the only
 * adapter built today, same as "qase" is TMS's only one.
 */
export async function getVcsClient(): Promise<VcsClient> {
  if (client) return client;

  const provider = loadScrumConfig().vcs.provider ?? 'github';
  switch (provider) {
    case 'github':
      client = new GithubAdapter(await getGithubClient());
      return client;
    default:
      throw new Error(`Unknown VCS provider "${provider}". Only "github" is supported today - no other VCS adapter has been built yet.`);
  }
}

/**
 * Whether this tenant actually has VCS connected - checked via resolveTenantEnv('GITHUB_REPO')
 * resolving to a non-empty value, the same real-world signal a getVcsClient() call would need to
 * do anything useful. Deliberately NOT scrum.json's vcs.provider being set: that field only
 * answers "which adapter would this tenant use if it had VCS at all" (it defaults to "github" even
 * for a tenant that never configured GITHUB_REPO - see getVcsClient()'s own doc comment), so it is
 * not a real signal of whether VCS is actually usable. A second boolean tracking that same fact in
 * capabilities.json/scrum.json would just be redundant state that can drift out of sync with
 * whether GITHUB_REPO is actually set - the same anti-pattern this project avoids elsewhere (e.g.
 * capabilities.json's tenantId-must-match-its-own-directory check exists so there's one source of
 * truth, not two that can disagree).
 *
 * For a multi-tenant SaaS product, not every tenant will connect a GitHub repo - this helper
 * exists for stages where VCS is optional enrichment over some other primary data source
 * (--stage retro-notes-fetch today) to skip it gracefully rather than hard-fail the whole stage.
 * It is deliberately NOT used by --stage dev-status: VCS reporting is dev-status's entire reason
 * for existing, so an unconfigured tenant should see its existing "Missing required env var
 * GITHUB_REPO" failure, not a report that looks complete (0 PRs, 0 branches) but is actually just
 * unconfigured - see devStatus.ts's own stage doc comment in pipeline.ts for why that distinction
 * matters (a report with zero VCS activity must always mean "checked, found nothing", never
 * "never checked").
 */
export async function hasVcsConfigured(): Promise<boolean> {
  return !!(await resolveTenantEnv('GITHUB_REPO'));
}
