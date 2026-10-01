import fs from 'node:fs';
import path from 'node:path';
import { tenantDataPath } from '../../config/tenantContext';
import { PullRequestInfo, PullRequestReviewState, BranchInfo } from '../vcsClient';

export function REPORT_JSON_PATH(): string {
  return tenantDataPath('devStatus', 'report.json');
}
export function REPORT_MD_PATH(): string {
  return tenantDataPath('devStatus', 'report.md');
}

/**
 * Extracts this tenant's Jira ticket key from a branch (or PR head-branch) name, per
 * config/tenants/<tenantId>/scrum.json's vcs.branchKeyConvention. That field is deliberately free
 * text in ScrumVcsConfigSchema (varies per tenant, not a fixed enum) - but today, only one actual
 * convention exists for any real tenant ("lowercase ticket key anywhere in branch name", this
 * tenant's own scrum.json value), so that's the only algorithm implemented here. This function
 * does NOT parse branchKeyConvention's text as a mini-DSL; it's read by a human maintaining
 * scrum.json, not by this code. A future tenant needing a genuinely different convention (e.g. a
 * required prefix position, or a non-Jira key shape) needs a code change here, not a config-only
 * change - flagged explicitly rather than silently pretending this handles every convention.
 *
 * `projectKey` is this tenant's Jira project key (JIRA_PROJECT_KEY, the same env var jiraClient.ts
 * already requires) - not read from scrum.json, since it's a Jira-connection identifier, not a
 * scrum-config field. Matching is case-insensitive (branch names use the lowercase form; Jira's
 * own canonical form is uppercase) and returns the ticket key normalized to uppercase - e.g.
 * "PROJ-123", regardless of the branch's own casing - so the report's ticketKey values are always
 * directly usable as real Jira keys. Returns null (never throws) when no match is found or
 * `projectKey` is empty - "no ticket key here" is a legitimate, expected outcome (a chore branch,
 * a typo, a hotfix with no ticket), not an error.
 */
export function matchBranchToTicket(branchName: string, projectKey: string): string | null {
  if (!projectKey) return null;
  const escapedKey = projectKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = branchName.match(new RegExp(`${escapedKey}-(\\d+)`, 'i'));
  return match ? `${projectKey.toUpperCase()}-${match[1]}` : null;
}

export interface DevStatusPullRequestEntry {
  number: number;
  title: string;
  branch: string;
  baseBranch: string;
  state: PullRequestInfo['state'];
  reviewState: PullRequestReviewState;
  author: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  // null means this PR's branch didn't match any known ticket key - deliberately kept in the
  // report (not dropped) and called out in its own "unlinked" section, since a PR with no ticket
  // could be either noise (a chore/dependency-bump branch) or a real process gap (a ticket-linked
  // PR whose branch was misnamed) - the report surfaces it and lets a human judge which, rather
  // than silently omitting it and hiding a possible gap.
  ticketKey: string | null;
}

export interface DevStatusBranchEntry {
  name: string;
  lastCommitSha: string;
  lastCommitDate: string;
  ticketKey: string | null;
}

export interface DevStatusReport {
  generatedAt: string;
  repo: string;
  pullRequests: DevStatusPullRequestEntry[];
  // Count of pullRequests entries above with ticketKey === null - surfaced as its own field so
  // JSON/Markdown consumers don't need to re-filter the array to answer "how much is unlinked?".
  unlinkedPullRequestCount: number;
  // Every branch that currently has no open PR against it, matched to a ticket key the same way.
  // Deliberately NOT filtered by a "staleness" age threshold - scrum.json has no such setting
  // configured for dev-status (blockerEscalation.idleDaysThreshold is a different stage's
  // concept, Phase 2's blocker-scan, and reusing it here would silently borrow a threshold this
  // stage was never asked to apply) - so every branch's own lastCommitDate is surfaced instead,
  // letting a human reading the report judge staleness themselves rather than this stage guessing
  // an unconfigured cutoff.
  branchesWithoutOpenPr: DevStatusBranchEntry[];
}

