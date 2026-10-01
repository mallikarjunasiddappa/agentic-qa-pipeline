import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { loadManifest } from '../traceability/manifestStore';
import { findSuppressionComments } from '../shared/suppressionComment';
import { findNewTestBlocks, findTestBlocks, TestBlock } from '../shared/testBlocks';

export const RULE_TAG = 'traceability-coverage';

/** What --stage traceability-record etc. already know about a linked test - just enough to match. */
export interface LinkedEntryRef {
  testFilePath: string;
  testTitle?: string;
}

export interface TestCoverageItem {
  path: string;
  // Which test(...) within `path` this item is about - null when the file has no identifiable
  // test(...) at all (e.g. empty, or mid-edit), so that case still gets flagged instead of
  // silently producing zero items for a file that matched the *.spec.ts glob.
  testTitle: string | null;
  suppressed: boolean;
  suppressionReason: string | null;
}

export interface CoverageCheckResult {
  items: TestCoverageItem[];
  unlinkedCount: number;
}

export interface CoverageCheckFile {
  path: string;
  content: string;
  /**
   * Restrict the check to these blocks - the tests that are genuinely NEW in this change.
   *
   * Omit it and every test in the file is checked, which is the behaviour this function has always
   * had and what a direct caller or a unit test wants. The CLI entry point supplies it, because
   * checking every test in a modified file would fail CI on historical debt nobody touched.
   */
  newBlocks?: TestBlock[];
}

/**
 * Pure: no filesystem/git access, so this is directly unit-testable against synthetic content.
 * `linkedEntries` is traceability/manifest.json's entries[] (testFilePath + optional testTitle) -
 * anything not among them has no Jira <-> TMS-case <-> test-file link, so drift-check will never
 * see it (see README's Team Usage section for the two real scenarios this catches: a hand-written
 * test that bypassed tms-upload/traceability-record entirely, or a manually-created TMS case that
 * got automated without ever running --stage traceability-link).
 *
 * Checks per-test, not per-file, since one spec file can now hold several scenarios under one
 * test.describe (see shared/testBlocks.ts) - a file with three tests where only one is unlinked
 * flags just that one, not its two already-linked siblings. An entry with no testTitle (from
 * before this field existed, or before scripts/backfillTestTitles.ts has been run locally) is
 * treated as covering the *whole* file - the same all-or-nothing behavior this check had before
 * per-test tracking existed - so nothing here requires the backfill to have run first.
 *
 * Suppression stays file-wide (a "// traceability-coverage: approved — <reason>" comment anywhere
 * in the file suppresses every unlinked test in it, not just the one nearest the comment) -
 * deliberately simple: a human adding this comment is making one deliberate exemption call for
 * that file, and the seed-file convention this was originally built for (test-generation.md) is a
 * single-test file where file-wide and test-wide are the same thing anyway.
 */
export function runTraceabilityCoverageCheck(
  files: CoverageCheckFile[],
  linkedEntries: LinkedEntryRef[],
): CoverageCheckResult {
  const wholeFileLinked = new Set<string>();
  const linkedTitlesByFile = new Map<string, Set<string>>();
  for (const e of linkedEntries) {
    if (e.testTitle === undefined) {
      wholeFileLinked.add(e.testFilePath);
      continue;
    }
    if (!linkedTitlesByFile.has(e.testFilePath)) linkedTitlesByFile.set(e.testFilePath, new Set());
    linkedTitlesByFile.get(e.testFilePath)!.add(e.testTitle);
  }

  const items: TestCoverageItem[] = [];
  for (const file of files) {
    if (wholeFileLinked.has(file.path)) continue;

    const suppressions = findSuppressionComments(file.content, RULE_TAG);
    const suppressed = suppressions.length > 0;
    const suppressionReason = suppressions[0]?.reason ?? null;

    // A file whose changes added no new test has nothing for this check to say. Distinct from a
    // file with no identifiable test at all, which is still worth flagging below.
    if (file.newBlocks !== undefined && file.newBlocks.length === 0) continue;

    const blocks = file.newBlocks ?? findTestBlocks(file.content, file.path);
    if (blocks.length === 0) {
      items.push({ path: file.path, testTitle: null, suppressed, suppressionReason });
      continue;
    }

    const linkedTitles = linkedTitlesByFile.get(file.path) ?? new Set<string>();
    for (const block of blocks) {
      if (linkedTitles.has(block.testTitle)) continue;
      items.push({ path: file.path, testTitle: block.testTitle, suppressed, suppressionReason });
    }
  }

  const unlinkedCount = items.filter((i) => !i.suppressed).length;
  return { items, unlinkedCount };
}

