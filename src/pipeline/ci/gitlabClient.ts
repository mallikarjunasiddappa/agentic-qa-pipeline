import axios, { AxiosInstance } from 'axios';
import { requireTenantEnv, resolveTenantEnv } from '../config/env';

// Real GitLab REST API v4 - ground truth confirmed against docs.gitlab.com/api/commits/
// (Commit status section: POST /projects/:id/statuses/:sha), not assumed. Same
// PAT-auth-via-requireTenantEnv shape as jiraClient.ts/githubClient.ts, but GitLab uses a
// PRIVATE-TOKEN header (not Bearer) and its own state vocabulary - pending/running/success/
// failed/canceled/skipped, notably 'failed' not GitHub's 'failure' - so GitlabCIProvider maps
// GuardrailCheckResult.passed to this vocabulary itself rather than reusing CommitStatusState
// (types.ts), which is GitHub's shape.
//
// UNVERIFIED against a real GitLab project - this repo has no GitLab remote, no .gitlab-ci.yml,
// and no GitLab account to test against (unlike GithubClient, which this project's own dev-status
// stage already exercises for real). Built from the public API docs alone. Run
// verify:gitlab-ci-provider (or equivalent) against a real GitLab project + token before relying
// on this - same "confirmed empirically, not assumed" standard as the OTLP receiver's own
// disclaimer (src/pipeline/costAccounting/otlpReceiver.ts).

export type GitlabCommitStatusState = 'pending' | 'running' | 'success' | 'failed' | 'canceled' | 'skipped';

export class GitlabClient {
  private http: AxiosInstance;

  // Same private-constructor + static async create() split as JiraClient/GithubClient -
  // requireTenantEnv is async (Secrets-manager mechanism), so construction can't happen
  // synchronously in a public constructor.
  private constructor(baseUrl: string, token: string) {
    this.http = axios.create({
      baseURL: `${baseUrl.replace(/\/$/, '')}/api/v4`,
      headers: { 'PRIVATE-TOKEN': token, Accept: 'application/json' },
    });
  }

  static async create(): Promise<GitlabClient> {
    // GITLAB_BASE_URL has a zod .default('https://gitlab.com') (env.ts), so resolveTenantEnv's
    // return type is already a plain string, never undefined - a tenant that never set it still
    // gets gitlab.com, matching every other "optional override, sensible default" var in this
    // pipeline (e.g. TMS_PROVIDER).
    const baseUrl = await resolveTenantEnv('GITLAB_BASE_URL');
    const token = await requireTenantEnv('GITLAB_TOKEN', 'GitLab CI Provider');
    return new GitlabClient(baseUrl, token);
  }

  /**
   * POST /projects/:id/statuses/:sha - real GitLab Commit Status API. `projectId` is GitLab's
   * numeric project id, OR an already-URL-encoded path (docs.gitlab.com/api/rest/#namespaced-paths
   * - GitLab's own docs specify the caller does this encoding, e.g. "my-group/my-project" becomes
   * "my-group%2Fmy-project"). Deliberately NOT re-encoded here - confirmed via a real local-server
   * request-shape test that calling encodeURIComponent() on an already-encoded path
   * double-encodes it (%2F becomes %252F, a real bug caught before it shipped, not theoretical).
   * Passed straight through unmodified, same as GithubClient takes "owner/repo" as-is for
   * GITHUB_REPO. `name` is GitLab's equivalent of GitHub's `context` - the label distinguishing
   * this status from any other system's.
   */
  async createCommitStatus(
    projectId: string,
    sha: string,
    params: { state: GitlabCommitStatusState; name: string; description?: string; targetUrl?: string },
  ): Promise<void> {
    await this.http.post(`/projects/${projectId}/statuses/${sha}`, null, {
      params: {
        state: params.state,
        name: params.name,
        description: params.description,
        target_url: params.targetUrl,
      },
    });
  }
}

let client: GitlabClient | null = null;

export async function getGitlabClient(): Promise<GitlabClient> {
  if (!client) client = await GitlabClient.create();
  return client;
}
