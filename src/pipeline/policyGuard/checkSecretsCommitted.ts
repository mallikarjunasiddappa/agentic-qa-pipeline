import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { loadPolicy } from '../config/policyStore';

export const RULE_TAG = 'secrets-committed';

export interface SecretsCheckResult {
  matchedFiles: string[];
  ok: boolean;
}

/**
 * Pure: no filesystem/git access, so this is directly unit-testable. Exact basename match against
 * policy.json's forbiddenCommittedFilenames - not a glob or prefix match, so `.env.example` (a
 * real, intentionally-committed reference file in this repo) never collides with `.env`.
 *
 * Deliberately the one guardrail in this whole pipeline with **no suppression/override mechanism
 * at all** - every other guardrail here (Assertion Integrity, Locator Priority, Traceability
 * Coverage, Required Tags) accepts a `// <rule-tag>: approved — <reason>` comment for a genuine,
 * reviewed exception, because those rules have legitimate exceptions. A committed credential does
 * not: there is no scenario where the right fix is "acknowledge it and move on" instead of "remove
 * it from the PR (and rotate it, if it was ever pushed)". Giving this one an override would just
 * be a slower way to commit the secret anyway.
 */
export function runSecretsCommittedCheck(
  addedFilePaths: string[],
  forbiddenFilenames: string[],
): SecretsCheckResult {
  const forbiddenSet = new Set(forbiddenFilenames);
  const matchedFiles = addedFilePaths.filter((p) => forbiddenSet.has(path.basename(p)));
  return { matchedFiles, ok: matchedFiles.length === 0 };
}

export function buildReport(result: SecretsCheckResult): string {
  const lines: string[] = ['# Secrets Guardrail', ''];

  if (result.ok) {
    lines.push('No forbidden filenames were added in this PR.');
    return lines.join('\n');
  }

  lines.push(
    'This PR adds one or more files this project never allows to be committed - no exception, no ' +
      'suppression comment, no override. This is a hard block:',
    '',
  );
  for (const file of result.matchedFiles) {
    lines.push(`- ${file}`);
  }
  lines.push(
    '',
    'Fix by removing the file from this PR entirely: `git rm --cached <file>` (keep it on disk, ' +
      "just untrack it), add it to `.gitignore` if it isn't already, then amend/force-push. If any " +
      'of the above ever contained a real credential and this PR (or an earlier one) actually got ' +
      'pushed, treat that credential as compromised and rotate it - removing the file from git ' +
      "history afterward does not undo the fact that it was exposed.",
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
 * Every file newly added, copied or renamed INTO the repo anywhere (not scoped to tests/ - a
 * leaked credential is just as real under scripts/ or the repo root), via `--diff-filter=ACR`.
 *
 * Still not every changed file: a pre-existing file that predates this guardrail shouldn't
 * suddenly fail CI on an unrelated edit. But `R` matters and was missing - this check compares
 * BASENAMES, so renaming `notes.txt` to `.env.local` introduces a forbidden filename without
 * adding a file, and the added-only filter let that through silently.
 *
 * Note what this check still is: a forbidden-FILENAME check, not a secret scanner. A credential
 * pasted into an existing tracked file is invisible to it. Content scanning is a separate job.
 */
function getAddedFiles(baseSha: string): string[] {
  const output = execFileSync('git', ['diff', '--name-only', '--diff-filter=ACR', baseSha], {
    encoding: 'utf-8',
  });
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * CLI entry point: resolves the PR base SHA, finds newly-added files against it, and checks each
 * one's basename against policy.json's forbiddenCommittedFilenames.
 */
export function checkSecretsCommitted(baseShaArg?: string): { exitCode: number; report: string } {
  const baseSha = resolveBaseSha(baseShaArg);
  const addedFiles = getAddedFiles(baseSha);
  const policy = loadPolicy();
  const result = runSecretsCommittedCheck(addedFiles, policy.forbiddenCommittedFilenames);
  return { exitCode: result.ok ? 0 : 1, report: buildReport(result) };
}
