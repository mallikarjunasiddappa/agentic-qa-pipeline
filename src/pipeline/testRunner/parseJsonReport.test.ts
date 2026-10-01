import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJsonReport } from './parseJsonReport';
import type { JSONReport } from 'playwright/types/testReporter';

/**
 * Builds a minimal-but-shape-accurate fake JSONReport, using only the fields parseJsonReport
 * actually reads (real field names/nesting confirmed against the installed
 * node_modules/playwright/types/testReporter.d.ts, not guessed).
 */
function fakeReport(overrides: Partial<JSONReport> = {}): JSONReport {
  return {
    config: {} as JSONReport['config'],
    errors: [],
    stats: { startTime: '2026-08-25T00:00:00.000Z', duration: 1234, expected: 1, unexpected: 0, flaky: 0, skipped: 0 },
    suites: [],
    ...overrides,
  };
}

test('parseJsonReport flattens a passing spec at the top level', () => {
  const report = fakeReport({
    suites: [
      {
        title: 'should-log-in.spec.ts',
        file: 'tests/auth/should-log-in.spec.ts',
        line: 0,
        column: 0,
        specs: [
          {
            tags: [],
            title: 'should log in',
            ok: true,
            id: 'a1',
            file: 'tests/auth/should-log-in.spec.ts',
            line: 5,
            column: 1,
            tests: [
              {
                timeout: 30000,
                annotations: [],
                expectedStatus: 'passed',
                projectName: 'chromium',
                projectId: 'chromium',
                status: 'expected',
                results: [
                  {
                    workerIndex: 0,
                    parallelIndex: 0,
                    status: 'passed',
                    duration: 842,
                    error: undefined,
                    errors: [],
                    stdout: [],
                    stderr: [],
                    retry: 0,
                    startTime: '2026-08-25T00:00:00.000Z',
                    attachments: [],
                    annotations: [],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  });

  const summary = parseJsonReport(report);

  assert.deepEqual(summary.results, [
    {
      testFilePath: 'tests/auth/should-log-in.spec.ts',
      testTitle: 'should log in',
      status: 'passed',
      durationMs: 842,
      errorMessage: undefined,
    },
  ]);
  assert.equal(summary.passed, 1);
  assert.equal(summary.failed, 0);
  assert.equal(summary.durationMs, 1234);
});

test('parseJsonReport walks nested describe-block sub-suites and surfaces a failing test error', () => {
  const report = fakeReport({
    suites: [
      {
        title: 'should-reject-login.spec.ts',
        file: 'tests/auth/should-reject-login.spec.ts',
        line: 0,
        column: 0,
        specs: [],
        suites: [
          {
            title: 'Auth - Login',
            file: 'tests/auth/should-reject-login.spec.ts',
            line: 2,
            column: 1,
            specs: [
              {
                tags: ['@regression'],
                title: 'should reject login with invalid credentials',
                ok: false,
                id: 'b2',
                file: 'tests/auth/should-reject-login.spec.ts',
                line: 6,
                column: 3,
                tests: [
                  {
                    timeout: 30000,
                    annotations: [],
                    expectedStatus: 'passed',
                    projectName: 'chromium',
                    projectId: 'chromium',
                    status: 'unexpected',
                    results: [
                      {
                        workerIndex: 0,
                        parallelIndex: 0,
                        status: 'failed',
                        duration: 501,
                        error: { message: 'expect(received).toBe(expected)' },
                        errors: [{ message: 'expect(received).toBe(expected)' }],
                        stdout: [],
                        stderr: [],
                        retry: 0,
                        startTime: '2026-08-25T00:00:00.000Z',
                        attachments: [],
                        annotations: [],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  });

  const summary = parseJsonReport(report);

  assert.equal(summary.results.length, 1);
  assert.equal(summary.results[0].status, 'failed');
  assert.equal(summary.results[0].errorMessage, 'expect(received).toBe(expected)');
  assert.equal(summary.passed, 0);
  assert.equal(summary.failed, 1);
});

test('parseJsonReport keeps only the last result when a test was retried', () => {
  const report = fakeReport({
    suites: [
      {
        title: 'flaky.spec.ts',
        file: 'tests/flaky.spec.ts',
        line: 0,
        column: 0,
        specs: [
          {
            tags: [],
            title: 'eventually passes',
            ok: true,
            id: 'c3',
            file: 'tests/flaky.spec.ts',
            line: 1,
            column: 1,
            tests: [
              {
                timeout: 30000,
                annotations: [],
                expectedStatus: 'passed',
                projectName: 'chromium',
                projectId: 'chromium',
                status: 'flaky',
                results: [
                  {
                    workerIndex: 0,
                    parallelIndex: 0,
                    status: 'failed',
                    duration: 300,
                    error: { message: 'timeout' },
                    errors: [{ message: 'timeout' }],
                    stdout: [],
                    stderr: [],
                    retry: 0,
                    startTime: '2026-08-25T00:00:00.000Z',
                    attachments: [],
                    annotations: [],
                  },
                  {
                    workerIndex: 0,
                    parallelIndex: 0,
                    status: 'passed',
                    duration: 400,
                    error: undefined,
                    errors: [],
                    stdout: [],
                    stderr: [],
                    retry: 1,
                    startTime: '2026-08-25T00:00:01.000Z',
                    attachments: [],
                    annotations: [],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  });

  const summary = parseJsonReport(report);

  assert.equal(summary.results.length, 1);
  assert.equal(summary.results[0].status, 'passed');
  assert.equal(summary.results[0].durationMs, 400);
  assert.equal(summary.passed, 1);
});

test('parseJsonReport skips a spec with zero results (never actually run)', () => {
  const report = fakeReport({
    suites: [
      {
        title: 'skipped.spec.ts',
        file: 'tests/skipped.spec.ts',
        line: 0,
        column: 0,
        specs: [
          {
            tags: [],
            title: 'not run at all',
            ok: true,
            id: 'd4',
            file: 'tests/skipped.spec.ts',
            line: 1,
            column: 1,
            tests: [
              {
                timeout: 30000,
                annotations: [],
                expectedStatus: 'skipped',
                projectName: 'chromium',
                projectId: 'chromium',
                status: 'skipped',
                results: [],
              },
            ],
          },
        ],
      },
    ],
  });

  const summary = parseJsonReport(report);

  assert.equal(summary.results.length, 0);
});
