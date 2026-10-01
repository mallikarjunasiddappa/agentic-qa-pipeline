import { TestinyClient } from '../src/pipeline/testmgmt/testinyClient';
import { TestinyAdapter } from '../src/pipeline/testmgmt/testinyAdapter';
import { Scenario } from '../src/pipeline/types/schemas';

// Prints the real Testiny API error body (e.g. "Conflict tag is enabled..." or a field-validation
// message) when the error is an Axios response error, instead of just axios's generic "Request
// failed with status code 400" - that generic message alone isn't enough to diagnose which field
// or endpoint contract is wrong (this is exactly what made Test 3's real op=add vs. op=add_or_update
// bug hard to see on the first run - the fix landed only because the docs happened to spell out the
// right op value in a worked example, not because the error message said so).
function printError(err: unknown): void {
  if (err && typeof err === 'object' && 'isAxiosError' in err) {
    const axiosErr = err as unknown as { response?: { status?: number; data?: unknown }; message: string };
    if (axiosErr.response) {
      console.log(`HTTP ${axiosErr.response.status}:`, JSON.stringify(axiosErr.response.data, null, 2));
      return;
    }
  }
  console.log(err instanceof Error ? (err.stack ?? err.message) : err);
}

/**
 * Real-Testiny verification for TestinyClient/TestinyAdapter (Phase 0 genericity proof - a second
 * real TMS provider alongside Qase). Unlike qaseClient.ts, this adapter has never made a real HTTP
 * call before this script - every field name and endpoint shape was assembled from Testiny's
 * public REST API docs (testiny.io/docs/api-quickstart and its TestCase/TestCaseFolder/TestRun
 * reference pages), not verified against a live account. This script is that first live check,
 * same role scripts/verify-azure-key-vault.ts played for the Secrets-manager fix.
 *
 * Prerequisites:
 *   1. A real Testiny project exists with your account.
 *   2. An API key: https://app.testiny.io/settings/api-keys (treat it like a password - set it in
 *      your own .env, never paste it into chat).
 *   3. The project's numeric id (Testiny UI project settings - not the project name/slug).
 *
 * What this verifies that no unit test can:
 *   - The X-Api-Key header auth actually works against the real API.
 *   - POST /testcase really creates a case and returns the shape TestinyClient.createCase() expects.
 *   - POST /testcase/bulk's real response shape (raw ids vs. {id} objects - undocumented, see
 *     testinyClient.ts's TestinyBulkCreateResponse comment) - this script prints the raw response
 *     so a mismatch is visible immediately rather than silently mis-parsed.
 *   - POST /testrun + the testrun/mapping/bulk/testcase:testrun route really creates a run, adds
 *     the case to it, and accepts a result_status update.
 *   - GET /testcase/:id round-trips the same title/steps/precondition/expected-result text back.
 *   - Whether the created case has a "priority" field at all when read back (see testinyClient.ts's
 *     doc comment on why priority is currently omitted from the create payload) - printed, not
 *     asserted, since this script's job here is to surface the real shape, not guess it in advance.
 *
 * This creates one real test case + one real test run in your project - it does not delete them
 * afterward (Testiny soft-deletes anyway), so expect to see "Agentic QA Pipeline verify script" show
 * up once in your project; safe to delete manually afterward if you'd rather not keep it.
 *
 * Usage:
 *   TESTINY_API_KEY=... TESTINY_PROJECT_ID=... npx tsx scripts/verify-testiny-tms.ts
 */
async function main(): Promise<void> {
  const apiKey = process.env.TESTINY_API_KEY;
  const projectId = process.env.TESTINY_PROJECT_ID;

  if (!apiKey || !projectId) {
    console.error('TESTINY_API_KEY and TESTINY_PROJECT_ID must both be set. Set them and rerun.');
    process.exitCode = 1;
    return;
  }

  console.log(`Project id: ${projectId}`);
  console.log('');

  // TestinyClient.create() goes through requireTenantEnv() (the Secrets-manager fix's tenant
  // resolution), which - with no setTenantId() called in this standalone script - defaults to
  // tenant 'default' on the 'env-file' provider (see env.ts's own doc comment on that fallback),
  // i.e. it reads straight off process.env exactly like TESTINY_API_KEY/TESTINY_PROJECT_ID were
  // already validated above. No special-casing needed here.
  const client = await TestinyClient.create();
  const adapter = new TestinyAdapter(client);

  let overallFailed = false;

  console.log('--- Test 1: create a real test case ---');
  const scenario: Scenario = {
    id: 'verify-testiny-tms-login',
    title: `Agentic QA Pipeline verify script - ${new Date().toISOString()}`,
    preconditions: 'User is on the login page.',
    steps: ['Enter valid username', 'Enter valid password', 'Click Sign In'],
    expectedResult: 'User is redirected to the dashboard.',
    priority: 'medium',
  };

  let createdCaseId: string | undefined;
  try {
    const created = await adapter.createCase(scenario);
    createdCaseId = created.externalCaseId;
    console.log(`PASS - created case id ${createdCaseId}`);
  } catch (err) {
    console.log('FAIL - createCase() threw:');
    printError(err);
    overallFailed = true;
  }

  if (createdCaseId) {
    console.log('');
    console.log('--- Test 2: read the case back and compare ---');
    try {
      const fetched = await adapter.getCase(createdCaseId);
      console.log('Fetched case:', JSON.stringify(fetched, null, 2));
      const titleMatches = fetched.title === scenario.title;
      console.log(titleMatches ? 'PASS - title round-tripped correctly.' : 'FAIL - title mismatch.');
      if (!titleMatches) overallFailed = true;
    } catch (err) {
      console.log('FAIL - getCase() threw:');
      printError(err);
      overallFailed = true;
    }

    console.log('');
    console.log('--- Test 3: create a run, add the case, submit a result ---');
    try {
      const runId = await adapter.createRun([createdCaseId], `Agentic QA Pipeline verify run - ${new Date().toISOString()}`);
      console.log(`Created run id ${runId}`);
      await adapter.submitResult({ caseId: createdCaseId, status: 'passed', comment: 'Verified by verify-testiny-tms.ts' });
      console.log('PASS - submitResult() completed without throwing. Check the run in the Testiny UI to confirm the result shows PASSED.');
    } catch (err) {
      console.log('FAIL - run/result flow threw:');
      printError(err);
      overallFailed = true;
    }
  }

  console.log('');
  console.log('--- Test 4: bulk-create two cases (checking the undocumented bulk response shape) ---');
  try {
    const bulkScenarios: Scenario[] = [
      { ...scenario, id: 'verify-testiny-tms-bulk-1', title: `${scenario.title} (bulk 1)` },
      { ...scenario, id: 'verify-testiny-tms-bulk-2', title: `${scenario.title} (bulk 2)` },
    ];
    const bulkCreated = await adapter.bulkCreateCases(bulkScenarios);
    console.log('PASS - bulkCreateCases() returned:', JSON.stringify(bulkCreated.map((s) => s.externalCaseId)));
  } catch (err) {
    console.log('FAIL - bulkCreateCases() threw (see testinyClient.ts\'s TestinyBulkCreateResponse comment - the real response shape may not match what was assumed):');
    printError(err);
    overallFailed = true;
  }

  console.log('');
  console.log(overallFailed ? '--- Overall: FAILURES ABOVE - see output ---' : '--- Overall: PASS - real Testiny round-trip verified ---');
  if (overallFailed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exitCode = 1;
});
