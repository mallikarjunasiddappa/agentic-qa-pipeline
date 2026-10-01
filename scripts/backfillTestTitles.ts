import fs from 'node:fs';
import path from 'node:path';
import { findTestBlocks } from '../src/pipeline/shared/testBlocks';
import { loadManifest, saveManifest } from '../src/pipeline/traceability/manifestStore';
import { loadQuarantine, saveQuarantine } from '../src/pipeline/flaky/quarantineStore';
import {
  TraceabilityEntry,
  HealingEvent,
  HealingEventSchema,
  FlakyEvent,
  FlakyEventSchema,
  QuarantineEntry,
} from '../src/pipeline/types/schemas';

const HEALING_LOG_PATH = path.join('healing', 'telemetry.jsonl');
const FLAKY_LOG_PATH = path.join('flaky', 'telemetry.jsonl');

/**
 * One-time backfill of the `testTitle` field added to TraceabilityEntry/HealingEvent/FlakyEvent/
 * QuarantineEntry for multi-test-per-file support (see schemas.ts). Every record written before
 * this feature is missing it.
 *
 * Deterministic-only, same philosophy as everywhere else in this pipeline that touches recorded
 * history: a testFilePath that resolves to exactly one test(...) block gets that block's title -
 * unambiguous, since every file predating this feature has exactly one test in it. A testFilePath
 * that resolves to zero or more than one block is left untouched and reported as unresolved, never
 * guessed - a wrong guess here would silently mismatch a scenario's baseline (see
 * TraceabilityEntry.testTitle's comment) or misattribute healing/flaky history to the wrong
 * scenario.
 *
 * Dry-run by default: prints exactly what it would change and stops. Pass --apply to actually
 * write. Idempotent - already-set testTitle fields are left alone and reported as skipped, so a
 * second run after manually resolving an ambiguous file only touches what's still missing.
 * Snapshots every file it's about to modify (`<file>.bak-<timestamp>`) before writing, and runs a
 * regression check first: for every record it touches, every field *other than* testTitle must be
 * unchanged, or the whole run aborts before writing anything.
 */

interface Resolution {
  status: 'resolved' | 'unresolved-missing-file' | 'unresolved-no-test' | 'unresolved-ambiguous';
  testTitle?: string;
  detail: string;
}

function resolveTestTitleForFile(testFilePath: string): Resolution {
  if (!fs.existsSync(testFilePath)) {
    return { status: 'unresolved-missing-file', detail: `${testFilePath} no longer exists on disk` };
  }
  const source = fs.readFileSync(testFilePath, 'utf-8');
  const blocks = findTestBlocks(source, testFilePath);
  if (blocks.length === 0) {
    return { status: 'unresolved-no-test', detail: `no test(...) found in ${testFilePath}` };
  }
  if (blocks.length > 1) {
    return {
      status: 'unresolved-ambiguous',
      detail:
        `${testFilePath} already has ${blocks.length} test(...) blocks - add a ` +
        '"// scenario-id: <id>" marker above the right one (or resolve manually) before backfilling',
    };
  }
  return { status: 'resolved', testTitle: blocks[0].testTitle, detail: 'single test in file - unambiguous' };
}

interface BackfillResult<T> {
  next: T[];
  changed: number;
  skippedAlreadySet: number;
  unresolved: { detail: string }[];
  report: string[];
}

/** Generic over anything shaped like { testFilePath: string; testTitle?: string }. */
function backfill<T extends { testFilePath: string; testTitle?: string }>(
  records: T[],
  label: string,
): BackfillResult<T> {
  const report: string[] = [];
  let changed = 0;
  let skippedAlreadySet = 0;
  const unresolved: { detail: string }[] = [];

  const next = records.map((record) => {
    if (record.testTitle !== undefined) {
      skippedAlreadySet += 1;
      return record;
    }
    const resolution = resolveTestTitleForFile(record.testFilePath);
    if (resolution.status === 'resolved') {
      changed += 1;
      report.push(`  RESOLVED  ${record.testFilePath} -> "${resolution.testTitle}"`);
      return { ...record, testTitle: resolution.testTitle };
    }
    unresolved.push({ detail: resolution.detail });
    report.push(`  UNRESOLVED (${resolution.status})  ${resolution.detail}`);
    return record;
  });

  console.log(`\n${label}: ${records.length} record(s) - ${changed} resolved, ${skippedAlreadySet} already set, ${unresolved.length} unresolved`);
  for (const line of report) console.log(line);

  return { next, changed, skippedAlreadySet, unresolved, report };
}

/**
 * Regression guard: for every record, every field except testTitle must be identical before and
 * after. Backfill only ever adds one field via a spread (see backfill() above), so this should be
 * true by construction - this is a hard check against that assumption ever silently breaking in a
 * future edit to this script, not a check expected to actually catch anything today.
 */