export function buildReport(result: CoverageCheckResult): string {
  const lines: string[] = ['# Traceability Coverage Check', ''];

  if (result.items.length === 0) {
    lines.push('Every newly added spec file already has a traceability/manifest.json entry.');
    return lines.join('\n');
  }

  for (const item of result.items) {
    const status = item.suppressed ? `SUPPRESSED (${item.suppressionReason})` : 'UNLINKED';
    const testRef = item.testTitle === null ? '(no test(...) found)' : `test "${item.testTitle}"`;
    lines.push(`- [${status}] ${item.path} - ${testRef}`);
  }
  lines.push('');

  lines.push(
    result.unlinkedCount === 0
      ? 'Every unlinked test above is suppressed with a justification comment - nothing blocking.'
      : `${result.unlinkedCount} new test(s) above have no traceability/manifest.json entry - ` +
          'drift-check will never see them. If this went through the normal pipeline, tms-upload ' +
          'auto-runs traceability-record, so check that actually happened. If the test was hand-written ' +
          'against an existing (or newly manual) TMS case, register it with `npm run traceability:link ' +
          '-- --issue <KEY> --external-case-id <id> --test-file <path> [--test-title "<exact test name>"]` ' +
          '(--test-title only needed if the file has more than one test). If this file is deliberately ' +
          `untracked (e.g. a proof-of-concept, not part of the real regression suite), add ` +
          `"// ${RULE_TAG}: approved — <reason>" anywhere in the file to suppress this check.`,
  );

  return lines.join('\n');
}

function resolveBaseSha(explicitBaseSha?: string): string {
  if (explicitBaseSha) return explicitBaseSha;

  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (eventPath && fs.existsSync(eventPath)) {
    const event = JSON.parse(fs.readFileSync(eventPath, 'utf-8')) as {
      pull_request?: { base?: { sha?: string } };
    };
    const sha = event.pull_request?.base?.sha;
    if (sha) return sha;
  }

  throw new Error(
    'No base SHA available - pass --base-sha <sha> explicitly, or run this in a GitHub Actions ' +
      'pull_request event (reads pull_request.base.sha from GITHUB_EVENT_PATH).',
  );
}

/**
 * Every added, copied, modified or renamed tests/**\/*.spec.ts file (--diff-filter=ACMR); not
 * deleted, which by definition has no new test to check.
 *
 * This used to be --diff-filter=A, brand-new FILES only. The reasoning was sound - a pre-existing
 * file shouldn't fail CI for historical debt on an unrelated edit - but the consequence was that
 * the most common way a test gets added, appending one more test(...) into an existing shared spec
 * file, was never checked at all. Not flagged, not warned: invisible, permanently.
 *
 * Both goals are satisfied by diffing the file's test BLOCKS against its base version rather than
 * its filename, which is what checkRequiredTags.ts already does. New tests are checked; untouched
 * old ones are not.
 */
function getChangedSpecFiles(baseSha: string): string[] {
  const output = execFileSync(
    'git',
    ['diff', '--name-only', '--diff-filter=ACMR', baseSha, '--', 'tests/**/*.spec.ts'],
    { encoding: 'utf-8' },
  );
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** That file's content at `ref`, or '' when it did not exist there. */
function readAtRef(ref: string, filePath: string): string {
  try {
    return execFileSync('git', ['show', `${ref}:${filePath}`], { encoding: 'utf-8' });
  } catch {
    return '';
  }
}

/**
 * CLI entry point: resolves the PR base SHA, finds newly-added tests/**\/*.spec.ts files against
 * it, and checks each against traceability/manifest.json's current entries.
 */
export function checkTraceabilityCoverage(baseShaArg?: string): { exitCode: number; report: string } {
  const baseSha = resolveBaseSha(baseShaArg);
  const changedFiles = getChangedSpecFiles(baseSha);

  if (changedFiles.length === 0) {
    return { exitCode: 0, report: 'No tests/**/*.spec.ts files changed against the base SHA.' };
  }

  const files: CoverageCheckFile[] = changedFiles.map((filePath) => {
    const after = fs.readFileSync(filePath, 'utf-8');
    const before = readAtRef(baseSha, filePath);
    return { path: filePath, content: after, newBlocks: findNewTestBlocks(before, after, filePath) };
  });

  const manifest = loadManifest();
  const linkedEntries: LinkedEntryRef[] = manifest.entries.map((e) => ({
    testFilePath: e.testFilePath,
    testTitle: e.testTitle,
  }));

  const result = runTraceabilityCoverageCheck(files, linkedEntries);
  return { exitCode: result.unlinkedCount > 0 ? 1 : 0, report: buildReport(result) };
}
