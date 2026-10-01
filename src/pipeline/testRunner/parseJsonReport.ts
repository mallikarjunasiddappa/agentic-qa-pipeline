import type { JSONReport, JSONReportSuite } from 'playwright/types/testReporter';
import { TestCaseResult, TestRunSummary } from './types';

/**
 * Pure: takes an already-parsed Playwright JSONReport object, no filesystem/process access - same
 * "pure logic separated from the process-spawning boundary" split every guardrail check in
 * assertionGuard/traceabilityGuard/policyGuard already uses (see e.g.
 * checkForbiddenPlaywrightPatterns.ts's runForbiddenPatternsCheck), so this is directly
 * unit-testable against a hand-built fake report instead of needing a real Playwright run.
 *
 * Playwright's JSONReportSuite nests recursively (a file-level suite can itself contain
 * describe-block sub-suites, each with their own specs and possibly further sub-suites) - walked
 * here depth-first so a describe-nested spec.title is still just that block's own title (matching
 * what --reporter=list already shows), not a synthetic concatenation of parent titles.
 *
 * Only each spec's LAST result (results[results.length - 1]) is kept, not every retry - this
 * mirrors what a caller actually wants to know ("did it pass in the end"), with retry count
 * implicitly visible via results.length if a future caller needs it. Playwright's own JSONReport
 * always has at least one result per test (a spec with zero results wouldn't have been run at all,
 * so it's skipped rather than synthesized into a fake result).
 */
export function parseJsonReport(report: JSONReport): TestRunSummary {
  const results: TestCaseResult[] = [];

  function walkSuite(suite: JSONReportSuite): void {
    for (const spec of suite.specs) {
      for (const test of spec.tests) {
        const lastResult = test.results[test.results.length - 1];
        if (!lastResult || !lastResult.status) continue;
        results.push({
          testFilePath: spec.file,
          testTitle: spec.title,
          status: lastResult.status,
          durationMs: lastResult.duration,
          errorMessage: lastResult.error?.message ?? lastResult.errors[0]?.message,
        });
      }
    }
    for (const childSuite of suite.suites ?? []) {
      walkSuite(childSuite);
    }
  }

  for (const suite of report.suites) {
    walkSuite(suite);
  }

  const passed = results.filter((r) => r.status === 'passed').length;
  const failed = results.filter((r) => r.status !== 'passed' && r.status !== 'skipped').length;

  return { results, passed, failed, durationMs: report.stats.duration };
}
