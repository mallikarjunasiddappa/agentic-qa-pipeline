import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { MANIFEST_PATH } from '../traceability/manifestStore';

export const RULE_TAG = 'manifest-provenance';

/**
 * Every recognized way traceability/manifest.json is legitimately supposed to change. Kept as an
 * explicit allowlist (not "anything starting with traceability-") so adding a new stage later is a
 * deliberate one-line decision here, not an accident of naming - same allowlist-over-pattern-match
 * reasoning as testBlocks.ts's TEST_CALL_MODIFIERS.
 */
export const RECOGNIZED_MANIFEST_STAGES = [
  'traceability-record',
  'traceability-link',
  'traceability-unlink',
  'traceability-accept-baseline',
  'traceability-update-baseline',
  'drift-check',
  'rename-spec-file',
] as const;

// [ \t]* (not \s*) before the marker name - tolerates a commit message body indented with spaces
// or tabs (common from multi-line -m flags, some editors, and especially PowerShell's handling of
// embedded newlines - confirmed live: a real "   Traceability-Manual: ..." commit with 3 leading
// spaces failed this check before this fix) without also swallowing a leading blank line into the
// match, which \s* would do since it matches newlines too.
const STAGE_TRAILER_RE = /^[ \t]*Traceability-Stage:\s*(\S+)\s*$/m;
const MANUAL_TRAILER_RE = /^[ \t]*Traceability-Manual:\s*(.+)$/m;

export interface PrCommit {
  hash: string;
  message: string;
}

export interface ValidatingCommit {
  hash: string;
  subject: string;
  marker: string;
}

export interface ProvenanceCheckResult {
  manifestChanged: boolean;
  validatingCommits: ValidatingCommit[];
  ok: boolean;
}

function firstLine(message: string): string {
  return message.split('\n')[0].trim();
}

/**
 * Pure: no filesystem/git access, so this is directly unit-testable against synthetic commit
 * messages. traceability/manifest.json is this pipeline's audit trail - the same file
 * --stage traceability-unlink exists specifically to stop people hand-editing (see its own doc
 * comment in pipeline.ts). This check is the other half of that fix: catching the hand-edit itself,
 * not just providing a proper command as an alternative to it.
 *
 * Requires at least one commit in the PR to carry a recognized marker - not every commit that
 * touches the file, since in practice this project's own commits bundle a manifest.json change
 * together with the feature work that caused it in one descriptive commit, not a separate
 * stage-only commit. One explained commit is enough to account for the whole PR's manifest diff;
 * this does not attempt to attribute which specific entries came from which commit.
 *
 * Two recognized markers, read from anywhere in a commit's message (git trailer style, like
 * Co-authored-by:):
 *   - `Traceability-Stage: <stage>` - <stage> must be one of RECOGNIZED_MANIFEST_STAGES exactly;
 *     for when the change came from actually running that pipeline stage.
 *   - `Traceability-Manual: <reason>` - for a deliberate, reviewed hand-edit (rare - e.g. a one-time
 *     data migration) with a non-empty reason. Same "state your reason, don't just suppress" shape
 *     as the "// <rule-tag>: approved — <reason>" convention suppressionComment.ts already uses
 *     elsewhere in this codebase, adapted to a commit message since manifest.json is JSON and can't
 *     hold a comment itself.
 */
export function runManifestProvenanceCheck(
  manifestChanged: boolean,
  commits: PrCommit[],
): ProvenanceCheckResult {
  if (!manifestChanged) return { manifestChanged: false, validatingCommits: [], ok: true };

  const validatingCommits: ValidatingCommit[] = [];
  for (const commit of commits) {
    const stageMatch = commit.message.match(STAGE_TRAILER_RE);
    if (stageMatch && (RECOGNIZED_MANIFEST_STAGES as readonly string[]).includes(stageMatch[1])) {
      validatingCommits.push({
        hash: commit.hash,
        subject: firstLine(commit.message),
        marker: `Traceability-Stage: ${stageMatch[1]}`,
      });
      continue;
    }

    const manualMatch = commit.message.match(MANUAL_TRAILER_RE);
    if (manualMatch && manualMatch[1].trim().length > 0) {
      validatingCommits.push({
        hash: commit.hash,
        subject: firstLine(commit.message),
        marker: `Traceability-Manual: ${manualMatch[1].trim()}`,
      });
    }
  }

  return { manifestChanged: true, validatingCommits, ok: validatingCommits.length > 0 };
}

export function buildReport(result: ProvenanceCheckResult): string {
  const lines: string[] = ['# Manifest Provenance Check', ''];

  if (!result.manifestChanged) {
    lines.push('traceability/manifest.json was not changed in this PR - nothing to check.');
    return lines.join('\n');
  }

  if (result.ok) {
    lines.push(
      'traceability/manifest.json changed in this PR, and at least one commit explains why:',
      '',
    );
    for (const c of result.validatingCommits) {
      lines.push(`- \`${c.hash.slice(0, 7)}\` ${c.subject} (${c.marker})`);
    }
    return lines.join('\n');
  }

  lines.push(
    'traceability/manifest.json changed in this PR, but no commit message says why. This file is ' +
      "the pipeline's audit trail - drift-check, traceability-coverage-check, and every " +
      'traceability-* stage all trust it, so an unexplained edit (most often a hand-edit outside ' +
      'the normal pipeline stages) is exactly the kind of change that needs to be caught here, not ' +
      'discovered later as unexplained drift.',
    '',
    'Fix by amending the commit that changes this file to add one of these lines to its message:',
    '',
    `- \`Traceability-Stage: <stage>\` - if this came from actually running one of: ${RECOGNIZED_MANIFEST_STAGES.join(', ')}`,
    '- `Traceability-Manual: <reason>` - only for a deliberate, reviewed hand-edit; state why',
    '',
    'Example: `git commit --amend -m "$(git log -1 --pretty=%B)" -m "Traceability-Stage: traceability-unlink"`',
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

function didManifestChange(baseSha: string): boolean {
  const output = execFileSync('git', ['diff', '--name-only', baseSha, '--', MANIFEST_PATH()], {
    encoding: 'utf-8',
  });
  return output.trim().length > 0;
}

// Same RECORD_SEP/FIELD_SEP-plus-custom---format convention promptVersions/gitLog.ts already uses
// to parse commit messages unambiguously (a commit message's own text could otherwise collide with
// a naive newline-based split).
const RECORD_SEP = '\x01';
const FIELD_SEP = '\x1f';

function getPrCommits(baseSha: string): PrCommit[] {
  const raw = execFileSync(
    'git',
    ['log', `--format=${RECORD_SEP}%H${FIELD_SEP}%B`, `${baseSha}..HEAD`],
    { encoding: 'utf-8' },
  );
  return raw
    .split(RECORD_SEP)
    .map((record) => record.trim())
    .filter((record) => record.length > 0)
    .map((record) => {
      const [hash, ...rest] = record.split(FIELD_SEP);
      return { hash, message: rest.join(FIELD_SEP).trim() };
    });
}

/**
 * CLI entry point: resolves the PR base SHA, checks whether traceability/manifest.json changed
 * against it, and - only if it did - reads every commit in the PR's range for a recognized marker.
 */
export function checkManifestProvenance(baseShaArg?: string): { exitCode: number; report: string } {
  const baseSha = resolveBaseSha(baseShaArg);
  const manifestChanged = didManifestChange(baseSha);
  const commits = manifestChanged ? getPrCommits(baseSha) : [];
  const result = runManifestProvenanceCheck(manifestChanged, commits);
  return { exitCode: result.ok ? 0 : 1, report: buildReport(result) };
}
