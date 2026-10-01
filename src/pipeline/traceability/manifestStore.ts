import fs from 'node:fs';
import { TraceabilityEntry, TraceabilityManifest, TraceabilityManifestSchema, WorkflowRecord } from '../types/schemas';
import { tenantDataPath } from '../config/tenantContext';
import { withFileLock, writeJsonFileAtomic } from '../shared/atomicJsonFile';

export function MANIFEST_PATH(): string {
  return tenantDataPath('traceability', 'manifest.json');
}

/**
 * Loads the manifest, transparently upgrading the pre-approval-gates flat-array shape (every
 * manifest.json on disk before this feature) into the current { workflow, entries } shape with an
 * empty workflow list. The next saveManifest() call persists the upgraded shape - this is a
 * read-time migration, not a one-off script, so old files keep working with zero manual steps.
 */
export function loadManifest(manifestPath: string = MANIFEST_PATH()): TraceabilityManifest {
  if (!fs.existsSync(manifestPath)) return { workflow: [], entries: [] };
  const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  const upgraded = Array.isArray(raw) ? { workflow: [], entries: raw } : raw;
  return TraceabilityManifestSchema.parse(upgraded);
}

export function saveManifest(
  manifest: TraceabilityManifest,
  manifestPath: string = MANIFEST_PATH(),
): void {
  const validated = TraceabilityManifestSchema.parse(manifest);
  // Atomic: a process killed mid-write used to leave a truncated manifest.json that failed to
  // parse on the next run. See shared/atomicJsonFile.ts.
  writeJsonFileAtomic(manifestPath, validated);
}

/** Finds a jiraKey's workflow (approval-gate) record, if one has been created yet. */
export function findWorkflowRecord(
  workflow: WorkflowRecord[],
  jiraKey: string,
): WorkflowRecord | undefined {
  return workflow.find((w) => w.jiraKey === jiraKey);
}

/** Upserts a workflow record keyed by jiraKey alone, returning the new array. */
export function upsertWorkflowRecord(
  workflow: WorkflowRecord[],
  record: WorkflowRecord,
): WorkflowRecord[] {
  const index = workflow.findIndex((w) => w.jiraKey === record.jiraKey);
  if (index === -1) return [...workflow, record];
  const next = [...workflow];
  // Only DEFINED keys overwrite. Object spread copies a key even when its value is undefined, and
  // callers routinely pass `x: condition ? value : undefined` - which used to wipe a gate a human
  // had already approved. Re-running flag-requirement-gaps after an approval silently re-locked
  // the gate, with no record of who un-approved it, because nobody had.
  next[index] = { ...next[index], ...definedOnly(record) };
  return next;
}

/** A shallow copy without the keys whose value is undefined. */
function definedOnly<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/**
 * Load, mutate and save the manifest while holding an exclusive lock.
 *
 * The lock has to span the whole read-modify-write, not just the write: two processes that each
 * load, mutate and save independently both write a perfectly valid file, and one of them silently
 * loses every change it made. Prefer this over a bare loadManifest()/saveManifest() pair anywhere
 * a second process could be running - which, with CI and a developer's terminal, is everywhere.
 */
export function updateManifest(
  mutate: (manifest: TraceabilityManifest) => TraceabilityManifest,
  manifestPath: string = MANIFEST_PATH(),
): TraceabilityManifest {
  return withFileLock(manifestPath, () => {
    const next = mutate(loadManifest(manifestPath));
    saveManifest(next, manifestPath);
    return next;
  });
}

/**
 * Finds an entry by the (jiraKey, externalCaseId, testFilePath, testTitle) tuple that identifies a
 * link. testTitle only matters once a file holds more than one test - key.testTitle is optional so
 * every existing call site that predates multi-test-per-file support (and every file that still
 * only has one test) keeps matching exactly as before; `undefined === undefined` there is correct,
 * not a loophole, since testFilePath alone was already unique for those.
 */
export function findEntry(
  entries: TraceabilityEntry[],
  key: Pick<TraceabilityEntry, 'jiraKey' | 'externalCaseId' | 'testFilePath'> & { testTitle?: string },
): TraceabilityEntry | undefined {
  return entries.find(
    (e) =>
      e.jiraKey === key.jiraKey &&
      e.externalCaseId === key.externalCaseId &&
      e.testFilePath === key.testFilePath &&
      e.testTitle === key.testTitle,
  );
}

/**
 * Finds every entry for a given test file path - what the Healer Agent hook has on hand after a
 * fix. Returns an array (not a single entry) since a shared multi-test file can have more than
 * one; callers that need exactly one (see updateTestBaseline below) are responsible for
 * disambiguating by testTitle when this returns more than one.
 */
