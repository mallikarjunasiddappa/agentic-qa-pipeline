import axios, { AxiosInstance } from 'axios';
import { requireTenantEnv } from '../../config/env';

export interface GithubPullRequestRaw {
  number: number;
  title: string;
  html_url: string;
  state: 'open' | 'closed';
  draft: boolean;
  merged_at: string | null;
  head: { ref: string };
  base: { ref: string };
  user: { login: string } | null;
  created_at: string;
  updated_at: string;
  requested_reviewers: { login: string }[];
}

export interface GithubReviewRaw {
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';
  submitted_at: string | null;
  user: { login: string } | null;
}

export interface GithubBranchRaw {
  name: string;
  commit: { sha: string; url: string };
}

/**
 * Raw GitHub REST API v3 client - PAT auth via GITHUB_TOKEN, same requireTenantEnv per-tenant
 * override mechanism as jiraClient.ts's JIRA_* credentials. Returns GitHub's own wire shapes
 * unchanged (only the fields this pipeline actually reads are typed here); translating those into
 * this pipeline's provider-agnostic PullRequestInfo/BranchInfo shapes happens one layer up, in
 * githubAdapter.ts - same split as qaseClient.ts (raw Qase API) vs. qaseAdapter.ts (maps onto
 * TestManagementClient) in testmgmt/.
 */
export class GithubClient {
  private http: AxiosInstance;

  // Constructor is now private - credentials must be resolved async (requireTenantEnv is async
  // since the Secrets-manager fix), so construction goes through the static async create()
  // factory below instead of `new GithubClient()`.
  private constructor(token: string) {
    this.http = axios.create({
      baseURL: 'https://api.github.com',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
  }

  static async create(): Promise<GithubClient> {
    const token = await requireTenantEnv('GITHUB_TOKEN', 'VCS Client (dev-status)');
    return new GithubClient(token);
  }

  async listOpenPullRequests(repo: string): Promise<GithubPullRequestRaw[]> {
    const { data } = await this.http.get<GithubPullRequestRaw[]>(`/repos/${repo}/pulls`, {
      params: { state: 'open', per_page: 100 },
    });
    return data;
  }

  async listReviews(repo: string, prNumber: number): Promise<GithubReviewRaw[]> {
    const { data } = await this.http.get<GithubReviewRaw[]>(`/repos/${repo}/pulls/${prNumber}/reviews`, {
      params: { per_page: 100 },
    });
    return data;
  }

  async listBranchesRaw(repo: string): Promise<GithubBranchRaw[]> {
    const { data } = await this.http.get<GithubBranchRaw[]>(`/repos/${repo}/branches`, {
      params: { per_page: 100 },
    });
    return data;
  }

  /**
   * GitHub's branches-list endpoint only returns each branch's HEAD commit sha, not its date - the
   * date lives on the commit object itself, which needs a separate GET /repos/{repo}/commits/{sha}
   * call. This is a deliberate one-call-per-branch tradeoff, not an oversight: it's the only way
   * to get a real commit date per branch from the REST API without a GraphQL client (which would
   * need its own auth/query-building layer this pipeline doesn't have yet). Acceptable for a
   * single small-team repo's branch count today; if this tenant's branch count grows large enough
   * for this to matter, batch it via GitHub's GraphQL API instead of adding N more REST calls here.
   */
  /**
   * POSTs to GitHub's Statuses API (not the newer Checks API - the Checks API's check-runs are
   * tied to a GitHub App installation, whereas Statuses works with this client's existing PAT auth,
   * same as every other method here). `context` is the string GitHub matches against a branch
   * protection rule's required-check name - see CIProvider.reportCheckStatus's doc comment
   * (src/pipeline/ci/types.ts) for why that exact mapping is not yet confirmed against this repo's
   * real Settings -> Rules config.
   */
  async createCommitStatus(
    repo: string,
    sha: string,
    params: { state: 'pending' | 'success' | 'failure' | 'error'; context: string; description?: string },
  ): Promise<void> {
    await this.http.post(`/repos/${repo}/statuses/${sha}`, {
      state: params.state,
      context: params.context,
      description: params.description,
    });
  }

  async getCommitDate(repo: string, sha: string): Promise<string> {
    const { data } = await this.http.get<{ commit: { committer: { date: string } | null; author: { date: string } | null } }>(
      `/repos/${repo}/commits/${sha}`,
    );
    const date = data.commit.committer?.date ?? data.commit.author?.date;
    if (!date) {
      throw new Error(`GitHub commit ${repo}@${sha} has no committer or author date - unexpected API response shape.`);
    }
    return date;
  }
}

let client: GithubClient | null = null;

export async function getGithubClient(): Promise<GithubClient> {
  if (!client) client = await GithubClient.create();
  return client;
}
