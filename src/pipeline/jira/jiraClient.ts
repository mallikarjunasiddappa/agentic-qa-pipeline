import axios, { AxiosInstance } from 'axios';
import { requireTenantEnv } from '../config/env';
import { JiraIssueSummary, JiraIssueSummarySchema, BugReport } from '../types/schemas';

interface AdfNode {
  type: string;
  text?: string;
  content?: AdfNode[];
}

export interface JiraIssueRaw {
  key: string;
  fields: {
    summary: string;
    description: AdfNode | null;
    [key: string]: unknown;
  };
}

/**
 * Shape of one issue in /rest/api/3/search's response (searchByFixVersion, Phase E) - deliberately
 * a separate type from AgileIssueRaw (agileClient.ts): same underlying Jira instance, but a
 * different REST surface (core API v3 vs Agile API) with its own response shape, same "one raw
 * type per API surface, translate at the client boundary" split every other client pairing in this
 * codebase already follows (contrast JiraIssueRaw above vs AgileIssueRaw).
 */
export interface JiraSearchIssueRaw {
  key: string;
  fields: {
    summary: string;
    status: { name: string; statusCategory?: { key: string } };
    assignee: { displayName: string } | null;
  };
}

function adfToPlainText(node: AdfNode | null | undefined): string {
  if (!node) return '';
  if (node.type === 'text') return node.text ?? '';
  const children = (node.content ?? []).map(adfToPlainText).join('');
  if (node.type === 'paragraph' || node.type === 'heading') return `${children}\n`;
  return children;
}

function textToAdf(text: string) {
  return {
    type: 'doc',
    version: 1,
    content: text
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => ({
        type: 'paragraph',
        content: [{ type: 'text', text: line }],
      })),
  };
}

/**
 * Distinguishes a Jira failure that REACHED Jira (an HTTP status came back - auth, permission, or a
 * missing/invisible issue) from one that never reached it (a network/egress failure with no response
 * at all). The two are nearly identical in a raw AxiosError stack, which is exactly how a Jira
 * permission 404 once got misdiagnosed as "no egress" and sent an agent down the wrong path.
 * Translating at the client boundary means every stage - and every agent reading pipeline output -
 * gets an unambiguous cause instead of a bare "Request failed with status code N".
 *
 * Pure and status-driven so it is unit-testable without a live Jira or a real axios error: the
 * interceptor in the constructor extracts (status, code, errorMessages, method, url) and hands
 * them here.
 */
export type JiraErrorKind = 'network' | 'auth' | 'permission' | 'not-found' | 'server' | 'http';

export interface JiraFailureInput {
  status: number | null; // null = no HTTP response ever received (never reached Jira)
  code?: string; // axios/node code for the no-response case, e.g. ECONNREFUSED, ETIMEDOUT, ENOTFOUND
  jiraMessages?: string[]; // Jira's own response.data.errorMessages, when present
  method: string;
  url: string;
}

export function classifyJiraFailure(
  input: JiraFailureInput,
): { kind: JiraErrorKind; message: string } {
  const op = `${input.method.toUpperCase()} ${input.url}`.trim();
  const jira =
    input.jiraMessages && input.jiraMessages.length > 0
      ? ` Jira said: ${input.jiraMessages.join('; ')}.`
      : '';
  const reached =
    ' The request REACHED Jira and got an HTTP response, so this is NOT a network or egress problem.';

  if (input.status === null) {
    const detail = input.code ? ` (${input.code})` : '';
    return {
      kind: 'network',
      message:
        `Could not reach Jira${detail} for ${op} - no HTTP response came back. This is a network/egress ` +
        `problem, not a credential or permission one. If you are running in a restricted sandbox that ` +
        `cannot reach Jira, hand this stage off to run where Jira is reachable (see AGENTS.md).`,
    };
  }
  if (input.status === 401) {
    return {
      kind: 'auth',
      message:
        `Jira authentication failed (401) for ${op}.${jira}${reached} Check that JIRA_EMAIL and ` +
        `JIRA_API_TOKEN in your .env belong to the SAME account and the token is current ` +
        `(id.atlassian.com -> Security -> API tokens).`,
    };
  }
  if (input.status === 403) {
    return {
      kind: 'permission',
      message:
        `Jira denied access (403) for ${op}.${jira}${reached} The JIRA_EMAIL account authenticated but ` +
        `lacks permission for this action.`,
    };
  }
  if (input.status === 404) {
    return {
      kind: 'not-found',
      message:
        `Jira returned 404 for ${op}.${jira}${reached} Either the issue does not exist, or the ` +
        `JIRA_EMAIL account lacks Browse permission on its project. Confirm the key is correct and that ` +
        `the .env account can open it in a browser.`,
    };
  }
  if (input.status >= 500) {
    return {
      kind: 'server',
      message:
        `Jira returned a server error (${input.status}) for ${op}.${jira}${reached} This is a Jira-side ` +
        `or transient error, not a credential or egress problem - retry shortly.`,
    };
  }
  return {
    kind: 'http',
    message: `Jira returned ${input.status} for ${op}.${jira}${reached}`,
  };
}

/**
 * Thrown by every JiraClient method in place of a raw AxiosError. Carries the classified `kind` and
 * `status` (null when Jira was never reached) so callers can branch without re-parsing a stack, and
 * keeps the original error as `cause` for deep debugging. `reachedJira` is the single bit that
 * separates "can't reach" from "reached but refused".
 */
