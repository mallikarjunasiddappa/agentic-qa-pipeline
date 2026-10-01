import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, runTraceabilityCoverageCheck, LinkedEntryRef } from './checkTraceabilityCoverage';

function singleTestFile(path: string, title = 'should log in successfully'): { path: string; content: string } {
  return {
    path,
    content: `import { test } from '@playwright/test';\ntest.describe('Group', () => {\n  test('${title}', async () => {});\n});\n`,
  };
}

test('runTraceabilityCoverageCheck: a linked test file is not flagged at all', () => {
  const files = [singleTestFile('tests/auth/should-log-in-successfully.spec.ts', 'should log in successfully')];
  const linked: LinkedEntryRef[] = [
    { testFilePath: 'tests/auth/should-log-in-successfully.spec.ts', testTitle: 'should log in successfully' },
  ];

  const result = runTraceabilityCoverageCheck(files, linked);
  assert.equal(result.items.length, 0);
  assert.equal(result.unlinkedCount, 0);
});

test('runTraceabilityCoverageCheck: an entry with no testTitle covers the whole file (legacy/pre-backfill)', () => {
  const files = [singleTestFile('tests/auth/should-log-in-successfully.spec.ts')];
  const linked: LinkedEntryRef[] = [{ testFilePath: 'tests/auth/should-log-in-successfully.spec.ts' }];

  const result = runTraceabilityCoverageCheck(files, linked);
  assert.equal(result.items.length, 0);
});

test('runTraceabilityCoverageCheck: an unlinked test file with no suppression counts as unlinked', () => {
  const files = [singleTestFile('tests/student/new-feature.spec.ts', 'does the new thing')];
  const result = runTraceabilityCoverageCheck(files, []);

  assert.equal(result.unlinkedCount, 1);
  assert.equal(result.items[0].suppressed, false);
  assert.equal(result.items[0].path, 'tests/student/new-feature.spec.ts');
  assert.equal(result.items[0].testTitle, 'does the new thing');
});

test('runTraceabilityCoverageCheck: flags only the unlinked test in a shared multi-test file, not its linked sibling', () => {
  const files = [
    {
      path: 'tests/student/profile.spec.ts',
      content: [
        "import { test } from '@playwright/test';",
        "test.describe('Student Profile', () => {",
        "  test('scenario a', async () => {});",
        "  test('scenario b', async () => {});",
        '});',
        '',
      ].join('\n'),
    },
  ];
  const linked: LinkedEntryRef[] = [{ testFilePath: 'tests/student/profile.spec.ts', testTitle: 'scenario a' }];

  const result = runTraceabilityCoverageCheck(files, linked);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].testTitle, 'scenario b');
});

test('runTraceabilityCoverageCheck: a file with no test(...) at all is still flagged, not silently skipped', () => {
  const files = [{ path: 'tests/broken.spec.ts', content: 'not actually a test file' }];
  const result = runTraceabilityCoverageCheck(files, []);

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].testTitle, null);
  assert.equal(result.unlinkedCount, 1);
});

test('runTraceabilityCoverageCheck: a suppression comment anywhere in the file clears every unlinked test in it', () => {
  const content = [
    '// traceability-coverage: approved — proof-of-concept, not part of the real regression suite',
    "import { test } from '@playwright/test';",
    "test.describe('Group', () => {",
    "  test('scenario a', async () => {});",
    "  test('scenario b', async () => {});",
    '});',
    '',
  ].join('\n');
  const files = [{ path: 'tests/test-data-demo/poc.spec.ts', content }];

  const result = runTraceabilityCoverageCheck(files, []);
  assert.equal(result.unlinkedCount, 0);
  assert.equal(result.items.length, 2);
  assert.ok(result.items.every((i) => i.suppressed));
  assert.match(result.items[0].suppressionReason ?? '', /proof-of-concept/);
});

test('runTraceabilityCoverageCheck: a suppression comment for a different rule tag does not clear it', () => {
  const content = [
    '// locator-priority: approved — wrong tag for this rule',
    "import { test } from '@playwright/test';",
    "test('scenario a', async () => {});",
  ].join('\n');
  const files = [{ path: 'tests/student/new-feature.spec.ts', content }];

  const result = runTraceabilityCoverageCheck(files, []);
  assert.equal(result.unlinkedCount, 1);
});

test('runTraceabilityCoverageCheck: a bare tag with no reason does not suppress', () => {
  const content = [
    '// traceability-coverage: approved —',
    "import { test } from '@playwright/test';",
    "test('scenario a', async () => {});",
  ].join('\n');
  const files = [{ path: 'tests/student/new-feature.spec.ts', content }];

  const result = runTraceabilityCoverageCheck(files, []);
  assert.equal(result.unlinkedCount, 1);
});

