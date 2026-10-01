import { getTestManagementClient } from '../src/pipeline/testmgmt';
import { env } from '../src/pipeline/config/env';

const DEFAULT_SUITE = 'Implementation Conditional CAPTCHA Bases on User Email Domain';
const DEFAULT_PARENT = 'Student Authentication';

/**
 * One-off reorg: re-parents an already-existing top-level suite under a different top-level suite
 * (found-or-created by title) - see TestManagementClient.moveSuiteUnderParent. Distinct from
 * scripts/moveAutomatedCasesToSuite.ts, which moves individual *cases*, not a whole suite.
 *
 * Usage:
 *   npx tsx scripts/moveSuiteUnderParent.ts
 *   npx tsx scripts/moveSuiteUnderParent.ts --suite "..." --parent "Student Authentication"
 */
function parseArgs(): { suite: string; parent: string } {
  const args = process.argv.slice(2);
  const suiteIdx = args.indexOf('--suite');
  const parentIdx = args.indexOf('--parent');
  return {
    suite: suiteIdx !== -1 ? args[suiteIdx + 1] : DEFAULT_SUITE,
    parent: parentIdx !== -1 ? args[parentIdx + 1] : DEFAULT_PARENT,
  };
}

async function main(): Promise<void> {
  const { suite, parent } = parseArgs();

  const tms = await getTestManagementClient();
  if (!tms.moveSuiteUnderParent) {
    console.log(
      `TMS_PROVIDER "${env.TMS_PROVIDER}" has no suite/folder concept (moveSuiteUnderParent not ` +
        'implemented) - nothing to re-parent.',
    );
    return;
  }

  console.log(`Re-parenting suite "${suite}" under "${parent}"...`);
  await tms.moveSuiteUnderParent(suite, parent);
  console.log(`Done: "${suite}" is now nested under "${parent}".`);
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exitCode = 1;
});
