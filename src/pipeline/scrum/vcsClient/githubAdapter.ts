import { GithubClient, GithubPullRequestRaw, GithubReviewRaw, GithubBranchRaw } from './githubClient';
import { VcsClient, PullRequestInfo, PullRequestReviewState, BranchInfo } from './types';

/**
 * Derives one overall review state for a PR from GitHub's per-reviewer review event list, plus
 * how many reviewers are currently requested (raw.requested_reviewers.length - GitHub doesn't
 * expose this as part of the reviews list itself).
 *
 * Only each reviewer's MOST RECENT review counts (GitHub keeps every historical review event,
 * including ones a later re-review superseded) - a reviewer who requested changes and later
 * approved the same PR should read as approved, not changes_requested, for that reviewer.
 * COMMENTED and DISMISSED reviews never change the outcome on their own; DISMISSED specifically
 * means a maintainer already dismissed that review, so counting it would resurrect a decision
 * GitHub itself has already retracted.
 *
 * Precedence once each reviewer's latest real (APPROVED/CHANGES_REQUESTED) state is known: any
 * outstanding CHANGES_REQUESTED wins over any APPROVED - a PR isn't ready just because someone
 * else approved it while another reviewer's requested changes are still unaddressed. Only when
 * nobody has ever submitted a real review do we fall back to whether reviewers are currently
 * requested (review_required) vs. nobody being asked at all (no_review).
 */
export function deriveReviewState(reviews: GithubReviewRaw[], requestedReviewerCount: number): PullRequestReviewState {
  const latestByReviewer = new Map<string, GithubReviewRaw>();
  for (const review of reviews) {
    const reviewer = review.user?.login;
    if (!reviewer) continue;
    if (review.state !== 'APPROVED' && review.state !== 'CHANGES_REQUESTED') continue;
    const existing = latestByReviewer.get(reviewer);
    if (!existing || (review.submitted_at ?? '') >= (existing.submitted_at ?? '')) {
      latestByReviewer.set(reviewer, review);
    }
  }

  const latestStates = [...latestByReviewer.values()].map((r) => r.state);
  if (latestStates.includes('CHANGES_REQUESTED')) return 'changes_requested';
  if (latestStates.includes('APPROVED')) return 'approved';
  return requestedReviewerCount > 0 ? 'review_required' : 'no_review';
}

export function mapGithubPullRequest(raw: GithubPullRequestRaw, reviews: GithubReviewRaw[]): PullRequestInfo {
  const state: PullRequestInfo['state'] = raw.merged_at ? 'merged' : raw.draft ? 'draft' : raw.state === 'open' ? 'open' : 'closed';

  return {
    number: raw.number,
    title: raw.title,
    branch: raw.head.ref,
    baseBranch: raw.base.ref,
    state,
    reviewState: deriveReviewState(reviews, raw.requested_reviewers.length),
    author: raw.user?.login ?? 'unknown',
    url: raw.html_url,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

export function mapGithubBranch(raw: GithubBranchRaw, commitDate: string): BranchInfo {
  return {
    name: raw.name,
    lastCommitSha: raw.commit.sha,
    lastCommitDate: commitDate,
  };
}

/**
 * Wraps GithubClient (raw axios calls, auth, and GitHub's own wire shapes all stay inside
 * GithubClient, unchanged) behind the provider-agnostic VcsClient interface - same split as
 * QaseAdapter wrapping QaseClient in testmgmt/qaseAdapter.ts. All GitHub-specific vocabulary
 * (draft/merged_at, APPROVED/CHANGES_REQUESTED, requested_reviewers) is translated at this
 * boundary only; nothing above this file ever sees a raw GitHub shape.
 */
export class GithubAdapter implements VcsClient {
  constructor(private readonly client: GithubClient) {}

  async listOpenPullRequests(repo: string): Promise<PullRequestInfo[]> {
    const raws = await this.client.listOpenPullRequests(repo);
    const withReviews = await Promise.all(
      raws.map(async (raw) => ({ raw, reviews: await this.client.listReviews(repo, raw.number) })),
    );
    return withReviews.map(({ raw, reviews }) => mapGithubPullRequest(raw, reviews));
  }

  async listBranches(repo: string): Promise<BranchInfo[]> {
    const raws = await this.client.listBranchesRaw(repo);
    return Promise.all(
      raws.map(async (raw) => mapGithubBranch(raw, await this.client.getCommitDate(repo, raw.commit.sha))),
    );
  }
}
