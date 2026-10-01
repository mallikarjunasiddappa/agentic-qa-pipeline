import { JiraClient } from '../jira/jiraClient';
import { RequirementsSource, RequirementSummary, RequirementTransition, BugReportInput } from './types';

/**
 * Wraps the existing JiraClient (auth, axios instance, ADF<->plaintext translation all stay
 * inside JiraClient, unchanged) behind the provider-agnostic RequirementsSource interface - same
 * pattern QaseAdapter/TestinyAdapter already use for TestManagementClient. getIssue() +
 * extractDescription() (two JiraClient calls) collapse into one getRequirement() call here; the
 * other four methods pass straight through with no shape translation needed.
 */
export class JiraAdapter implements RequirementsSource {
  constructor(private readonly client: JiraClient) {}

  async getRequirement(key: string): Promise<RequirementSummary> {
    const issue = await this.client.getIssue(key);
    const summary = this.client.extractDescription(issue);
    return { key: summary.key, summary: summary.summary, description: summary.description };
  }

  async createBug(bug: BugReportInput): Promise<{ key: string; url: string }> {
    return this.client.createBug(bug);
  }

  async addComment(key: string, text: string): Promise<void> {
    return this.client.addComment(key, text);
  }

  async getTransitions(key: string): Promise<RequirementTransition[]> {
    return this.client.getTransitions(key);
  }

  async transitionRequirement(key: string, transitionId: string): Promise<void> {
    return this.client.transitionIssue(key, transitionId);
  }
}
