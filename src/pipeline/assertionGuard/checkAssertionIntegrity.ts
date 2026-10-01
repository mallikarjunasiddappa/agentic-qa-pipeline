import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { compareTestBlocks, extractTestBlocks, Finding } from './astDiff';
import { applySuppressions, FindingWithSuppression } from './suppression';

export interface FileContentPair {
  path: string;
  oldContent: string;
  newContent: string;
}

export interface FileCheckResult {
  path: string;
  results: FindingWithSuppression[];
}

export interface CheckResult {
  files: FileCheckResult[];
  unsuppressedCount: number;
}

/** Pure: no git/filesystem access, so this is directly unit-testable against synthetic content. */
export function runAssertionIntegrityCheck(files: FileContentPair[]): CheckResult {
  const fileResults: FileCheckResult[] = files.map(({ path, oldContent, newContent }) => {
    const oldBlocks = extractTestBlocks(oldContent, path);
    const newBlocks = extractTestBlocks(newContent, path);
    const findings: Finding[] = compareTestBlocks(oldBlocks, newBlocks);
    return { path, results: applySuppressions(findings, newContent) };
  });

  const unsuppressedCount = fileResults.reduce(
    (sum, f) => sum + f.results.filter((r) => !r.suppressed).length,
    0,
  );

  return { files: fileResults, unsuppressedCount };
}

function describeAnchor(finding: Finding): string {
  return finding.anchor.kind === 'line'
    ? `line ${finding.anchor.line}`
    : `test body, lines ${finding.anchor.bodyStartLine}-${finding.anchor.bodyEndLine}`;
}

export function buildReport(result: CheckResult): string {
  const lines: string[] = ['# Assertion Integrity Check', ''];
  const filesWithFindings = result.files.filter((f) => f.results.length > 0);

  if (filesWithFindings.length === 0) {
    lines.push('No assertion-integrity findings in the changed spec files.');
    return lines.join('\n');
  }

  for (const file of filesWithFindings) {
    lines.push(`## ${file.path}`, '');
    for (const { finding, suppressed, suppressionReason } of file.results) {
      const status = suppressed ? `SUPPRESSED (${suppressionReason})` : 'UNREVIEWED';
      lines.push(
        `- [${status}] ${finding.type} in "${finding.testTitle}" (${describeAnchor(finding)}): ${finding.message}`,
      );
    }
    lines.push('');
  }

  lines.push(
    result.unsuppressedCount === 0
      ? 'Every finding above is suppressed with a justification comment - nothing blocking.'
      : `${result.unsuppressedCount} unreviewed finding(s) above. Add an inline ` +
          '"// assertion-integrity: approved — <reason>" comment to sign off a deliberate change, or fix it.',
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

function getChangedSpecFiles(baseSha: string): string[] {
  const output = execFileSync(
    'git',
    ['diff', '--name-only', '--diff-filter=d', baseSha, '--', 'tests/**/*.spec.ts'],
    { encoding: 'utf-8' },
  );
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function getOldContent(baseSha: string, filePath: string): string {
  try {
    // stdio: 'pipe' (not the default inherit-stderr) - a missing-at-base-SHA error is expected
    // and handled below; letting git's raw "fatal:" line leak to the console would look like an
    // unhandled crash in CI logs even though the check completes successfully.
    return execFileSync('git', ['show', `${baseSha}:${filePath}`], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? '';
    if (stderr.includes('does not exist') || stderr.includes('exists on disk, but not in')) {
      return ''; // brand new file at this base - nothing to compare, all its tests are out of scope
    }
    throw err;
  }
}

/**
 * CLI entry point: resolves the PR base SHA, diffs changed tests/**\/*.spec.ts files against it,
 * and runs the pure check above. Old content comes from `git show <base-sha>:<path>`, new content
 * from the working tree - never a generic branch comparison.
 */
export function checkAssertionIntegrity(baseShaArg?: string): { exitCode: number; report: string } {
  const baseSha = resolveBaseSha(baseShaArg);
  const changedFiles = getChangedSpecFiles(baseSha);

  if (changedFiles.length === 0) {
    return { exitCode: 0, report: 'No tests/**/*.spec.ts files changed against the base SHA.' };
  }

  const files: FileContentPair[] = changedFiles.map((path) => ({
    path,
    oldContent: getOldContent(baseSha, path),
    newContent: fs.readFileSync(path, 'utf-8'),
  }));

  const result = runAssertionIntegrityCheck(files);
  return { exitCode: result.unsuppressedCount > 0 ? 1 : 0, report: buildReport(result) };
}
