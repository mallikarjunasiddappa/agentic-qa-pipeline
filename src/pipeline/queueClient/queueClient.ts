import axios from 'axios';
import { requireTenantEnv } from '../config/env';

/**
 * First-ever CLI -> backend/ HTTP integration (Phase C, "AI-Assisted Scrum and SDLC Console -
 * Development Plan," docs/planning/). Every other cross-boundary sync in this project runs the
 * other direction and through a file, not a live call: the CLI writes flat JSON/JSONL under
 * data/<tenantId>/, and backend/scripts/migrate-tenant.mjs reads it into Postgres later, on its
 * own schedule. --stage draft-story has no such pre-existing flat-file convention to preserve (it
 * is new work, not a migration of something that already existed), and its output has nowhere
 * useful to live except the AI Queue itself - so this calls the backend's already-built,
 * already-tested queue API (backend/src/app.mjs, Phase A/B) directly instead of adding a new flat
 * file for a bridge script to eventually pick up.
 *
 * Deliberately thin - one function, no retry/backoff logic, mirrors jiraClient.ts's own "a plain
 * axios instance, callers handle failure" posture. Not unit-tested directly (same convention as
 * jiraClient.ts/askEngine.ts's Anthropic-calling code - only pure logic gets a dedicated test file
 * in this codebase); verified instead by running it against a real, locally-started instance of
 * backend/'s own createApp() (fake repositories, real HTTP, real Express routing) - see this
 * repo's PR description / docs/planning's dev plan status notes for that verification record.
 */

export type QueueItemType = 'SUGGESTED' | 'ESCALATED' | 'NEEDS_SESSION';

export interface QueueItemInput {
  type: QueueItemType;
  /** Matches the source deck's 9 stage names (e.g. 'stories', 'defects', 'test-cases') - free
   * text on the backend side too (see backend/prisma/schema.prisma's QueueItem.sourceStage), so
   * no shared enum to keep in sync across the CLI/backend boundary. */
  sourceStage: string;
  payload: Record<string, unknown>;
}

export interface CreatedQueueItem {
  id: string;
  projectId: string;
  type: QueueItemType;
  sourceStage: string;
  state: string;
  createdAt: string;
}

/**
 * POSTs to backend/'s POST /api/projects/:projectId/queue (backend/src/app.mjs) - real HTTP,
 * BACKEND_API_URL/BACKEND_PROJECT_ID resolved per-tenant the same way every other credential in
 * this pipeline is (requireTenantEnv - throws a clear, actionable error if either is unset, same
 * as JiraClient.create() does for JIRA_BASE_URL). Returns the real created QueueItem row exactly
 * as the backend responds with it - no shape translation, since the backend's response is already
 * the shape --stage draft-story needs to log (id/state) back to the console.
 */
export async function createQueueItem(item: QueueItemInput): Promise<CreatedQueueItem> {
  const baseUrl = await requireTenantEnv('BACKEND_API_URL', '--stage draft-story (AI Queue)');
  const projectId = await requireTenantEnv('BACKEND_PROJECT_ID', '--stage draft-story (AI Queue)');

  const { data } = await axios.post<CreatedQueueItem>(
    `${baseUrl.replace(/\/$/, '')}/api/projects/${projectId}/queue`,
    item,
    { headers: { 'Content-Type': 'application/json' } },
  );
  return data;
}
