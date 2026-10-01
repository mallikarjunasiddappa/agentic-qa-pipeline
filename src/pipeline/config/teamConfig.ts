/**
 * Small pure helpers for running this pipeline with more than one person - see README's Team
 * Usage section. Deliberately kept as plain functions taking explicit args (not reading
 * process.env internally) so they're testable without env mocking, same pattern as the
 * buildXReport()/buildXMessage() pure-builder functions elsewhere in this project.
 */

/**
 * Who's performing the current CLI invocation, for attribution on workflow gate records
 * (requirementsClearedBy/scenariosApprovedBy/testCasesApprovedBy). Falls back to the Jira
 * identity since every team member already needs their own dedicated JIRA_EMAIL - explicit
 * PIPELINE_OPERATOR only needs setting when it should read as something else, e.g. Jenkins
 * wanting "ci-bot" rather than whatever account its own JIRA_EMAIL points at. Returns undefined
 * (not a placeholder string) when neither is set, so older/anonymous records don't get a
 * misleading "unknown" baked in - callers just omit the field in that case.
 */
export function resolveOperator(
  pipelineOperator: string | undefined,
  jiraEmail: string | undefined,
): string | undefined {
  return pipelineOperator || jiraEmail || undefined;
}

/**
 * Whether a pipeline-report/drift-check run is allowed to post to Slack. CI is unconditionally
 * allowed (that's the point of the notification - an unattended scheduled run needs somewhere to
 * surface its result). Local runs are opt-in via SLACK_NOTIFY_LOCAL=true - without this gate,
 * every team member sanity-checking `npm run pipeline:report` locally before pushing would post
 * to the same shared channel every time, which stops being a useful signal fast once more than
 * one person is doing it.
 */
export function allowSlackNotify(isCi: boolean, slackNotifyLocal: string | undefined): boolean {
  return isCi || slackNotifyLocal === 'true';
}

/**
 * Same CI-only-by-default gate as allowSlackNotify() above, applied to blocker-scan's email
 * channel (SMTP_NOTIFY_LOCAL) instead of Slack (SLACK_NOTIFY_LOCAL). Kept as its own,
 * identically-shaped function rather than reusing allowSlackNotify() directly for email too -
 * that function's name is Slack-specific, and a call site like
 * allowSlackNotify(isCi, env.SMTP_NOTIFY_LOCAL) would read as a bug at a glance even though the
 * logic is identical. A future channel needing the same CI-only gate should get its own
 * analogously-named function here rather than either of these two being stretched to cover it.
 */
export function allowEmailNotify(isCi: boolean, smtpNotifyLocal: string | undefined): boolean {
  return isCi || smtpNotifyLocal === 'true';
}
