import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { loadPolicy } from '../config/policyStore';
import { findSuppressionComments } from '../shared/suppressionComment';
import { findNewTestBlocks, TestBlock } from '../shared/testBlocks';

export const RULE_TAG = 'required-tags';

export interface TagCoverageItem {
  path: string;
  testTitle: string;
  suppressed: boolean;
  suppressionReason: string | null;
}

export interface RequiredTagsCheckResult {
  items: TagCoverageItem[];
  unsuppressedCount: number;
}

export interface FileWithNewBlocks {
  path: string;
  content: string;
  newBlocks: TestBlock[];
}

// findNewTestBlocks moved to shared/testBlocks.ts once checkTraceabilityCoverage.ts needed the
// same answer. Re-exported here so existing importers and tests keep working unchanged.
export { findNewTestBlocks };

/** Reads the `tag: [...]` option's string literals off a TestBlock.source, without the `@` prefix
 * source uses (`'@regression'` -> `'regression'`) so it lines up with policy.json's
 * requiredTestTags, which are written bare (see PolicySchema's doc comment for why). */
function extractTags(source: string): string[] {
  const tagListMatch = source.match(/tag:\s*\[([^\]]*)\]/);
  if (!tagListMatch) return [];
  const tags: string[] = [];
  for (const m of tagListMatch[1].matchAll(/['"]@?([\w-]+)['"]/g)) {
    tags.push(m[1]);
  }
  return tags;
}

/**
 * Pure: no filesystem/git access. `requiredTags` empty means the rule is switched off entirely
 * (nothing to require), not "every test fails" - matches how an empty forbiddenPlaywrightPatterns
 * list means nothing is forbidden.
 *
 * Suppression (unlike the other two policy-driven guardrails) is intentional here: a seed test
 * genuinely isn't a scenario and shouldn't need a `@smoke`/`@regression`/`@critical` tag, so a
 * `// required-tags: approved — <reason>` comment (test-generation.md's seed convention already
 * uses the equivalent for traceability-coverage) is a legitimate, reviewed exception - unlike the
 * secrets and forbidden-pattern checks, which have none.
 */
export function runRequiredTagsCheck(
  files: FileWithNewBlocks[],
  requiredTags: string[],
): RequiredTagsCheckResult {
  if (requiredTags.length === 0) return { items: [], unsuppressedCount: 0 };

  const requiredSet = new Set(requiredTags);
  const items: TagCoverageItem[] = [];

  for (const file of files) {
    const suppressions = findSuppressionComments(file.content, RULE_TAG);
    const suppressed = suppressions.length > 0;
    const suppressionReason = suppressions[0]?.reason ?? null;

    for (const block of file.newBlocks) {
      const tags = extractTags(block.source);
      if (tags.some((t) => requiredSet.has(t))) continue;
      items.push({ path: file.path, testTitle: block.testTitle, suppressed, suppressionReason });
    }
  }

  const unsuppressedCount = items.filter((i) => !i.suppressed).length;
  return { items, unsuppressedCount };
}

export function buildReport(result: RequiredTagsCheckResult): string {
  const lines: string[] = ['# Required Test Tags Check', ''];

  if (result.items.length === 0) {
    lines.push('Every newly added test already carries a required tag.');
    return lines.join('\n');
  }

  for (const item of result.items) {
    const status = item.suppressed ? `SUPPRESSED (${item.suppressionReason})` : 'MISSING TAG';
    lines.push(`- [${status}] ${item.path} - test "${item.testTitle}"`);
  }
  lines.push('');

  lines.push(
    result.unsuppressedCount === 0
      ? 'Every untagged test above is suppressed with a justification comment - nothing blocking.'
      : `${result.unsuppressedCount} new test(s) above have none of policy.json's requiredTestTags ` +
          `in their { tag: [...] } option. Add one (e.g. { tag: ['@regression'] }), or if this test ` +
          `genuinely isn't a taggable scenario (e.g. a seed test), add ` +
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

/** Added, modified, or renamed tests/**\/*.spec.ts files - not deleted (diff-filter=ACMR) - since
 * a deleted file has no new blocks to check by definition. */
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

function readAtRef(ref: string, filePath: string): string {
  try {
    return execFileSync('git', ['show', `${ref}:${filePath}`], { encoding: 'utf-8' });
  } catch {
    return ''; // file did not exist at that ref
  }
}

/**
 * CLI entry point: resolves the PR base SHA, finds every changed tests/**\/*.spec.ts file, diffs
 * each one's test(...) blocks against its base-SHA version to find genuinely new scenarios (not
 * just newly-added files), and checks those against policy.json's requiredTestTags.
 */
export function checkRequiredTags(baseShaArg?: string): { exitCode: number; report: string } {
  const baseSha = resolveBaseSha(baseShaArg);
  const changedFiles = getChangedSpecFiles(baseSha);
  const policy = loadPolicy();

  if (changedFiles.length === 0 || policy.requiredTestTags.length === 0) {
    const result = runRequiredTagsCheck([], policy.requiredTestTags);
    return { exitCode: 0, report: buildReport(result) };
  }

  const files: FileWithNewBlocks[] = changedFiles.map((filePath) => {
    const after = fs.readFileSync(filePath, 'utf-8');
    const before = readAtRef(baseSha, filePath);
    return { path: filePath, content: after, newBlocks: findNewTestBlocks(before, after, filePath) };
  });

  const result = runRequiredTagsCheck(files, policy.requiredTestTags);
  return { exitCode: result.unsuppressedCount > 0 ? 1 : 0, report: buildReport(result) };
}
