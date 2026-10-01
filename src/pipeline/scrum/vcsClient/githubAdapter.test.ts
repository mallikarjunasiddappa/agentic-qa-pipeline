import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveReviewState, mapGithubPullRequest, mapGithubBranch } from './githubAdapter';
import { GithubPullRequestRaw, GithubReviewRaw, GithubBranchRaw } from './githubClient';

function review(overrides: Omit<Partial<GithubReviewRaw>, 'user'> & { user: string }): GithubReviewRaw {
  return {
    state: 'COMMENTED',
    submitted_at: '2026-08-01T00:00:00Z',
    ...overrides,
    user: { login: overrides.user },
  } as GithubReviewRaw;
}

test('deriveReviewState: no reviews and nobody requested -> no_review', () => {
  assert.equal(deriveReviewState([], 0), 'no_review');
});

test('deriveReviewState: no reviews yet but reviewers are requested -> review_required', () => {
  assert.equal(deriveReviewState([], 2), 'review_required');
});

test('deriveReviewState: a single approval -> approved', () => {
  const reviews = [review({ user: 'alice', state: 'APPROVED' })];
  assert.equal(deriveReviewState(reviews, 1), 'approved');
});

test('deriveReviewState: changes requested wins over a different reviewer\'s approval', () => {
  const reviews = [
    review({ user: 'alice', state: 'APPROVED' }),
    review({ user: 'bob', state: 'CHANGES_REQUESTED' }),
  ];
  assert.equal(deriveReviewState(reviews, 2), 'changes_requested');
});

test('deriveReviewState: a reviewer\'s later approval supersedes their own earlier changes-requested', () => {
  const reviews = [
    review({ user: 'alice', state: 'CHANGES_REQUESTED', submitted_at: '2026-08-01T00:00:00Z' }),
    review({ user: 'alice', state: 'APPROVED', submitted_at: '2026-08-02T00:00:00Z' }),
  ];
  assert.equal(deriveReviewState(reviews, 1), 'approved');
});

test('deriveReviewState: COMMENTED and DISMISSED reviews never decide the outcome on their own', () => {
  const reviews = [review({ user: 'alice', state: 'COMMENTED' }), review({ user: 'bob', state: 'DISMISSED' })];
  assert.equal(deriveReviewState(reviews, 2), 'review_required');
});

function pullRequestRaw(overrides: Partial<GithubPullRequestRaw> = {}): GithubPullRequestRaw {
  return {
    number: 42,
    title: 'feat: KAN-123 add login flow',
    html_url: 'https://github.com/acme/repo/pull/42',
    state: 'open',
    draft: false,
    merged_at: null,
    head: { ref: 'feature/kan-123-login' },
    base: { ref: 'main' },
    user: { login: 'alice' },
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-02T00:00:00Z',
    requested_reviewers: [],
    ...overrides,
  };
}

test('mapGithubPullRequest: an open, non-draft, unmerged PR maps to state "open"', () => {
  const info = mapGithubPullRequest(pullRequestRaw(), []);
  assert.equal(info.state, 'open');
  assert.equal(info.number, 42);
  assert.equal(info.branch, 'feature/kan-123-login');
  assert.equal(info.baseBranch, 'main');
  assert.equal(info.author, 'alice');
  assert.equal(info.url, 'https://github.com/acme/repo/pull/42');
});

test('mapGithubPullRequest: draft: true maps to state "draft" even though GitHub\'s own state is "open"', () => {
  const info = mapGithubPullRequest(pullRequestRaw({ draft: true }), []);
  assert.equal(info.state, 'draft');
});

test('mapGithubPullRequest: a non-null merged_at maps to state "merged" regardless of draft/state', () => {
  const info = mapGithubPullRequest(pullRequestRaw({ merged_at: '2026-08-03T00:00:00Z', state: 'closed' }), []);
  assert.equal(info.state, 'merged');
});

test('mapGithubPullRequest: a closed, unmerged PR maps to state "closed"', () => {
  const info = mapGithubPullRequest(pullRequestRaw({ state: 'closed', merged_at: null }), []);
  assert.equal(info.state, 'closed');
});

test('mapGithubPullRequest: a null author maps to "unknown" rather than throwing', () => {
  const info = mapGithubPullRequest(pullRequestRaw({ user: null }), []);
  assert.equal(info.author, 'unknown');
});

test('mapGithubPullRequest: threads reviewState through from the reviews list', () => {
  const info = mapGithubPullRequest(pullRequestRaw(), [review({ user: 'bob', state: 'APPROVED' })]);
  assert.equal(info.reviewState, 'approved');
});

test('mapGithubBranch: combines the raw branch shape with a separately-fetched commit date', () => {
  const raw: GithubBranchRaw = { name: 'feature/kan-9-renewal', commit: { sha: 'abc123', url: 'https://api.github.com/x' } };
  const info = mapGithubBranch(raw, '2026-07-15T12:00:00Z');
  assert.deepEqual(info, {
    name: 'feature/kan-9-renewal',
    lastCommitSha: 'abc123',
    lastCommitDate: '2026-07-15T12:00:00Z',
  });
});