function assertOnlyTestTitleChanged<T extends { testTitle?: string }>(before: T[], after: T[], label: string): void {
  if (before.length !== after.length) {
    throw new Error(`${label}: record count changed (${before.length} -> ${after.length}) - refusing to apply.`);
  }
  for (let i = 0; i < before.length; i += 1) {
    const { testTitle: _beforeTitle, ...beforeRest } = before[i];
    const { testTitle: _afterTitle, ...afterRest } = after[i];
    if (JSON.stringify(beforeRest) !== JSON.stringify(afterRest)) {
      throw new Error(`${label}: record ${i} changed a field other than testTitle - refusing to apply.`);
    }
  }
}

function snapshot(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const backupPath = `${filePath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.copyFileSync(filePath, backupPath);
  console.log(`Snapshotted ${filePath} -> ${backupPath}`);
}

function readJsonl<T>(logPath: string, schema: { parse: (v: unknown) => T }): T[] {
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, 'utf-8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => schema.parse(JSON.parse(line)));
}

function writeJsonl<T>(logPath: string, records: T[]): void {
  const body = records.map((r) => JSON.stringify(r)).join('\n');
  fs.writeFileSync(logPath, records.length > 0 ? `${body}\n` : '', 'utf-8');
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  console.log(apply ? 'Running in --apply mode - files will be written.' : 'Dry run (pass --apply to write changes).');

  // --- traceability/manifest.json entries ---
  const manifest = loadManifest();
  const manifestResult = backfill<TraceabilityEntry>(manifest.entries, 'traceability/manifest.json entries');
  assertOnlyTestTitleChanged(manifest.entries, manifestResult.next, 'traceability/manifest.json');

  // --- healing/telemetry.jsonl ---
  const healingEvents = readJsonl<HealingEvent>(HEALING_LOG_PATH, HealingEventSchema);
  const healingResult = backfill<HealingEvent>(healingEvents, HEALING_LOG_PATH);
  assertOnlyTestTitleChanged(healingEvents, healingResult.next, HEALING_LOG_PATH);

  // --- flaky/telemetry.jsonl ---
  const flakyEvents = readJsonl<FlakyEvent>(FLAKY_LOG_PATH, FlakyEventSchema);
  const flakyResult = backfill<FlakyEvent>(flakyEvents, FLAKY_LOG_PATH);
  assertOnlyTestTitleChanged(flakyEvents, flakyResult.next, FLAKY_LOG_PATH);

  // --- flaky/quarantine.json ---
  const quarantine = loadQuarantine();
  const quarantineResult = backfill<QuarantineEntry>(quarantine, 'flaky/quarantine.json');
  assertOnlyTestTitleChanged(quarantine, quarantineResult.next, 'flaky/quarantine.json');

  const totalChanged =
    manifestResult.changed + healingResult.changed + flakyResult.changed + quarantineResult.changed;
  const totalUnresolved =
    manifestResult.unresolved.length +
    healingResult.unresolved.length +
    flakyResult.unresolved.length +
    quarantineResult.unresolved.length;

  console.log(`\nTotal: ${totalChanged} resolved, ${totalUnresolved} unresolved across all four sources.`);

  if (!apply) {
    console.log('\nDry run only - nothing written. Re-run with --apply once this looks right.');
    return;
  }

  if (manifestResult.changed > 0) snapshot(path.join('traceability', 'manifest.json'));
  if (healingResult.changed > 0) snapshot(HEALING_LOG_PATH);
  if (flakyResult.changed > 0) snapshot(FLAKY_LOG_PATH);
  if (quarantineResult.changed > 0) snapshot(path.join('flaky', 'quarantine.json'));

  if (manifestResult.changed > 0) {
    saveManifest({ workflow: manifest.workflow, entries: manifestResult.next });
    console.log(`Wrote ${manifestResult.changed} backfilled testTitle(s) to traceability/manifest.json`);
  }
  if (healingResult.changed > 0) {
    writeJsonl(HEALING_LOG_PATH, healingResult.next);
    console.log(`Wrote ${healingResult.changed} backfilled testTitle(s) to ${HEALING_LOG_PATH}`);
  }
  if (flakyResult.changed > 0) {
    writeJsonl(FLAKY_LOG_PATH, flakyResult.next);
    console.log(`Wrote ${flakyResult.changed} backfilled testTitle(s) to ${FLAKY_LOG_PATH}`);
  }
  if (quarantineResult.changed > 0) {
    saveQuarantine(quarantineResult.next);
    console.log(`Wrote ${quarantineResult.changed} backfilled testTitle(s) to flaky/quarantine.json`);
  }

  if (totalUnresolved > 0) {
    console.log(
      `\n${totalUnresolved} record(s) remain unresolved (see UNRESOLVED lines above) - resolve those ` +
        'files manually (or add a scenario-id marker) and re-run; already-resolved records above will ' +
        'be skipped as already set.',
    );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exitCode = 1;
});
