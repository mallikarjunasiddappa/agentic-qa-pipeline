import axios, { AxiosInstance } from 'axios';
import { requireTenantEnv } from '../config/env';

export interface AgileSprintRaw {
  id: number;
  name: string;
  state: 'active' | 'closed' | 'future';
  startDate?: string;
  endDate?: string;
}

export interface AgileIssueRaw {
  key: string;
  fields: {
    summary: string;
    status: { name: string; statusCategory?: { key: string } };
    assignee: { displayName: string; emailAddress?: string } | null;
    // Jira's own last-modified timestamp for this issue (ISO 8601, e.g.
    // "2026-08-15T09:30:00.000+0000") - a core Jira field, always present, not something an
    // instance can omit the way assignee.emailAddress can. Added for blocker-scan (Phase 2): the
    // idle-days computation this stage needs (see stages/blockerScan.ts's computeIdleDays) is
    // "how long since this issue last changed," and `updated` is Jira's own answer to that -
    // recomputing it from activity/changelog history would be a much heavier API surface for the
    // same signal.
    updated: string;
    // Story points live under a per-instance custom field id (this tenant's is
    // customfield_10016, config/tenants/default/scrum.json's storyPointsField) - indexed
    // dynamically since the field key isn't known until the caller passes it in.
    [customFieldKey: string]: unknown;
  };
}

export interface SprintInfo {
  id: number;
  name: string;
  state: 'active' | 'closed' | 'future';
  startDate?: string;
  endDate?: string;
}

// 'unknown' covers a status whose statusCategory Jira didn't return (some older/misconfigured
// workflows) - deliberately not folded into one of the three real categories, since guessing
// wrong here (e.g. treating an unknown status as "done") would misreport a snapshot rather than
// visibly flag the gap.
export type SprintIssueStatusCategory = 'new' | 'indeterminate' | 'done' | 'unknown';

export interface SprintIssueSnapshot {
  key: string;
  summary: string;
  status: string;
  statusCategory: SprintIssueStatusCategory;
  assignee: string | null;
  // Present only when Jira's API actually returned it - see mapSprintIssue's comment on why an
  // assignee's email can legitimately be absent even when the assignee themselves is not.
  assigneeEmail?: string;
  // null (not 0) when the story-points field is missing/blank on this issue, so a caller can tell
  // "genuinely estimated at zero" apart from "never estimated" - collapsing the two into 0 would
  // make a snapshot's point totals look more complete than the sprint actually is.
  storyPoints: number | null;
  // Jira's raw fields.updated timestamp, carried through unchanged (not parsed/reformatted here -
  // see AgileIssueRaw.fields.updated's own comment). Required, not optional, since Jira always
  // returns this field - unlike assigneeEmail, there's no real-world case where it's legitimately
  // absent. blocker-scan (Phase 2) is the first consumer; sprint-status/standup-digest simply
  // don't read it.
  updated: string;
}

function mapStatusCategory(key: string | undefined): SprintIssueStatusCategory {
  if (key === 'new' || key === 'indeterminate' || key === 'done') return key;
  return 'unknown';
}

export function mapSprint(raw: AgileSprintRaw): SprintInfo {
  return {
    id: raw.id,
    name: raw.name,
    state: raw.state,
    startDate: raw.startDate,
    endDate: raw.endDate,
  };
}

/**
 * Maps one raw Agile API issue onto this pipeline's provider-neutral SprintIssueSnapshot shape -
 * same "translate at the client boundary only" split as vcsClient/githubAdapter.ts's
 * mapGithubPullRequest.
 *
 * assigneeEmail is read straight from fields.assignee.emailAddress, which Jira Cloud omits
 * entirely when the account's contact-information visibility is set to private - a real,
 * instance-specific setting, not a bug here. A caller that needs the email (e.g. a future
 * standup-digest Slack DM) must handle it being absent; this function does not throw or
 * substitute a guessed value for it.
 */
export function mapSprintIssue(raw: AgileIssueRaw, storyPointsField: string): SprintIssueSnapshot {
  const rawPoints = raw.fields[storyPointsField];

  return {
    key: raw.key,
    summary: raw.fields.summary,
    status: raw.fields.status.name,
    statusCategory: mapStatusCategory(raw.fields.status.statusCategory?.key),
    assignee: raw.fields.assignee?.displayName ?? null,
    assigneeEmail: raw.fields.assignee?.emailAddress,
    storyPoints: typeof rawPoints === 'number' ? rawPoints : null,
    updated: raw.fields.updated,
  };
}

/**
 * Jira Agile REST API client (current-sprint snapshot only - see this module's doc note in
 * scrum-master-agent.md for why committed/completed/carried-over burndown math is explicitly out
 * of scope here and deferred to Phase 3's burndown-report instead). Reuses the same Jira Cloud
 * instance and credentials as jiraClient.ts (JIRA_BASE_URL/JIRA_EMAIL/JIRA_API_TOKEN via
 * requireTenantEnv) - this is the same Jira site, just a different REST API surface
 * (/rest/agile/1.0 instead of /rest/api/3), not a second Jira connection to configure.
 */