test('runTraceabilityCoverageCheck: aggregates across multiple files, linked ones excluded entirely', () => {
  const files = [
    singleTestFile('tests/a.spec.ts', 'a'),
    singleTestFile('tests/b.spec.ts', 'b'),
    {
      path: 'tests/c.spec.ts',
      content: "// traceability-coverage: approved — deliberate\nimport { test } from '@playwright/test';\ntest('c', async () => {});\n",
    },
  ];
  const linked: LinkedEntryRef[] = [{ testFilePath: 'tests/a.spec.ts', testTitle: 'a' }];

  const result = runTraceabilityCoverageCheck(files, linked);
  assert.equal(result.items.length, 2); // a.spec.ts never appears - it's linked
  assert.equal(result.unlinkedCount, 1); // only b.spec.ts is unlinked-and-unsuppressed
});

test('buildReport: clean-bill message when no files are flagged', () => {
  const result = runTraceabilityCoverageCheck([], []);
  assert.match(buildReport(result), /Every newly added spec file already has/);
});

test('buildReport: lists unlinked test with its title and mentions traceability:link remediation', () => {
  const result = runTraceabilityCoverageCheck(
    [singleTestFile('tests/student/new-feature.spec.ts', 'does the new thing')],
    [],
  );
  const report = buildReport(result);
  assert.match(report, /UNLINKED.*tests\/student\/new-feature\.spec\.ts.*does the new thing/);
  assert.match(report, /traceability:link/);
  assert.match(report, /--test-title/);
});

test('buildReport: shows SUPPRESSED status and reason for a suppressed test', () => {
  const content = "// traceability-coverage: approved — poc\nimport { test } from '@playwright/test';\ntest('x', async () => {});\n";
  const result = runTraceabilityCoverageCheck([{ path: 'tests/poc.spec.ts', content }], []);
  const report = buildReport(result);
  assert.match(report, /SUPPRESSED \(poc\)/);
  assert.match(report, /nothing blocking/);
});

test('buildReport: a file with no identifiable test renders "(no test(...) found)"', () => {
  const result = runTraceabilityCoverageCheck([{ path: 'tests/broken.spec.ts', content: 'nonsense' }], []);
  const report = buildReport(result);
  assert.match(report, /no test\(\.\.\.\) found/);
});


// --- new tests inside an existing file --------------------------------------------------------

const TWO_TESTS = `import { test } from '@playwright/test';
test.describe('Group', () => {
  test('an old linked test', async () => {});
  test('a brand new test', async () => {});
});
`;

test('runTraceabilityCoverageCheck: newBlocks restricts the check to genuinely new tests', () => {
  // The point of the fix: a test appended into an ALREADY-EXISTING spec file used to be invisible
  // to this guardrail, because it selected whole new files only. Checking every test in a changed
  // file instead would fail CI on historical debt nobody touched, so the check is scoped to the
  // blocks that are new relative to the base revision.
  const result = runTraceabilityCoverageCheck(
    [
      {
        path: 'tests/group.spec.ts',
        content: TWO_TESTS,
        newBlocks: [{ testTitle: 'a brand new test', source: '', startLine: 3 }],
      },
    ],
    [{ testFilePath: 'tests/group.spec.ts', testTitle: 'an old linked test' }],
  );

  assert.deepEqual(result.items.map((i) => i.testTitle), ['a brand new test']);
  assert.equal(result.unlinkedCount, 1);
});

test('runTraceabilityCoverageCheck: an unlinked OLD test is not flagged when it is not new', () => {
  const result = runTraceabilityCoverageCheck(
    [{ path: 'tests/group.spec.ts', content: TWO_TESTS, newBlocks: [] }],
    [],
  );
  assert.deepEqual(result.items, [], 'historical debt must not fail CI on an unrelated edit');
  assert.equal(result.unlinkedCount, 0);
});

test('runTraceabilityCoverageCheck: omitting newBlocks still checks every test in the file', () => {
  const result = runTraceabilityCoverageCheck(
    [{ path: 'tests/group.spec.ts', content: TWO_TESTS }],
    [],
  );
  assert.deepEqual(result.items.map((i) => i.testTitle), ['an old linked test', 'a brand new test']);
});

test('runTraceabilityCoverageCheck: a new test in a file linked whole-file is still not flagged', () => {
  const result = runTraceabilityCoverageCheck(
    [
      {
        path: 'tests/group.spec.ts',
        content: TWO_TESTS,
        newBlocks: [{ testTitle: 'a brand new test', source: '', startLine: 3 }],
      },
    ],
    [{ testFilePath: 'tests/group.spec.ts' }],
  );
  assert.deepEqual(result.items, []);
});
