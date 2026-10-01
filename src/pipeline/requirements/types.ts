// Provider-agnostic requirements-source interface. Same role for issue trackers that
// testmgmt/types.ts's TestManagementClient plays for test management providers: today only Jira
// has an adapter (JiraAdapter, wrapping the existing jira/jiraClient.ts), but the shape is
// deliberately provider-agnostic from the start so a second provider (Linear, Azure DevOps, etc.)
// is a new adapter here, not a rewrite - see docs/planning/Issue Tracker Abstraction Future Plan.docx
// for the provider-naming decision this already anticipates.

export interface RequirementSummary {
  key: string; // ticket/issue key (e.g. "SCRUM-18")
  summary: string;
  description: string; // plain text, already flattened from whatever rich-text format the source uses
}

export interface RequirementTransition {
  id: string;
  name: string;
}

export interface BugReportInput {
  summary: string;
  description: string;
  labels: string[];
}

/**
 * Provider-agnostic surface every requirements-source adapter implements. Grounded directly in
 * jira/jiraClient.ts's real, already-in-use methods (getIssue+extractDescription collapse into
 * one getRequirement call here; createBug/addComment/getTransitions/transitionIssue map through
 * near 1:1) - not invented from scratch.
 */
export interface RequirementsSource {
  getRequirement(key: string): Promise<RequirementSummary>;
  createBug(bug: BugReportInput): Promise<{ key: string; url: string }>;
  addComment(key: string, text: string): Promise<void>;
  getTransitions(key: string): Promise<RequirementTransition[]>;
  transitionRequirement(key: string, transitionId: string): Promise<void>;
}
