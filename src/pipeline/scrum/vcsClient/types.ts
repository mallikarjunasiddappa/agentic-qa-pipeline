/**
 * Provider-agnostic surface every VCS adapter implements - mirrors testmgmt/types.ts's
 * TestManagementClient exactly (same reasoning: one interface, one adapter per provider, no
 * provider-specific shape leaking into this file). GitHub is the only adapter that exists today
 * (this tenant's config/tenants/default/scrum.json sets vcs.provider: "github"), but nothing here
 * assumes GitHub - a second provider (GitLab, Bitbucket, ...) is a new adapter + a new case in
 * this module's index.ts, not a redesign of this interface.
 *
 * `repo` is an explicit parameter on every method (not read from env inside the client) for the
 * same "don't bake in a single-target assumption" reasoning as ScrumConfigSchema's `boardIds`
 * being an array - a tenant with more than one repo in scope later doesn't need an interface
 * change, just a caller that loops over more than one repo string.
 */

export type PullRequestState = 'open' | 'draft' | 'merged' | 'closed';

// Derived, not the provider's raw review vocabulary - "review_required" specifically means
// reviewers are requested but none has submitted an actual review yet (distinct from "no_review",
// where nobody has been asked). "changes_requested" wins over a stale "approved" from a different
// reviewer - see deriveReviewState in githubAdapter.ts for the exact precedence.
export type PullRequestReviewState = 'approved' | 'changes_requested' | 'review_required' | 'no_review';

export interface PullRequestInfo {
  number: number;
  title: string;
  branch: string;
  baseBranch: string;
  state: PullRequestState;
  reviewState: PullRequestReviewState;
  author: string;
  url: string;
  createdAt: string;
  updatedAt: string;
}

export interface BranchInfo {
  name: string;
  lastCommitSha: string;
  // ISO timestamp of the branch's HEAD commit - see githubClient.ts's listBranchesWithCommitDates
  // for why this costs one extra API call per branch on the GitHub adapter, and why that's an
  // acceptable tradeoff for a single small-team repo today.
  lastCommitDate: string;
}

export interface VcsClient {
  listOpenPullRequests(repo: string): Promise<PullRequestInfo[]>;
  listBranches(repo: string): Promise<BranchInfo[]>;
}
