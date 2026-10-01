import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { MANIFEST_PATH } from '../traceability/manifestStore';

export const RULE_TAG = 'spec-file-consolidation';

/**
 * One Jira ticket's spec-file footprint before and after this PR, read from
 * traceability/manifest.json's entries at the PR's base SHA and at HEAD. This is deliberately the
 * same source of truth Traceability Coverage and Manifest Provenance already trust - it is
 * tool-agnostic by construction: the manifest only records (jiraKey, testFilePath) pairs, not which
 * agent or IDE produced the commit, so a PR authored by this project's own Generator Agent, by a
 * teammate's Antigravity/Gemini session, or by hand is judged identically here.
 */
export interface JiraFileSnapshot {
  jiraKey: string;
  filesBefore: string[];
  filesAfter: string[];
}

export interface SplitJiraKey {
  jiraKey: string;
  files: string[];
}

export interface PrCommit {
  hash: string;
  message: string;
}

export interface ValidatingCommit {
  hash: string;
  subject: string;
  jiraKey: string;
  reason: string;
}

export interface ConsolidationCheckResult {
  splitKeys: SplitJiraKey[];
  validatingCommits: ValidatingCommit[];
  unexplainedKeys: SplitJiraKey[];
  ok: boolean;
}

function firstLine(message: string): string {
  return message.split('\n')[0].trim();
}

/**
 * A ticket only needs explaining when this PR is the one that *grew* it past one file - not merely
 * because it already has more than one file from a previously-explained PR. Without the "grew"
 * condition, every later PR that adds one more scenario to an already-split ticket's existing files
 * would be flagged again for a decision that was already made and committed once.
 */
export function computeSplitKeys(snapshots: JiraFileSnapshot[]): SplitJiraKey[] {
  const result: SplitJiraKey[] = [];
  for (const snapshot of snapshots) {
    const filesAfter = [...new Set(snapshot.filesAfter)].sort();
    const filesBeforeSet = new Set(snapshot.filesBefore);
    const grew = filesAfter.some((f) => !filesBeforeSet.has(f));
    if (filesAfter.length > 1 && grew) {
      result.push({ jiraKey: snapshot.jiraKey, files: filesAfter });
    }
  }
  return result;
}

// Same "leading whitespace tolerant, but don't swallow blank lines" shape the leading-whitespace
// bug in checkManifestProvenance.ts's markers taught this project the hard way - [ \t]*, not \s*.
// Format: `Spec-File-Split: <jiraKey>: <reason>` - colon-delimited rather than a dash, so there is
// no ambiguity between a literal hyphen inside a reason and the field separator.
const SPLIT_TRAILER_RE = /^[ \t]*Spec-File-Split:\s*(\S+):\s*(.+)$/gm;

/**
 * Pure: no filesystem/git access, so this is directly unit-testable against synthetic snapshots and
 * commit messages. Mirrors checkManifestProvenance.ts's "at least one commit in the PR's range
 * explains it" shape: one deliberate `Spec-File-Split: <KEY>: <reason>` trailer is enough to account
 * for one jiraKey's split, wherever in the PR it landed - this does not attempt to attribute which
 * commit added which file.
 */
export function runSpecFileConsolidationCheck(
  snapshots: JiraFileSnapshot[],
  commits: PrCommit[],
): ConsolidationCheckResult {
  const splitKeys = computeSplitKeys(snapshots);
  if (splitKeys.length === 0) {
    return { splitKeys: [], validatingCommits: [], unexplainedKeys: [], ok: true };
  }

  const splitKeySet = new Set(splitKeys.map((k) => k.jiraKey));
  const validatingCommits: ValidatingCommit[] = [];
  const explainedKeys = new Set<string>();

  for (const commit of commits) {
    for (const match of commit.message.matchAll(SPLIT_TRAILER_RE)) {
      const jiraKey = match[1];
      const reason = match[2].trim();
      if (!reason) continue;
      // A marker naming a jiraKey that isn't actually split in this PR doesn't validate anything -
      // no fuzzy/nearest-match crediting, same "state precisely which one" contract the rest of the
      // traceability tooling (findEntry/removeEntry) already holds itself to.
      if (!splitKeySet.has(jiraKey)) continue;
      validatingCommits.push({ hash: commit.hash, subject: firstLine(commit.message), jiraKey, reason });
      explainedKeys.add(jiraKey);
    }
  }

  const unexplainedKeys = splitKeys.filter((k) => !explainedKeys.has(k.jiraKey));
  return { splitKeys, validatingCommits, unexplainedKeys, ok: unexplainedKeys.length === 0 };
}

