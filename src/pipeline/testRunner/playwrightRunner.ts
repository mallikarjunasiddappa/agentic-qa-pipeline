import { execFileSync } from 'node:child_process';
import type { JSONReport } from 'playwright/types/testReporter';
import { parseJsonReport } from './parseJsonReport';
import { TestRunner, TestRunOptions, TestRunSummary } from './types';

/**
 * Shells out to `npx playwright test <target> --reporter=json`, same execFileSync-based
 * process-spawning boundary every guardrail check already uses (see e.g. gitLog.ts,
 * checkManifestProvenance.ts) - not unit tested directly for the same reason those aren't: it's a
 * thin wrapper around a real subprocess, verified by actually running it (see this branch's PR
 * description for a real run against this repo's own suite), not by mocking child_process.
 * parseJsonReport.ts holds all the actually-testable logic and IS unit tested.
 *
 * Playwright's own JSON reporter exits non-zero when any test fails - execFileSync throws in that
 * case, but the JSON report was still written to stdout before the process exited, so the catch
 * block reads it off the thrown error's own .stdout rather than treating a failing test run as a
 * script failure. A genuine invocation failure (bad path, playwright itself not installed) throws
 * with no parseable stdout, which is allowed to propagate rather than being swallowed into a fake
 * all-failed summary.
 */
export class PlaywrightTestRunner implements TestRunner {
  constructor(private readonly cwd: string = process.cwd()) {}

  async runFile(testFilePath: string, options?: TestRunOptions): Promise<TestRunSummary> {
    return this.run(testFilePath, options);
  }

  async runSuite(testDir: string, options?: TestRunOptions): Promise<TestRunSummary> {
    return this.run(testDir, options);
  }

  private async run(target: string, options?: TestRunOptions): Promise<TestRunSummary> {
    const args = ['playwright', 'test', target, '--reporter=json'];
    if (options?.grep) args.push('--grep', options.grep);
    if (options?.tags) {
      for (const tag of options.tags) args.push('--grep', tag);
    }
    if (options?.updateSnapshots) args.push('--update-snapshots');

    let stdout: string;
    try {
      stdout = execFileSync('npx', args, { cwd: this.cwd, encoding: 'utf-8' });
    } catch (err) {
      const stdoutFromError = (err as { stdout?: string | Buffer }).stdout;
      if (!stdoutFromError) throw err; // genuine invocation failure - nothing to parse, let it propagate
      stdout = stdoutFromError.toString();
    }

    const report: JSONReport = JSON.parse(stdout);
    return parseJsonReport(report);
  }
}
