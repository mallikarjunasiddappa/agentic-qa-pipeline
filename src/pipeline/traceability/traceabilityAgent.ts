import fs from 'node:fs';
import { isAxiosError } from 'axios';
import type { TestManagementClient } from '../testmgmt/types';
import { hashCase, hashTestFile, hashScenarioTestBlock } from './hashing';
import { SyncState, TraceabilityEntry } from '../types/schemas';
import { mapWithConcurrency } from '../shared/concurrency';
import { findTestBlocks } from '../shared/testBlocks';

// Conservative default, not a documented Qase limit (their docs don't publish one as of this
// writing) - chosen to give a real speedup at thousands of manifest entries (checkDrift used to
// fetch one case at a time, sequentially - a genuine multi-minute-plus bottleneck at that volume)
// without hammering the API hard enough to risk 429s. Overridable per-environment via
// DRIFT_CHECK_CONCURRENCY (see env.ts) if this default turns out too conservative or too
// aggressive for your actual Qase plan/limits.
export const DEFAULT_DRIFT_CHECK_CONCURRENCY = 5;

// Narrowed to what this module actually calls, so tests can pass a plain mock instead of a real
// adapter (whose constructor may require live provider credentials).
export type CaseReader = Pick<TestManagementClient, 'getCase'>;

export interface DriftReportEntry extends TraceabilityEntry {
  // The hashes as they are *right now* - only used for reporting/diagnosis. The manifest's own
  // externalCaseHash/testContentHash fields stay as the recorded baseline; this agent never
  // rewrites them (see recordBaseline.ts / the TMS and Healer Agent hooks, which are the only
  // legitimate baseline writers).
  currentExternalCaseHash: string | null;
  currentTestContentHash: string | null;
}

export interface DriftCheckResult {
  entries: DriftReportEntry[];
  counts: Record<SyncState, number>;
}

function isCaseNotFound(err: unknown): boolean {
  return isAxiosError(err) && err.response?.status === 404;
}

/**
 * Refetches each manifest entry's test management case and re-reads its test file, recomputes
 * both hashes, and classifies the entry into one of the six sync states. Read-only with respect
 * to baseline hashes - only `syncState`/`lastCheckedAt` change on the returned entries;
 * `externalCaseHash` and `testContentHash` are carried over unchanged from the input manifest.
 *
 * Runs the per-entry work (one tms.getCase() call plus one file read/hash each) with up to
 * `concurrency` entries in flight at once, not strictly sequentially - see mapWithConcurrency's
 * own comment for why. Output order matches input order regardless of which entry's API call
 * actually resolves first, so callers (and this function's own counts tally below) don't need to
 * care that the work happened concurrently.
 *
 * Tie-break note: the six states have no "both orphaned" case. If a test file is missing on disk
 * *and* its case is gone too, this classifies it ORPHANED_TEST (arbitrary but documented) -
 * revisit if that turns out to hide real orphaned-case volume.
 *
 * Hashing granularity: an entry with a `testTitle` (i.e. one scenario within a shared multi-test
 * file, per shared/testBlocks.ts) is hashed via hashScenarioTestBlock, scoped to just that one
 * `test(...)` block - matching exactly how stageTraceabilityLink/recordBaseline.ts compute the
 * *baseline* hash for such an entry. An entry with no `testTitle` (single-test file, or an entry
 * predating multi-test-per-file support) falls back to hashTestFile's whole-file hash, unchanged
 * from before. Getting this wrong previously meant every entry in a shared file was hashed
 * whole-file here while its baseline had been recorded per-block at link time - two different
 * things being compared as if they were the same, so every entry in any shared multi-test file
 * showed TEST_DRIFTED permanently, even entries nobody had touched since the day they were linked.
 * If `testTitle` is set but no block in the current file matches it (the scenario was renamed or
 * removed without updating the marker), that's treated as ORPHANED_TEST, same as the whole file
 * being gone - the traceability system has equally lost track of that specific test either way.
 */
export async function checkDrift(
  manifest: TraceabilityEntry[],
  tms: CaseReader,
  concurrency: number = DEFAULT_DRIFT_CHECK_CONCURRENCY,
): Promise<DriftCheckResult> {
  const now = new Date().toISOString();

  const entries = await mapWithConcurrency(manifest, concurrency, async (entry): Promise<DriftReportEntry> => {
    const testExists = fs.existsSync(entry.testFilePath);

    let caseExists = true;
    let currentExternalCaseHash: string | null = null;
    try {
      const caseDetail = await tms.getCase(entry.externalCaseId);
      currentExternalCaseHash = hashCase(caseDetail);
    } catch (err) {
      if (!isCaseNotFound(err)) throw err;
      caseExists = false;
    }

    let currentTestContentHash: string | null = null;
    let scenarioBlockMissing = false;
    if (testExists) {
      const source = fs.readFileSync(entry.testFilePath, 'utf-8');
      if (entry.testTitle !== undefined) {
        const block = findTestBlocks(source, entry.testFilePath).find((b) => b.testTitle === entry.testTitle);
        if (block) {
          currentTestContentHash = await hashScenarioTestBlock(block.source);
        } else {
          scenarioBlockMissing = true;
        }
      } else {
        currentTestContentHash = await hashTestFile(source, entry.testFilePath);
      }
    }

    let syncState: SyncState;
    if (!testExists || scenarioBlockMissing) {
      syncState = 'ORPHANED_TEST';
    } else if (!caseExists) {
      syncState = 'ORPHANED_CASE';
    } else {
      const caseDrifted = currentExternalCaseHash !== entry.externalCaseHash;
      const testDrifted = currentTestContentHash !== entry.testContentHash;
      if (caseDrifted && testDrifted) syncState = 'BOTH_DRIFTED';
      else if (caseDrifted) syncState = 'CASE_DRIFTED';
      else if (testDrifted) syncState = 'TEST_DRIFTED';
      else syncState = 'IN_SYNC';
    }

    return { ...entry, syncState, lastCheckedAt: now, currentExternalCaseHash, currentTestContentHash };
  });

  const counts: Record<SyncState, number> = {
    IN_SYNC: 0,
    CASE_DRIFTED: 0,
    TEST_DRIFTED: 0,
    BOTH_DRIFTED: 0,
    ORPHANED_CASE: 0,
    ORPHANED_TEST: 0,
  };
  for (const entry of entries) counts[entry.syncState] += 1;

  return { entries, counts };
}

/** Drops the report-only current-hash fields, leaving the manifest shape (baseline hashes untouched). */
export function toManifestEntry(entry: DriftReportEntry): TraceabilityEntry {
  return {
    tenantId: entry.tenantId,
    jiraKey: entry.jiraKey,
    externalCaseId: entry.externalCaseId,
    externalCaseHash: entry.externalCaseHash,
    externalCaseUpdatedAt: entry.externalCaseUpdatedAt,
    tmsProvider: entry.tmsProvider,
    testFilePath: entry.testFilePath,
    testContentHash: entry.testContentHash,
    testLastModified: entry.testLastModified,
    syncState: entry.syncState,
    lastCheckedAt: entry.lastCheckedAt,
  };
}
