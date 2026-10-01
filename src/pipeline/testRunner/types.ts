// Provider-agnostic test-execution interface. Grounded in a real gap, not an existing partial
// abstraction: grep confirmed no src/pipeline code spawns `npx playwright test` today - agents run
// it directly via the Bash tool per their own instructions (generator-agent.md/healer-agent.md:
// "run the new test(s) once"), and CI runs it directly in .github/workflows/*.yml. This is the
// first real wrapper.
//
// Status values match Playwright's own TestStatus exactly (node_modules/playwright/types/test.d.ts)
// - not narrowed or renamed, since there's no other provider today to justify inventing a
// provider-agnostic vocabulary prematurely (unlike TmsResultStatus in testmgmt/types.ts, which
// deliberately drops Qase's 'invalid' status because a second real provider - Testiny - already
// existed to prove the abstraction needed to be narrower than any one provider's native vocabulary).

export type TestRunStatus = 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted';

export interface TestCaseResult {
  testFilePath: string;
  testTitle: string;
  status: TestRunStatus;
  durationMs: number;
  errorMessage?: string; // present when status is 'failed', 'timedOut', or 'interrupted'
}

export interface TestRunOptions {
  grep?: string; // title/tag filter, same semantics as `playwright test --grep`
  tags?: string[]; // e.g. ['@regression'] - maps to Playwright's tag-based filtering
  updateSnapshots?: boolean;
}

export interface TestRunSummary {
  results: TestCaseResult[];
  passed: number;
  failed: number;
  durationMs: number;
}

/**
 * Provider-agnostic surface every test-runner adapter implements. Only PlaywrightTestRunner
 * exists today (this codebase has exactly one test framework) - kept as an interface anyway for
 * the same reason RequirementsSource/TestManagementClient are interfaces despite starting with one
 * real implementation: callers (future Healer/Generator headless-conversion work, once budget
 * allows revisiting it - see the shelved Generator spike note) depend on TestRunner, not on
 * Playwright specifically.
 */
export interface TestRunner {
  runFile(testFilePath: string, options?: TestRunOptions): Promise<TestRunSummary>;
  runSuite(testDir: string, options?: TestRunOptions): Promise<TestRunSummary>;
}
