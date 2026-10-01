import fs from 'node:fs';
import path from 'node:path';
import { getTestManagementClient } from '../src/pipeline/testmgmt';
import { TmsRunRecord } from '../src/pipeline/testmgmt/types';
import { buildEntriesForSpec } from '../src/pipeline/traceability/recordBaseline';
import { loadManifest, saveManifest } from '../src/pipeline/traceability/manifestStore';
import { TraceabilityEntry } from '../src/pipeline/types/schemas';
import { env } from '../src/pipeline/config/env';

/**
 * One-time seed of traceability/manifest.json from what already exists: every spec file's
 * scenarios, cross-referenced against the most recent tms-upload run record for case ids, with
 * fresh hashes computed from the live test management case and the on-disk test file. Seeded
 * entries start IN_SYNC by construction - this is a snapshot of "linked and matching right now",
 * not a claim that nothing has drifted since the original generation.
 */
async function main(): Promise<void> {
  const specsDir = 'specs';
  const specFiles = fs
    .readdirSync(specsDir)
    .filter((f) => f.endsWith('.plan.md'))
    .map((f) => path.join(specsDir, f));

  const runFilePath = path.join(env.OUTPUT_DIR, 'tms-run.json');
  if (!fs.existsSync(runFilePath)) {
    throw new Error(
      `${runFilePath} not found - run "npm run pipeline -- --stage tms-upload ..." first, or ` +
        'this backfill has nothing to link scenarios to test management case ids with.',
    );
  }
  const runRecord: TmsRunRecord = JSON.parse(fs.readFileSync(runFilePath, 'utf-8'));

  const tms = await getTestManagementClient();
  const allEntries: TraceabilityEntry[] = [];
  const allSkipped: string[] = [];

  for (const specFile of specFiles) {
    const { entries, skipped } = await buildEntriesForSpec(specFile, runRecord, tms);
    for (const entry of entries) {
      console.log(`Seeded ${entry.testFilePath} <-> ${entry.tmsProvider} case ${entry.externalCaseId} <-> ${entry.jiraKey}`);
    }
    allEntries.push(...entries);
    allSkipped.push(...skipped);
  }

  // Preserve any existing workflow (approval-gate) records - this backfill only ever touches the
  // case-level entries array, never the human-approval state.
  const { workflow } = loadManifest();
  saveManifest({ workflow, entries: allEntries });
  console.log(`\nWrote ${allEntries.length} entries to traceability/manifest.json`);
  if (allSkipped.length > 0) {
    console.log(`\nSkipped ${allSkipped.length} scenario(s):`);
    for (const reason of allSkipped) console.log(`  - ${reason}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exitCode = 1;
});