export function findEntryByTestFilePath(
  entries: TraceabilityEntry[],
  testFilePath: string,
): TraceabilityEntry[] {
  return entries.filter((e) => e.testFilePath === testFilePath);
}

/**
 * Updates only testContentHash/testLastModified on the entry for a given test file (and, for a
 * shared multi-test file, a specific testTitle within it) - what the Healer Agent hook calls right
 * after a legitimate fix, so the new baseline reflects the sanctioned change. Deliberately leaves
 * externalCaseHash/externalCaseUpdatedAt/syncState/lastCheckedAt untouched; those are the
 * Traceability Agent's to (re)compute, not the Healer's.
 *
 * Throws rather than guessing when testFilePath alone doesn't resolve to exactly one entry - a
 * file with more than one test requires testTitle to say which one was fixed; silently updating
 * the wrong entry's baseline would mark an untouched sibling scenario as "reviewed" while leaving
 * the one that actually changed still flagged as drifted (or vice versa).
 */
export function updateTestBaseline(
  entries: TraceabilityEntry[],
  testFilePath: string,
  testContentHash: string,
  testLastModified: string,
  testTitle?: string,
): TraceabilityEntry[] {
  const candidates = entries.filter((e) => e.testFilePath === testFilePath);
  if (candidates.length === 0) {
    throw new Error(
      `No traceability entry found for ${testFilePath} - it may never have gone through ` +
        '--stage traceability-record, so there is no baseline to update.',
    );
  }
  const matches = testTitle !== undefined ? candidates.filter((e) => e.testTitle === testTitle) : candidates;
  if (matches.length !== 1) {
    throw new Error(
      `${testFilePath} has ${candidates.length} traceability entries (a shared multi-test file) - ` +
        `pass --test-title to say which one to update (got ${matches.length} match${matches.length === 1 ? '' : 'es'} ` +
        `for ${testTitle ?? '<none given>'}).`,
    );
  }
  const index = entries.indexOf(matches[0]);
  const next = [...entries];
  next[index] = { ...next[index], testContentHash, testLastModified };
  return next;
}

/**
 * Upserts an entry keyed by (jiraKey, externalCaseId, testFilePath, testTitle), returning the new
 * array. testTitle is part of the key (not just a stored field) so re-recording traceability for
 * one scenario in a shared multi-test file replaces only that scenario's entry, not any sibling
 * scenario's - see TraceabilityEntry.testTitle's comment for why it's optional.
 */
export function upsertEntry(
  entries: TraceabilityEntry[],
  entry: TraceabilityEntry,
): TraceabilityEntry[] {
  const index = entries.findIndex(
    (e) =>
      e.jiraKey === entry.jiraKey &&
      e.externalCaseId === entry.externalCaseId &&
      e.testFilePath === entry.testFilePath &&
      e.testTitle === entry.testTitle,
  );
  if (index === -1) return [...entries, entry];
  const next = [...entries];
  next[index] = entry;
  return next;
}

/**
 * Removes the single entry matching the exact (jiraKey, externalCaseId, testFilePath, testTitle)
 * key - the same identity key upsertEntry/findEntry use, and the same "no fuzzy matching" contract
 * as everything else in this file: a caller must state precisely which entry to remove, including
 * testTitle when the entry has one. There is no "remove every entry for this file" or "remove by
 * testFilePath alone when it's ambiguous" mode - a shared multi-test file can have several stale
 * entries at once, and silently removing more than the one actually intended would corrupt the
 * audit trail this file exists to protect (see --stage traceability-unlink in pipeline.ts, which
 * adds a further check on top of this: it refuses to remove an entry whose testFilePath still
 * exists on disk unless --force is passed, since that would almost always be the wrong entry).
 *
 * Returns the same array reference when nothing matched, mirroring removeQuarantineEntry in
 * flaky/quarantineStore.ts - callers can use reference equality to detect a no-op rather than
 * needing a separate boolean return.
 */
export function removeEntry(
  entries: TraceabilityEntry[],
  key: Pick<TraceabilityEntry, 'jiraKey' | 'externalCaseId' | 'testFilePath'> & { testTitle?: string },
): TraceabilityEntry[] {
  const matches = (e: TraceabilityEntry) =>
    e.jiraKey === key.jiraKey &&
    e.externalCaseId === key.externalCaseId &&
    e.testFilePath === key.testFilePath &&
    e.testTitle === key.testTitle;
  if (!entries.some(matches)) return entries;
  return entries.filter((e) => !matches(e));
}
