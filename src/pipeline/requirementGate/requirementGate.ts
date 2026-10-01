import { RequirementGap } from '../types/schemas';

/**
 * Comment posted to the Jira ticket itself when Gate 0 finds the requirement isn't clear enough
 * to generate scenarios from without guessing - same "surface it where the ticket author already
 * is" reasoning as the drift-check comments in traceability/jiraNotify.ts, not a new pattern.
 */
export function buildRequirementGapComment(gaps: RequirementGap[]): string {
  return [
    'The Planning Agent paused before generating test scenarios for this ticket - it found the ' +
      'requirement unclear enough that generating from it would mean guessing at intent rather ' +
      'than testing what was actually asked for:',
    '',
    ...gaps.map((gap) => `- ${gap.description}`),
    '',
    'Update the ticket with the missing detail and the check will re-run automatically, or if ' +
      "these don't actually block scenario generation, a human can override with " +
      '`npm run pipeline -- --stage approve-requirements --issue <key>`.',
  ].join('\n');
}
