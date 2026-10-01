import type { JiraClient } from '../jira/jiraClient';
import type { SyncState, TraceabilityEntry } from '../types/schemas';
import type { DriftReportEntry } from './traceabilityAgent';

// Narrowed to what this module calls, so tests can pass a mock instead of a real JiraClient.
export type CommentPoster = Pick<JiraClient, 'addComment'>;

const DRIFTED_STATES: SyncState[] = ['CASE_DRIFTED', 'BOTH_DRIFTED'];

function entryKey(e: Pick<TraceabilityEntry, 'jiraKey' | 'externalCaseId' | 'testFilePath'>): string {
  return `${e.jiraKey}::${e.externalCaseId}::${e.testFilePath}`;
}

/** Snapshot of each entry's syncState *before* a drift-check run, for edge-triggering below. */
export function buildPreviousSyncStateMap(manifest: TraceabilityEntry[]): Map<string, SyncState> {
  return new Map(manifest.map((entry) => [entryKey(entry), entry.syncState]));
}

/**
 * Entries that just became CASE_DRIFTED/BOTH_DRIFTED in this run - their previous syncState (from
 * the manifest as loaded, before this check ran) was something else. Edge-triggered on purpose:
 * without this, a daily CI drift-check (see the GitHub Actions workflow) would re-comment on the
 * same still-unresolved drift every single day until someone fixes it.
 */
export function findNewlyDrifted(
  entries: DriftReportEntry[],
  previousSyncStates: Map<string, SyncState>,
): DriftReportEntry[] {
  return entries.filter((entry) => {
    if (!DRIFTED_STATES.includes(entry.syncState)) return false;
    const previous = previousSyncStates.get(entryKey(entry));
    return previous === undefined || !DRIFTED_STATES.includes(previous);
  });
}

function buildComment(entries: DriftReportEntry[]): string {
  return [
    'Traceability drift detected by the automated drift-check run.',
    '',
    'The following test management case(s) linked to this ticket have changed content since their ' +
      'test was last generated or healed - the Playwright test may no longer reflect what is being verified:',
    '',
    ...entries.map((e) => `- Case ${e.externalCaseId} (${e.testFilePath}) - ${e.syncState}`),
    '',
    'This is a report only - nothing was auto-regenerated. Review the case and either update ' +
      'the test to match, or fix the case if it drifted from the real requirement.',
  ].join('\n');
}

/** Posts one grouped comment per Jira ticket covering all of its newly-drifted entries. */
export async function postDriftComments(
  newlyDrifted: DriftReportEntry[],
  jira: CommentPoster,
): Promise<{ jiraKey: string; entryCount: number }[]> {
  const byJiraKey = new Map<string, DriftReportEntry[]>();
  for (const entry of newlyDrifted) {
    const list = byJiraKey.get(entry.jiraKey) ?? [];
    list.push(entry);
    byJiraKey.set(entry.jiraKey, list);
  }

  const posted: { jiraKey: string; entryCount: number }[] = [];
  for (const [jiraKey, entries] of byJiraKey) {
    await jira.addComment(jiraKey, buildComment(entries));
    posted.push({ jiraKey, entryCount: entries.length });
  }
  return posted;
}