export function buildReport(result: ConsolidationCheckResult): string {
  const lines: string[] = ['# Spec File Consolidation Check', ''];

  if (result.splitKeys.length === 0) {
    lines.push('No Jira ticket in this PR ended up linked to more than one spec file - nothing to check.');
    return lines.join('\n');
  }

  if (result.ok) {
    lines.push(
      "This PR grows at least one ticket's scenarios past a single shared spec file, and a commit " +
        'explains why for each:',
      '',
    );
    for (const key of result.splitKeys) {
      lines.push(`- **${key.jiraKey}** → ${key.files.join(', ')}`);
      const explaining = result.validatingCommits.find((c) => c.jiraKey === key.jiraKey);
      if (explaining) {
        lines.push(`  explained by \`${explaining.hash.slice(0, 7)}\`: ${explaining.reason}`);
      }
    }
    return lines.join('\n');
  }

  lines.push(
    'One or more Jira tickets in this PR are now linked to more than one spec file, and nothing ' +
      "explains why. A ticket's scenarios default to one shared spec file " +
      '(test-generation.md Section 1.4) regardless of which tool generated them - this project\'s ' +
      'own Generator Agent, a teammate\'s Antigravity/Gemini session, or a hand-written test all ' +
      'produce a manifest entry the same way, and all are judged by this same rule. Ending up split ' +
      'across more than one file is the exception, not the default shape, so it needs a deliberate, ' +
      'reviewed reason on record - not a silent side effect of whichever tool happened to generate it.',
    '',
  );
  for (const key of result.unexplainedKeys) {
    lines.push(`- **${key.jiraKey}** → ${key.files.join(', ')}`);
  }
  lines.push(
    '',
    'Fix by amending the commit that introduced the extra file to add:',
    '',
    '`Spec-File-Split: <KEY>: <reason>` - e.g. `Spec-File-Split: KAN-4: admin flow needed a separate ' +
      'fixture from the student flow`',
    '',
    'Example: `git commit --amend -m "$(git log -1 --pretty=%B)" -m "Spec-File-Split: KAN-4: <reason>"`',
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
 * Reads traceability/manifest.json's entries as they existed at a given git ref, tolerant of the
 * file not existing at that ref (brand-new manifest) and of the older flat-array shape
 * loadManifest() already knows how to upgrade - this deliberately does NOT run the entries through
 * TraceabilityEntrySchema, since a historical ref may predate a field this check doesn't need
 * anyway; it only reads jiraKey/testFilePath off whatever's there, ignoring the rest.
 */
function readManifestEntriesAtRef(ref: string): { jiraKey: string; testFilePath: string }[] {
  let raw: string;
  try {
    raw = execFileSync('git', ['show', `${ref}:${MANIFEST_PATH()}`], { encoding: 'utf-8' });
  } catch {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  const rawEntries = Array.isArray(parsed) ? parsed : (parsed as { entries?: unknown })?.entries;
  if (!Array.isArray(rawEntries)) return [];

  return rawEntries
    .filter(
      (e): e is { jiraKey: string; testFilePath: string } =>
        typeof (e as Record<string, unknown>)?.jiraKey === 'string' &&
        typeof (e as Record<string, unknown>)?.testFilePath === 'string',
    )
    .map((e) => ({ jiraKey: e.jiraKey, testFilePath: e.testFilePath }));
}

function buildJiraFileSnapshots(baseSha: string): JiraFileSnapshot[] {
  const before = readManifestEntriesAtRef(baseSha);
  const after = readManifestEntriesAtRef('HEAD');

  const jiraKeys = new Set(after.map((e) => e.jiraKey));
  return [...jiraKeys].map((jiraKey) => ({
    jiraKey,
    filesBefore: before.filter((e) => e.jiraKey === jiraKey).map((e) => e.testFilePath),
    filesAfter: after.filter((e) => e.jiraKey === jiraKey).map((e) => e.testFilePath),
  }));
}

// Same RECORD_SEP/FIELD_SEP-plus-custom-format convention checkManifestProvenance.ts and
// promptVersions/gitLog.ts already use to parse commit messages unambiguously.
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
 * CLI entry point: resolves the PR base SHA, snapshots every jiraKey's distinct test file set
 * before and after this PR, and - only if that snapshot shows a ticket growing past one file -
 * reads every commit in the PR's range for a recognized marker.
 */
export function checkSpecFileConsolidation(baseShaArg?: string): { exitCode: number; report: string } {
  const baseSha = resolveBaseSha(baseShaArg);
  const snapshots = buildJiraFileSnapshots(baseSha);
  const splitKeys = computeSplitKeys(snapshots);
  const commits = splitKeys.length > 0 ? getPrCommits(baseSha) : [];
  const result = runSpecFileConsolidationCheck(snapshots, commits);
  return { exitCode: result.ok ? 0 : 1, report: buildReport(result) };
}
