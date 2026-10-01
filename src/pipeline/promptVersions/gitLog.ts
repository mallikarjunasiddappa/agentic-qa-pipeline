import { execFileSync } from 'node:child_process';

export interface PromptVersionCommit {
  sha: string;
  shortSha: string;
  author: string;
  date: string; // ISO
  message: string; // first line only
  path: string; // path as of that commit - captures qase-agent.md's pre-rename path for tms-agent.md's history
  insertions: number;
  deletions: number;
}

const RECORD_SEP = '\x01';
const FIELD_SEP = '\x1f';

/**
 * git's default rename-detection similarity threshold (50%) misses the real rename this feature
 * has to handle: .claude/agents/qase-agent.md -> tms-agent.md is only ~20-25% similar (rewritten
 * during the generic-TMS-provider work, not just renamed), confirmed empirically with
 * `git diff -M<pct>%` against this repo's actual history. `--follow` silently stops at the rename
 * under the default threshold. 20% is explicit and low enough to catch that real case.
 */
const RENAME_SIMILARITY = '-M20%';

/** Un-abbreviates git's numstat rename shorthand (`dir/{old => new}` or `old/path => new/path`). */
function resolveNumstatPath(rawPath: string): string {
  const braceMatch = rawPath.match(/^(.*)\{(.*) => (.*)\}(.*)$/);
  if (braceMatch) {
    const [, prefix, , newSuffix, suffix] = braceMatch;
    return `${prefix}${newSuffix}${suffix}`;
  }
  const arrowIndex = rawPath.indexOf(' => ');
  if (arrowIndex !== -1) {
    return rawPath.slice(arrowIndex + 4);
  }
  return rawPath;
}

/**
 * Parses the raw stdout of `git log --format=<RECORD_SEP><fields...> --numstat`, one record per
 * commit. Pure/no I/O so it can be tested against fixture text, not just live git output.
 */
export function parseGitLogOutput(raw: string, fallbackPath: string): PromptVersionCommit[] {
  const records = raw.split(RECORD_SEP).filter((r) => r.trim().length > 0);
  const commits: PromptVersionCommit[] = [];

  for (const record of records) {
    const lines = record.split('\n').filter((l) => l.length > 0);
    if (lines.length === 0) continue;

    const [sha, shortSha, author, date, message] = lines[0].split(FIELD_SEP);
    if (!sha) continue;

    const numstatLine = lines.slice(1).find((l) => /^[\d-]+\t[\d-]+\t/.test(l));
    let insertions = 0;
    let deletions = 0;
    let path = fallbackPath;
    if (numstatLine) {
      const [insRaw, delRaw, rawPath] = numstatLine.split('\t');
      insertions = insRaw === '-' ? 0 : Number(insRaw);
      deletions = delRaw === '-' ? 0 : Number(delRaw);
      path = resolveNumstatPath(rawPath);
    }

    commits.push({ sha, shortSha, author, date, message, path, insertions, deletions });
  }

  return commits;
}

/**
 * Runs `git log --follow` for exactly one agent file - never once against the whole
 * `.claude/agents/` directory, which breaks rename-following - via execFileSync (not a shell
 * string) to avoid shell-injection risk on the file path. Never calls `git fetch`/`git pull`:
 * only local refs/objects already in `.git/` are needed, and network calls have failed in this
 * sandboxed context before.
 */
export function getCommitHistory(filePath: string, cwd: string = process.cwd()): PromptVersionCommit[] {
  const format = `${RECORD_SEP}%H${FIELD_SEP}%h${FIELD_SEP}%an${FIELD_SEP}%aI${FIELD_SEP}%s`;
  const output = execFileSync(
    'git',
    ['log', '--follow', RENAME_SIMILARITY, `--format=${format}`, '--numstat', '--', filePath],
    { cwd, encoding: 'utf-8' },
  );
  return parseGitLogOutput(output, filePath);
}
