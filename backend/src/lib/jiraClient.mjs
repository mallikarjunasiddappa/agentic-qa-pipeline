/**
 * Minimal Jira REST client for backend/ - only what the AI Queue's resolve action needs: file a
 * real bug from an approved draftBugReport (Phase A/B), or file a real story from an approved
 * story draft (Phase D, "AI-Assisted Scrum and SDLC Console - Development Plan," docs/planning/ -
 * "turning an approved queue item into a real Jira ticket"). Deliberately NOT a port of the CLI's
 * full src/pipeline/jira/jiraClient.ts (getIssue/transitions/comments, per-tenant secrets
 * resolution via requireTenantEnv) - backend/ only ever creates issues from these two call sites,
 * it doesn't read tickets or manage transitions, and today has no per-tenant secrets provider of
 * its own (see loadJiraConfigFromEnv()'s comment below). Mirrors the CLI client's
 * textToAdf()/createBug() request shape exactly (same ADF conversion, same
 * fields.project/issuetype/summary/description/labels body) so the two clients produce identical
 * Jira API calls for the same BugReport input.
 *
 * Factory-wrapped and constructor-injected into createApp() (see app.mjs), same shape as every
 * other backend/src/repositories/*.mjs - so route logic can be tested against a fake
 * implementation of this same interface without real Jira credentials or network access. See
 * src/app.test.mjs's queue-resolve-with-Jira tests and backend/README.md's "AI Queue" section for
 * how the real axios call itself was verified (against a real local HTTP server, not Jira itself -
 * this repo has no real Jira credentials to test against).
 *
 * Interface: { createBug(bugReport): Promise<{ key, url }>, createStory(storyDraft): Promise<{ key, url }> }
 */
import axios from 'axios';

function textToAdf(text) {
  return {
    type: 'doc',
    version: 1,
    content: text
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => ({ type: 'paragraph', content: [{ type: 'text', text: line }] })),
  };
}

export function createJiraClient({ baseUrl, email, apiToken, projectKey }) {
  const cleanBaseUrl = baseUrl.replace(/\/$/, '');
  const http = axios.create({
    baseURL: `${cleanBaseUrl}/rest/api/3`,
    auth: { username: email, password: apiToken },
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
  });

  return {
    /** bugReport is BugReportSchema-shaped ({ summary, description, labels }) - same input type
     * src/pipeline/jira/jiraClient.ts's createBug() accepts, so a QueueItem's draftBugReport
     * payload (built by scripts/lib/buildQueueProducerRows.mjs) can be passed straight through. */
    async createBug(bugReport) {
      const { data } = await http.post('/issue', {
        fields: {
          project: { key: projectKey },
          issuetype: { name: 'Bug' },
          summary: bugReport.summary,
          description: textToAdf(bugReport.description),
          labels: bugReport.labels ?? [],
        },
      });
      return { key: data.key, url: `${cleanBaseUrl}/browse/${data.key}` };
    },

    /** storyDraft is { title, description, acceptanceCriteria } - exactly the shape --stage
     * draft-story's payload (src/pipeline/storyDraft/draftStory.ts) already has, so a QueueItem's
     * payload can be passed straight through, same "no shape translation needed" convention
     * createBug() above already follows for draftBugReport. Jira's Story issue type has no
     * universal native acceptance-criteria field across instances, so acceptanceCriteria is
     * appended to the description body as a plain checklist rather than dropped - the same
     * "surface it, don't lose it" posture this whole pipeline takes with data it can't map
     * 1:1 onto a target system's schema. */
    async createStory(storyDraft) {
      const acceptanceCriteriaText =
        storyDraft.acceptanceCriteria && storyDraft.acceptanceCriteria.length > 0
          ? `\n\nAcceptance Criteria:\n${storyDraft.acceptanceCriteria.map((c) => `- ${c}`).join('\n')}`
          : '';
      const { data } = await http.post('/issue', {
        fields: {
          project: { key: projectKey },
          issuetype: { name: 'Story' },
          summary: storyDraft.title,
          description: textToAdf(`${storyDraft.description}${acceptanceCriteriaText}`),
        },
      });
      return { key: data.key, url: `${cleanBaseUrl}/browse/${data.key}` };
    },
  };
}

/**
 * Reads Jira config from env - a flat, single-tenant read (JIRA_BASE_URL/JIRA_EMAIL/
 * JIRA_API_TOKEN/JIRA_PROJECT_KEY), same posture as DATABASE_URL, NOT the CLI's per-tenant
 * envFileTenantKey()/secretsProvider.ts resolution. backend/ is still single-tenant-per-deployment
 * as of Phase 2 (see the ADR) - if/when it needs real per-tenant Jira credentials, that's a second,
 * later change, not assumed here.
 *
 * Returns null (does not throw) when any var is unset, so server.mjs can start with Jira
 * unconfigured and the resolve route can return a clear 503 instead of the process crashing at
 * boot - see app.mjs's call site.
 */
export function loadJiraConfigFromEnv(env = process.env) {
  const { JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN, JIRA_PROJECT_KEY } = env;
  if (!JIRA_BASE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN || !JIRA_PROJECT_KEY) return null;
  return { baseUrl: JIRA_BASE_URL, email: JIRA_EMAIL, apiToken: JIRA_API_TOKEN, projectKey: JIRA_PROJECT_KEY };
}