/**
 * Pure mapper: raw PullRequestInfo/BranchInfo (already provider-neutral, from vcsClient) plus this
 * tenant's projectKey -> the report's own DevStatusReport shape. Takes `now` as a parameter (not
 * `new Date()` internally) for the same determinism-in-tests reason as buildCostReport/
 * buildHealingReport.
 *
 * Branches "without an open PR" excludes any branch matching a currently-open PR's own baseBranch
 * (e.g. "master"/"main") - without this, a repo's trunk branch would appear in every single
 * dev-status run as a "branch nobody opened a PR for", which is never meaningful (nobody opens a
 * PR from trunk into itself) and would be permanent noise. This is a heuristic, not a real
 * "default branch" lookup (GitHub's /repos/{repo} default_branch field isn't fetched anywhere in
 * this pipeline yet) - a repo with zero currently-open PRs has no baseBranch to exclude by, so its
 * trunk branch would show up here in that edge case. Flagged as a known limitation rather than
 * adding a new API call to close a gap that only matters when a repo has no open PRs at all.
 */
export function buildDevStatusReport(
  pullRequests: PullRequestInfo[],
  branches: BranchInfo[],
  repo: string,
  projectKey: string,
  now: Date = new Date(),
): DevStatusReport {
  const prEntries: DevStatusPullRequestEntry[] = pullRequests.map((pr) => ({
    number: pr.number,
    title: pr.title,
    branch: pr.branch,
    baseBranch: pr.baseBranch,
    state: pr.state,
    reviewState: pr.reviewState,
    author: pr.author,
    url: pr.url,
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    ticketKey: matchBranchToTicket(pr.branch, projectKey),
  }));

  const prBranchNames = new Set(pullRequests.map((pr) => pr.branch));
  const baseBranchNames = new Set(pullRequests.map((pr) => pr.baseBranch));

  const branchesWithoutOpenPr: DevStatusBranchEntry[] = branches
    .filter((b) => !prBranchNames.has(b.name) && !baseBranchNames.has(b.name))
    .map((b) => ({
      name: b.name,
      lastCommitSha: b.lastCommitSha,
      lastCommitDate: b.lastCommitDate,
      ticketKey: matchBranchToTicket(b.name, projectKey),
    }));

  return {
    generatedAt: now.toISOString(),
    repo,
    pullRequests: prEntries,
    unlinkedPullRequestCount: prEntries.filter((pr) => pr.ticketKey === null).length,
    branchesWithoutOpenPr,
  };
}

function buildDevStatusReportMarkdown(report: DevStatusReport): string {
  const lines: string[] = [
    `# Dev Status Report — ${report.repo}`,
    '',
    `Generated: ${report.generatedAt}`,
    '',
  ];

  lines.push(
    `## Open pull requests (${report.pullRequests.length} total, ` +
      `${report.unlinkedPullRequestCount} unlinked)`,
    '',
  );
  if (report.pullRequests.length === 0) {
    lines.push('_No open pull requests._', '');
  } else {
    lines.push('| PR | Title | Branch → Base | Review | Ticket |', '|---|---|---|---|---|');
    for (const pr of report.pullRequests) {
      const ticket = pr.ticketKey ?? '_unlinked_';
      lines.push(
        `| [#${pr.number}](${pr.url}) | ${pr.title} | ${pr.branch} → ${pr.baseBranch} | ` +
          `${pr.reviewState} | ${ticket} |`,
      );
    }
    lines.push('');
  }

  lines.push(`## Branches without an open PR (${report.branchesWithoutOpenPr.length})`, '');
  if (report.branchesWithoutOpenPr.length === 0) {
    lines.push('_None._', '');
  } else {
    lines.push('| Branch | Last commit | Ticket |', '|---|---|---|');
    for (const branch of report.branchesWithoutOpenPr) {
      const ticket = branch.ticketKey ?? '_unlinked_';
      lines.push(`| ${branch.name} | ${branch.lastCommitDate} | ${ticket} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

export function writeDevStatusReports(
  report: DevStatusReport,
  paths: { reportJsonPath: string; reportMdPath: string } = {
    reportJsonPath: REPORT_JSON_PATH(),
    reportMdPath: REPORT_MD_PATH(),
  },
): { reportJsonPath: string; reportMdPath: string } {
  const { reportJsonPath, reportMdPath } = paths;
  fs.mkdirSync(path.dirname(reportJsonPath), { recursive: true });
  fs.writeFileSync(reportJsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
  fs.writeFileSync(reportMdPath, buildDevStatusReportMarkdown(report), 'utf-8');
  return { reportJsonPath, reportMdPath };
}
