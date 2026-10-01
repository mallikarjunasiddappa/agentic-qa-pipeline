import { getJiraClient } from '../jira/jiraClient';
import { JiraAdapter } from './jiraAdapter';
import { RequirementsSource } from './types';

export type { RequirementsSource, RequirementSummary, RequirementTransition, BugReportInput } from './types';

let source: RequirementsSource | null = null;

/**
 * Returns the configured requirements-source provider's client. Same shape as
 * testmgmt/index.ts's getTestManagementClient() - only 'jira' exists today (no provider-selection
 * switch needed yet, unlike TMS's qase/testiny split), but the exported type is the
 * provider-agnostic RequirementsSource, not JiraAdapter, so call sites never depend on Jira
 * specifically and a second provider later is additive here, not a call-site rewrite.
 */
export async function getRequirementsSource(): Promise<RequirementsSource> {
  if (source) return source;
  source = new JiraAdapter(await getJiraClient());
  return source;
}
