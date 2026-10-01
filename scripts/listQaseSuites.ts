import { getQaseClient } from '../src/pipeline/testmgmt/qaseClient';

/**
 * Debug helper: prints every suite's exact id/title/parent as Qase has it stored. Use this when a
 * script like moveSuiteUnderParent.ts fails with "No suite titled ... exists" - titles must match
 * exactly (case, punctuation, whitespace), and this is the fastest way to see what's really there
 * rather than eyeballing a truncated title in the UI.
 *
 * Usage: npx tsx scripts/listQaseSuites.ts
 */
async function main(): Promise<void> {
  const client = await getQaseClient();
  const suites = await client.listSuites();
  const byId = new Map(suites.map((s) => [s.id, s.title]));

  console.log(`${suites.length} suite(s):\n`);
  for (const s of suites) {
    const parent = s.parent_id !== null ? byId.get(s.parent_id) ?? `#${s.parent_id}` : '(top-level)';
    console.log(`  [${s.id}] "${s.title}"  parent: ${parent}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exitCode = 1;
});
