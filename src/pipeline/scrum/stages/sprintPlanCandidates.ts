import { SprintIssueSnapshot } from '../agileClient';

/**
 * Deterministic (non-LLM) candidate selection for --stage draft-sprint-plan. Candidates are the
 * issues Jira already shows in a board's next not-yet-started ("future") sprint - i.e. whatever a
 * human has already drafted into it via Jira's own backlog/sprint UI - not this pipeline's
 * invention of a backlog ranking. This function only decides which of those candidates fit inside
 * the board's own recent velocity (velocityReport.ts's averageVelocity), in the order Jira
 * returned them; it does not re-prioritize or re-rank them.
 *
 * DELIBERATELY NOT AN LLM CALL: this is exactly the "compute an aggregate/arithmetic" job
 * askEngine.ts's own real bug history (two live-run bugs: wrong relative-date arithmetic, and
 * mischaracterizing a "not-done" total) says never to hand to a model. The point budget and
 * selected/deferred split are computed here, in code, and handed to draftSprintPlanNarrative.ts
 * only to be narrated in prose - never recomputed there.
 */

export interface SprintPlanSelection {
  pointBudget: number;
  selected: SprintIssueSnapshot[];
  deferred: SprintIssueSnapshot[];
  selectedStoryPoints: number;
  // Unestimated candidates (storyPoints === null) are always deferred, never auto-selected - an
  // unknown cost can't be weighed against a point budget - and counted here separately so a
  // caller/narration can flag them explicitly rather than let them silently vanish into "deferred."
  unestimatedCandidateCount: number;
}

export function selectSprintPlanCandidates(
  candidates: SprintIssueSnapshot[],
  pointBudget: number,
): SprintPlanSelection {
  const selected: SprintIssueSnapshot[] = [];
  const deferred: SprintIssueSnapshot[] = [];
  let selectedStoryPoints = 0;
  let unestimatedCandidateCount = 0;

  for (const issue of candidates) {
    if (issue.storyPoints === null) {
      unestimatedCandidateCount += 1;
      deferred.push(issue);
      continue;
    }
    if (selectedStoryPoints + issue.storyPoints <= pointBudget) {
      selected.push(issue);
      selectedStoryPoints += issue.storyPoints;
    } else {
      deferred.push(issue);
    }
  }

  return { pointBudget, selected, deferred, selectedStoryPoints, unestimatedCandidateCount };
}
