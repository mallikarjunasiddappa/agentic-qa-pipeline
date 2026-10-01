import { getTestManagementClient } from '../src/pipeline/testmgmt';
import { env } from '../src/pipeline/config/env';
import { loadManifest } from '../src/pipeline/traceability/manifestStore';

const DEFAULT_TARGET_SUITE = 'Student Profile Management';

/**
 * One-off reorg: moves every case this pipeline has ever automated (i.e. every entry in
 * traceability/manifest.json for the active TMS_PROVIDER, across ALL Jira tickets) into a single
 * flat destination suite - not nested per-ticket the way scripts/migrateCasesToSuites.ts files
 * cases (Suite = ticket summary > Sub-suite = describe block). This is a deliberate one-time
 * consolidation, not the normal per-ticket filing behavior --stage tms-upload does automatically.
 *
 * Scope is literally "every automated case in the manifest" - if you want to hold one back (e.g.
 * to keep it under its original ticket suite), comment it out of the `entries` list below before
 * running, or pass --issue <KEY> one or more times to restrict to specific tickets.
 *
 * Usage:
 *   npx tsx scripts/moveAutomatedCasesToSuite.ts
 *   npx tsx scripts/moveAutomatedCasesToSuite.ts --suite "Student Profile Management"
 *   npx tsx scripts/moveAutomatedCasesToSuite.ts --issue KAN-3 --issue KAN-4
 *   npx tsx scripts/moveAutomatedCasesToSuite.ts --dry-run
 */
function parseArgs(): { suite: string; issues: string[]; dryRun: boolean } {
  const args = process.argv.slice(2);
  const suiteIdx = args.indexOf('--suite');
  const suite = suiteIdx !== -1 ? args[suiteIdx + 1] : DEFAULT_TARGET_SUITE;
  const issues: string[] = [];
  args.forEach((a, i) => {
    if (a === '--issue' && args[i + 1]) issues.push(args[i + 1]);
  });
  const dryRun = args.includes('--dry-run');
  return { suite, issues, dryRun };
}

async function main(): Promise<void> {
  const { suite, issues, dryRun } = parseArgs();

  const tms = await getTestManagementClient();
  if (!tms.moveCaseToSuite) {
    console.log(
      `TMS_PROVIDER "${env.TMS_PROVIDER}" has no suite/folder concept (moveCaseToSuite not ` +
        'implemented) - nothing to move.',
    );
    return;
  }
  const moveCaseToSuite = tms.moveCaseToSuite.bind(tms);

  const manifest = loadManifest();
  let entries = manifest.entries.filter((e) => e.tmsProvider === env.TMS_PROVIDER);
  if (issues.length > 0) {
    entries = entries.filter((e) => issues.includes(e.jiraKey));
  }

  if (entries.length === 0) {
    console.log(`No ${env.TMS_PROVIDER} entries found in traceability/manifest.json - nothing to move.`);
    return;
  }

  console.log(`Target suite: "${suite}"`);
  console.log(`${entries.length} case(s) to move${dryRun ? ' (dry run - no changes will be made)' : ''}:\n`);
  for (const e of entries) {
    console.log(`  ${e.jiraKey}  case ${e.externalCaseId}  (${e.testFilePath}${e.testTitle ? ` :: ${e.testTitle}` : ''})`);
  }

  if (dryRun) {
    console.log('\nDry run - nothing moved. Re-run without --dry-run to apply.');
    return;
  }

  console.log();
  let moved = 0;
  for (const e of entries) {
    await moveCaseToSuite(e.externalCaseId, suite);
    console.log(`  Moved case ${e.externalCaseId} (${e.jiraKey}) -> "${suite}"`);
    moved += 1;
  }

  console.log(`\nDone: ${moved} case(s) moved to "${suite}".`);
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exitCode = 1;
});