export class AgileClient {
  private http: AxiosInstance;

  // Constructor is now private - credentials must be resolved async (requireTenantEnv is async
  // since the Secrets-manager fix), so construction goes through the static async create()
  // factory below instead of `new AgileClient()`.
  private constructor(baseUrl: string, email: string, apiToken: string) {
    this.http = axios.create({
      baseURL: `${baseUrl}/rest/agile/1.0`,
      auth: { username: email, password: apiToken },
      headers: { Accept: 'application/json' },
    });
  }

  static async create(): Promise<AgileClient> {
    const baseUrl = (await requireTenantEnv('JIRA_BASE_URL', 'Agile Client (sprint-status)')).replace(/\/$/, '');
    const email = await requireTenantEnv('JIRA_EMAIL', 'Agile Client (sprint-status)');
    const apiToken = await requireTenantEnv('JIRA_API_TOKEN', 'Agile Client (sprint-status)');
    return new AgileClient(baseUrl, email, apiToken);
  }

  /**
   * Returns EVERY currently-active sprint on this board, not just one - a Scrum board normally
   * has exactly one, but a Kanban-with-sprints or multi-team board can legitimately have more than
   * one active at once. Deliberately not collapsed to a single "the" active sprint here: silently
   * picking one (e.g. the first returned) would misreport a board where that assumption doesn't
   * hold. The caller (the future sprint-status stage) decides how to handle more than one - same
   * "surface it, don't guess" reasoning as jira-agent's getTransitions().
   */
  async getActiveSprints(boardId: string): Promise<SprintInfo[]> {
    return this.fetchSprintsByState(boardId, 'active');
  }

  /**
   * Same as getActiveSprints, but also includes not-yet-started ('future') sprints - added for
   * groom-check-fetch (Aug 25): the Primary's stated process is "gaps get found before a ticket
   * enters the sprint," but getActiveSprints alone can't support that - a ticket moved into a
   * sprint that hasn't been Started yet is invisible to it (confirmed live: groom-check-fetch
   * returned 0 tickets for a real sprint with 3 real tickets already assigned, purely because the
   * sprint's Start button hadn't been clicked). Jira's Agile API's own `state` param accepts a
   * comma-separated list (documented behavior, not a guessed convention), so this reuses the exact
   * same endpoint/shape - just a different state filter. getActiveSprints itself is left unchanged
   * (still active-only) since sprint-status/burndown-report's "what's live right now" semantics are
   * correct as they are; only groom-check-fetch actually needs pre-start visibility.
   */
  async getActiveAndFutureSprints(boardId: string): Promise<SprintInfo[]> {
    return this.fetchSprintsByState(boardId, 'active,future');
  }

  /**
   * The N most recently closed sprints on this board, most-recent-first - added for --stage
   * draft-sprint-plan's velocity calculation (Phase C, "AI-Assisted Scrum and SDLC Console -
   * Development Plan," docs/planning/). Unlike getActiveSprints/getActiveAndFutureSprints (which
   * return every matching sprint, unbounded), this is deliberately capped: velocity is a rolling
   * average over a *recent* window, not this board's entire closed-sprint history, and an
   * unbounded fetch would pull years of sprints on a mature board for no benefit. Sorted by id
   * descending, not startDate - same reasoning as scrumDashboard.ts's own burndown/retro sprint
   * listing ("Jira sprint ids are assigned in increasing order over time, so this reads
   * newest-first without needing any date field to sort by").
   */
  async getClosedSprints(boardId: string, limit: number): Promise<SprintInfo[]> {
    const sprints = await this.fetchSprintsByState(boardId, 'closed');
    return [...sprints].sort((a, b) => b.id - a.id).slice(0, limit);
  }

  private async fetchSprintsByState(boardId: string, state: string): Promise<SprintInfo[]> {
    const { data } = await this.http.get<{ values: AgileSprintRaw[] }>(`/board/${boardId}/sprint`, {
      params: { state },
    });
    return data.values.map(mapSprint);
  }

  /**
   * Returns every issue in the given sprint, already mapped onto SprintIssueSnapshot - callers
   * never see Jira's raw Agile API issue shape. `storyPointsField` is the tenant's configured
   * custom field id (scrum.json's storyPointsField, e.g. "customfield_10016"), passed explicitly
   * rather than read from config in here - this client has no scrum.json/tenant-config dependency
   * of its own, same "client takes what it needs as parameters" boundary as vcsClient's `repo`.
   */
  async getSprintIssues(sprintId: number, storyPointsField: string): Promise<SprintIssueSnapshot[]> {
    const { data } = await this.http.get<{ issues: AgileIssueRaw[] }>(`/sprint/${sprintId}/issue`, {
      params: { fields: `summary,status,assignee,updated,${storyPointsField}` },
    });
    return data.issues.map((issue) => mapSprintIssue(issue, storyPointsField));
  }
}

let client: AgileClient | null = null;

export async function getAgileClient(): Promise<AgileClient> {
  if (!client) client = await AgileClient.create();
  return client;
}
