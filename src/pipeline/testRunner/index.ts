import { PlaywrightTestRunner } from './playwrightRunner';
import { TestRunner } from './types';

export type { TestRunner, TestRunStatus, TestCaseResult, TestRunOptions, TestRunSummary } from './types';

let runner: TestRunner | null = null;

/**
 * Returns the configured test runner. Only Playwright exists today (no provider-selection switch
 * needed, unlike testmgmt's qase/testiny split) - same "one real implementation behind a
 * provider-agnostic factory" shape as requirements/index.ts's getRequirementsSource().
 */
export function getTestRunner(): TestRunner {
  if (runner) return runner;
  runner = new PlaywrightTestRunner();
  return runner;
}