export class JiraApiError extends Error {
  readonly kind: JiraErrorKind;
  readonly status: number | null;
  readonly reachedJira: boolean;
  readonly method: string;
  readonly url: string;
  constructor(args: {
    kind: JiraErrorKind;
    status: number | null;
    method: string;
    url: string;
    message: string;
    cause?: unknown;
  }) {
    super(args.message);
    this.name = 'JiraApiError';
    this.kind = args.kind;
    this.status = args.status;
    this.reachedJira = args.status !== null;
    this.method = args.method;
    this.url = args.url;
    if (args.cause !== undefined) (this as { cause?: unknown }).cause = args.cause;
  }
}

export class JiraClient {
  private http: AxiosInstance;
  private baseUrl: string;

  // Constructor is now private - credentials must be resolved async (requireTenantEnv is async
  // since the Secrets-manager fix), so construction goes through the static async create()
  // factory below instead of `new JiraClient()`.
  private constructor(baseUrl: string, email: string, apiToken: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.http = axios.create({
      baseURL: `${this.baseUrl}/rest/api/3`,
      auth: { username: email, password: apiToken },
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    });

    // Translate every failed Jira call into a JiraApiError with an unambiguous cause: reached-but-
    // refused (an HTTP status came back) vs never-reached (a network/egress failure, no response).
    // See classifyJiraFailure above for why this boundary exists.
    this.http.interceptors.response.use(
      (response) => response,
      (error: unknown) => {
        if (axios.isAxiosError(error)) {
          const status = error.response?.status ?? null;
          const data = error.response?.data as { errorMessages?: unknown } | undefined;
          const jiraMessages =
            Array.isArray(data?.errorMessages) &&
            data!.errorMessages.every((m) => typeof m === 'string')
              ? (data!.errorMessages as string[])
              : undefined;
          const method = error.config?.method ?? 'get';
          const url = error.config?.url ?? '';
          const { kind, message } = classifyJiraFailure({
            status,
            code: error.code,
            jiraMessages,
            method,
            url,
          });
          return Promise.reject(
            new JiraApiError({ kind, status, method: method.toUpperCase(), url, message, cause: error }),
          );
        }
        return Promise.reject(error);
      },
    );
  }

  static async create(): Promise<JiraClient> {
    const baseUrl = await requireTenantEnv('JIRA_BASE_URL', 'Jira Agent');
    const email = await requireTenantEnv('JIRA_EMAIL', 'Jira Agent');
    const apiToken = await requireTenantEnv('JIRA_API_TOKEN', 'Jira Agent');
    return new JiraClient(baseUrl, email, apiToken);
  }

  async getIssue(key: string): Promise<JiraIssueRaw> {
    const { data } = await this.http.get<JiraIssueRaw>(`/issue/${key}`, {
      params: { fields: 'summary,description,issuetype,status' },
    });
    return data;
  }

  extractDescription(issue: JiraIssueRaw): JiraIssueSummary {
    return JiraIssueSummarySchema.parse({
      key: issue.key,
      summary: issue.fields.summary,
      description: adfToPlainText(issue.fields.description).trim(),
    });
  }

  async createBug(bug: BugReport): Promise<{ key: string; url: string }> {
    const projectKey = await requireTenantEnv('JIRA_PROJECT_KEY', 'Jira Agent');
    const { data } = await this.http.post<{ key: string }>('/issue', {
      fields: {
        project: { key: projectKey },
        issuetype: { name: 'Bug' },
        summary: bug.summary,
        description: textToAdf(bug.description),
        labels: bug.labels,
      },
    });
    return { key: data.key, url: `${this.baseUrl}/browse/${data.key}` };
  }

  /**
   * Phase E ("AI-Assisted Scrum and SDLC Console - Development Plan," docs/planning/) - "Release
   * Stage," the source deck's own "highest caution" duty: read-only summarization of a fixVersion's
   * issues, never a write. JQL search via Jira's core REST API v3 (/rest/api/3/search, not the
   * Agile API AgileClient.ts already wraps - fixVersion isn't a sprint-board concept, it's a
   * project-release concept, so this belongs on the same client that already reads plain issues).
   * projectKey scoping matches every other stage that already requires JIRA_PROJECT_KEY
   * (devStatus.ts's own doc comment has the same reasoning: without a known project key this
   * search would span every project the credentials can see, not just this tenant's).
   *
   * fixVersion is embedded into the JQL string, not a bind parameter (Jira's REST search has no
   * parameterized-query mechanism) - the one double-quote character JQL string literals care about
   * is escaped, same minimal-but-real precaution as any other string-interpolated query surface in
   * this codebase.
   */
  async searchByFixVersion(fixVersion: string): Promise<JiraSearchIssueRaw[]> {
    const projectKey = await requireTenantEnv('JIRA_PROJECT_KEY', 'Release Summary Stage');
    const escapedFixVersion = fixVersion.replace(/"/g, '\\"');
    const jql = `project = "${projectKey}" AND fixVersion = "${escapedFixVersion}"`;
    const { data } = await this.http.get<{ issues: JiraSearchIssueRaw[] }>('/search', {
      params: { jql, fields: 'summary,status,assignee', maxResults: 200 },
    });
    return data.issues;
  }

  async addComment(key: string, text: string): Promise<void> {
    await this.http.post(`/issue/${key}/comment`, { body: textToAdf(text) });
  }

  async getTransitions(key: string): Promise<{ id: string; name: string }[]> {
    const { data } = await this.http.get<{ transitions: { id: string; name: string }[] }>(
      `/issue/${key}/transitions`,
    );
    return data.transitions.map((t) => ({ id: t.id, name: t.name }));
  }

  async transitionIssue(key: string, transitionId: string): Promise<void> {
    await this.http.post(`/issue/${key}/transitions`, { transition: { id: transitionId } });
  }
}

let client: JiraClient | null = null;
export async function getJiraClient(): Promise<JiraClient> {
  if (!client) client = await JiraClient.create();
  return client;
}
