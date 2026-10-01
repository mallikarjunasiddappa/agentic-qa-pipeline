import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { TraceabilityEntrySchema } from '../src/pipeline/types/schemas';
import { TmsRunRecord } from '../src/pipeline/testmgmt/types';

const MANIFEST_PATH = path.join('traceability', 'manifest.json');
const OLD_RUN_PATH = path.join('output', 'qase-run.json');
const NEW_RUN_PATH = path.join('output', 'tms-run.json');

interface OldTraceabilityEntry {
  jiraKey: string;
  qaseCaseId: number;
  qaseCaseHash: string;
  qaseCaseUpdatedAt: string;
  testFilePath: string;
  testContentHash: string;
  testLastModified: string;
  syncState: string;
  lastCheckedAt: string;
}

interface OldRunRecord {
  runId: number;
  cases: { id: string; title: string; qaseCaseId: number }[];
}

/**
 * One-time migration of the pre-abstraction Qase-shaped persisted data (traceability/manifest.json,
 * output/qase-run.json) into the generic TMS shape: qaseCaseId/qaseCaseHash/qaseCaseUpdatedAt ->
 * externalCaseId/externalCaseHash/externalCaseUpdatedAt (id stringified), plus a new tmsProvider
 * field set to "qase" since that's the real provider this data came from. Field values are
 * otherwise carried over unchanged - this is a shape migration, not a data correction.
 */
function migrateManifest(): void {
  if (!fs.existsSync(MANIFEST_PATH)) {
    console.log(`${MANIFEST_PATH} does not exist, nothing to migrate.`);
    return;
  }
  const raw: OldTraceabilityEntry[] = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
  const migrated = raw.map((entry) => ({
    jiraKey: entry.jiraKey,
    externalCaseId: String(entry.qaseCaseId),
    externalCaseHash: entry.qaseCaseHash,
    externalCaseUpdatedAt: entry.qaseCaseUpdatedAt,
    tmsProvider: 'qase',
    testFilePath: entry.testFilePath,
    testContentHash: entry.testContentHash,
    testLastModified: entry.testLastModified,
    syncState: entry.syncState,
    lastCheckedAt: entry.lastCheckedAt,
  }));

  // Validated against the entries schema alone, not the whole manifest schema - this script reads
  // the pre-approval-gates raw shape directly (qaseCaseId etc.), which loadManifest()'s current
  // schema would reject outright, so it can't round-trip through loadManifest/saveManifest here.
  // Written back out wrapped in the current { workflow, entries } shape with an empty workflow -
  // this migration predates the approval-gates feature, so there is no workflow state to carry
  // over from the old file.
  const validated = z.array(TraceabilityEntrySchema).parse(migrated);
  fs.writeFileSync(
    MANIFEST_PATH,
    `${JSON.stringify({ workflow: [], entries: validated }, null, 2)}\n`,
    'utf-8',
  );
  console.log(`Migrated ${validated.length} entries in ${MANIFEST_PATH}`);
}

function migrateRunRecord(): void {
  if (!fs.existsSync(OLD_RUN_PATH)) {
    console.log(`${OLD_RUN_PATH} does not exist, nothing to migrate.`);
    return;
  }
  const raw: OldRunRecord = JSON.parse(fs.readFileSync(OLD_RUN_PATH, 'utf-8'));
  const migrated: TmsRunRecord = {
    provider: 'qase',
    // The pre-abstraction shape this migrates from never recorded which ticket a run belonged to
    // (that's the exact gap TmsRunRecord.jiraKey/buildRunFilePath in pipeline.ts fixed later) -
    // this script is a dead, one-time migration guarded by OLD_RUN_PATH no longer existing, so
    // there's no real data to recover a key from here. Not worth resurrecting for a file that
    // will never actually be present again.
    jiraKey: 'UNKNOWN',
    runId: String(raw.runId),
    cases: raw.cases.map((c) => ({ id: c.id, title: c.title, externalCaseId: String(c.qaseCaseId) })),
  };

  fs.writeFileSync(NEW_RUN_PATH, `${JSON.stringify(migrated, null, 2)}\n`, 'utf-8');
  fs.rmSync(OLD_RUN_PATH);
  console.log(`Migrated run record: ${OLD_RUN_PATH} -> ${NEW_RUN_PATH}`);
}

function main(): void {
  migrateManifest();
  migrateRunRecord();
}

main();
