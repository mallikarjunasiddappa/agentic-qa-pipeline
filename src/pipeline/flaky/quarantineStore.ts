import fs from 'node:fs';
import { QuarantineEntry, QuarantineManifestSchema } from '../types/schemas';
import { tenantDataPath } from '../config/tenantContext';
import { withFileLock, writeJsonFileAtomic } from '../shared/atomicJsonFile';

export function QUARANTINE_PATH(): string { return tenantDataPath('flaky', 'quarantine.json'); }

export function loadQuarantine(quarantinePath: string = QUARANTINE_PATH()): QuarantineEntry[] {
  if (!fs.existsSync(quarantinePath)) return [];
  const raw = JSON.parse(fs.readFileSync(quarantinePath, 'utf-8'));
  return QuarantineManifestSchema.parse(raw);
}

export function saveQuarantine(
  entries: QuarantineEntry[],
  quarantinePath: string = QUARANTINE_PATH(),
): void {
  const validated = QuarantineManifestSchema.parse(entries);
  // Atomic - see shared/atomicJsonFile.ts and saveManifest's note.
  writeJsonFileAtomic(quarantinePath, validated);
}

/**
 * Upserts an entry keyed by (testFilePath, testTitle), returning the new array. testTitle is part
 * of the key so quarantining one flaky scenario in a shared multi-test file never touches a
 * sibling scenario's entry - see QuarantineEntry.testTitle's comment.
 */
export function upsertQuarantineEntry(
  entries: QuarantineEntry[],
  entry: QuarantineEntry,
): QuarantineEntry[] {
  const index = entries.findIndex((e) => e.testFilePath === entry.testFilePath && e.testTitle === entry.testTitle);
  if (index === -1) return [...entries, entry];
  const next = [...entries];
  next[index] = entry;
  return next;
}

/**
 * Removes the entry for a test file (and, for a shared multi-test file, a specific testTitle
 * within it), if any. Returns the same array reference when nothing matched. testTitle omitted
 * matches only an entry that also has no testTitle - same "undefined is part of the key, not a
 * wildcard" reasoning as upsertQuarantineEntry.
 */
export function removeQuarantineEntry(
  entries: QuarantineEntry[],
  testFilePath: string,
  testTitle?: string,
): QuarantineEntry[] {
  if (!entries.some((e) => e.testFilePath === testFilePath && e.testTitle === testTitle)) return entries;
  return entries.filter((e) => !(e.testFilePath === testFilePath && e.testTitle === testTitle));
}

/**
 * Load, mutate and save the quarantine list while holding an exclusive lock.
 *
 * Same reasoning as manifestStore's updateManifest: the lock must span the read as well as the
 * write, or two concurrent quarantine records silently overwrite each other.
 */
export function updateQuarantine(
  mutate: (entries: QuarantineEntry[]) => QuarantineEntry[],
  quarantinePath: string = QUARANTINE_PATH(),
): QuarantineEntry[] {
  return withFileLock(quarantinePath, () => {
    const next = mutate(loadQuarantine(quarantinePath));
    saveQuarantine(next, quarantinePath);
    return next;
  });
}
