import fs from 'node:fs';
import path from 'node:path';
import { getTestManagementClient } from '../src/pipeline/testmgmt';
import { env } from '../src/pipeline/config/env';
import { getJiraClient } from '../src/pipeline/jira/jiraClient';
import { loadManifest } from '../src/pipeline/traceability/manifestStore';

const DESCRIBE_RE = /test\.describe\(\s*['"`]([^'"`]+)['"`]/;

/**
 * One-off migration for cases created before Suite/Sub-suite support existed (see
 * TestManagementClient.moveCaseToSuite) - retroactively files a Jira ticket's existing cases into
 * the same Suite (ticket summary) > Sub-suite (test's `test.describe(...)` name) structure new
 * uploads get automatically via --stage tms-upload. Not a pipeline stage: this only ever needs
 * running once per already-uploaded ticket, not on every run.
 *
 * Provider-agnostic by construction: goes through getTestManagementClient() / moveCaseToSuite()
 * rather than a specific provider's client, so adding a new TMS_PROVIDER adapter never requires
 * touching this script. A provider with no suite/folder concept simply doesn't implement
 * moveCaseToSuite, and this script skips cleanly rather than erroring - see the check below.
 *
 * Sub-suite name comes from the test file's own `test.describe('<name>', ...)` block, not the
 * originating specs/<feature>.plan.md - the spec file a case was generated from may since have
 * been deleted (as happened for KAN-1's original demo specs), but the committed test file is a
 * permanent record of the group it belongs to.
 *
 * Usage: npx tsx scripts/migrateCasesToSuites.ts --issue KAN-1
 */
function parseIssueArg(): string {
  const idx = process.argv.indexOf('--issue');
  const issue = idx !== -1 ? process.argv[idx + 1] : undefined;
  if (!issue) {
    throw new Error('Usage: npx tsx scripts/migrateCasesToSuites.ts --issue <KEY>');
  }
  return issue;
}

function extractDescribeName(testFilePath: string): string | undefined {
  if (!fs.existsSync(testFilePath)) return undefined;
  const content = fs.readFileSync(testFilePath, 'utf-8');
  const match = content.match(DESCRIBE_RE);
  return match?.[1];
}

async function main(): Promise<void> {
  const issue = parseIssueArg();

  const tms = await getTestManagementClient();
  if (!tms.moveCaseToSuite) {
    console.log(
      `TMS_PROVIDER "${env.TMS_PROVIDER}" has no suite/folder concept (moveCaseToSuite not ` +
        'implemented) - nothing to migrate.',
    );
    return;
  }
  const moveCaseToSuite = tms.moveCaseToSuite.bind(tms);

  const manifest = loadManifest();
  const entries = manifest.entries.filter(
    (e) => e.jiraKey === issue && e.tmsProvider === env.TMS_PROVIDER,
  );
  if (entries.length === 0) {
    console.log(
      `No ${env.TMS_PROVIDER} entries for ${issue} in traceability/manifest.json - nothing to migrate.`,
    );
    return;
  }

  const jira = await getJiraClient();
  const issueData = await jira.getIssue(issue);
  const { summary } = jira.extractDescription(issueData);
  console.log(`Suite (top-level): "${summary}"`);

  let migrated = 0;
  let skipped = 0;

  for (const entry of entries) {
    const subTitle = extractDescribeName(path.normalize(entry.testFilePath));
    if (!subTitle) {
      console.log(
        `  SKIPPED case ${entry.externalCaseId} (${entry.testFilePath}) - no test.describe(...) found, ` +
          'or the test file no longer exists on disk.',
      );
      skipped += 1;
      continue;
    }

    await moveCaseToSuite(entry.externalCaseId, summary, subTitle);
    console.log(`  Moved case ${entry.externalCaseId} (${entry.testFilePath}) -> "${summary}" > "${subTitle}"`);
    migrated += 1;
  }

  console.log(`\nDone: ${migrated} case(s) migrated, ${skipped} skipped.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exitCode = 1;
});
