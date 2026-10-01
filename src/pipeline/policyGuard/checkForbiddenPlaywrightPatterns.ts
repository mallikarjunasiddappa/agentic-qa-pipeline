import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { loadPolicy } from '../config/policyStore';

export const RULE_TAG = 'forbidden-playwright-patterns';

export interface FileAddedLines {
  path: string;
  lines: string[];
}

export interface PatternMatch {
  path: string;
  line: string;
  pattern: string;
}

export interface ForbiddenPatternsCheckResult {
  matches: PatternMatch[];
  ok: boolean;
}

/**
 * Pure: no filesystem/git access, so this is directly unit-testable. Only checks *added* lines
 * (see getAddedLinesByFile below), not the whole file's current content, so a pre-existing
 * `page.waitForTimeout(...)` that predates this guardrail doesn't suddenly fail CI on an unrelated
 * edit elsewhere in the same file - same added-only reasoning every other guardrail here uses,
 * applied at line granularity instead of file granularity since these patterns can appear anywhere
 * in an existing multi-test shared file.
 *
 * Substring match against policy.json's forbiddenPlaywrightPatterns, not a regex engine -
 * deliberately, so policy.json stays editable by someone who doesn't want to think about regex
 * escaping. No suppression/override: AGENTS.md states these as absolute ("ever", "use locator
 * auto-waiting") with no stated per-case exception, unlike the locator-priority rule (which
 * explicitly allows "approved in PR").
 */
export function runForbiddenPatternsCheck(
  filesWithAddedLines: FileAddedLines[],
  forbiddenPatterns: string[],
): ForbiddenPatternsCheckResult {
  const matches: PatternMatch[] = [];
  for (const file of filesWithAddedLines) {
    for (const line of file.lines) {
      for (const pattern of forbiddenPatterns) {
        if (line.includes(pattern)) {
          matches.push({ path: file.path, line: line.trim(), pattern });
        }
      }
    }
  }
  return { matches, ok: matches.length === 0 };
}

export function buildReport(result: ForbiddenPatternsCheckResult): string {
  const lines: string[] = ['# Forbidden Playwright Patterns Check', ''];

  if (result.ok) {
    lines.push('No newly-added lines use a forbidden Playwright pattern.');
    return lines.join('\n');
  }

  lines.push(
    'This PR adds one or more forbidden Playwright patterns (AGENTS.md\'s Assertion rules / ' +
      'Forbidden sections - no `page.waitForTimeout`, no `waitForSelector`, no `page.pause()` in ' +
      'committed code). No suppression comment applies here - fix the test instead:',
    '',
  );
  for (const m of result.matches) {
    lines.push(`- ${m.path}: \`${m.pattern}\` in \`${m.line}\``);
  }
  lines.push(
    '',
    'Replace `page.waitForTimeout`/`waitForSelector` with a web-first assertion or locator ' +
      'auto-waiting, and remove `page.pause()` before committing.',
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
 * Parses `git diff --unified=0` output into just the added lines (`+` prefix, excluding the
 * `+++`/`---` file-header lines) grouped by file - a minimal enough diff parser for this purpose
 * without pulling in a diff-parsing dependency. `--unified=0` means no surrounding context lines
 * are present to misparse as additions.
 */
function getAddedLinesByFile(baseSha: string): FileAddedLines[] {
  const raw = execFileSync(
    'git',
    ['diff', '--unified=0', baseSha, '--', 'tests/**/*.spec.ts'],
    { encoding: 'utf-8' },
  );

  const result: FileAddedLines[] = [];
  let currentFile: string | null = null;
  let currentLines: string[] = [];

  const flush = () => {
    if (currentFile) result.push({ path: currentFile, lines: currentLines });
  };

  for (const line of raw.split('\n')) {
    const fileHeaderMatch = line.match(/^\+\+\+ b\/(.+)$/);
    if (fileHeaderMatch) {
      flush();
      currentFile = fileHeaderMatch[1];
      currentLines = [];
      continue;
    }
    if (line.startsWith('+++') || line.startsWith('---')) continue; // other diff headers
    if (currentFile && line.startsWith('+')) currentLines.push(line.slice(1));
  }
  flush();

  return result;
}

/**
 * CLI entry point: resolves the PR base SHA, diffs tests/**\/*.spec.ts against it, and checks
 * every added line against policy.json's forbiddenPlaywrightPatterns.
 */
export function checkForbiddenPlaywrightPatterns(baseShaArg?: string): { exitCode: number; report: string } {
  const baseSha = resolveBaseSha(baseShaArg);
  const filesWithAddedLines = getAddedLinesByFile(baseSha);
  const policy = loadPolicy();
  const result = runForbiddenPatternsCheck(filesWithAddedLines, policy.forbiddenPlaywrightPatterns);
  return { exitCode: result.ok ? 0 : 1, report: buildReport(result) };
}
