import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGitLogOutput } from './gitLog';

const RS = '\x01';
const FS = '\x1f';

function record(fields: { sha: string; shortSha: string; author: string; date: string; message: string }, numstat?: string): string {
  const header = [fields.sha, fields.shortSha, fields.author, fields.date, fields.message].join(FS);
  return numstat ? `${RS}${header}\n\n${numstat}\n` : `${RS}${header}\n`;
}

test('parseGitLogOutput parses a single plain commit', () => {
  const raw = record(
    { sha: 'abc123', shortSha: 'abc123', author: 'Jane Doe', date: '2026-08-05T10:00:00+00:00', message: 'Tweak wording' },
    '5\t2\t.claude/agents/healer-agent.md',
  );
  const commits = parseGitLogOutput(raw, '.claude/agents/healer-agent.md');
  assert.equal(commits.length, 1);
  assert.deepEqual(commits[0], {
    sha: 'abc123',
    shortSha: 'abc123',
    author: 'Jane Doe',
    date: '2026-08-05T10:00:00+00:00',
    message: 'Tweak wording',
    path: '.claude/agents/healer-agent.md',
    insertions: 5,
    deletions: 2,
  });
});

test('parseGitLogOutput resolves the brace rename shorthand to the new path', () => {
  const raw = record(
    { sha: 'rename1', shortSha: 'rename1', author: 'Jane Doe', date: '2026-08-06T09:45:53+02:00', message: 'Generalize TMS provider' },
    '29\t21\t.claude/agents/{qase-agent.md => tms-agent.md}',
  );
  const commits = parseGitLogOutput(raw, '.claude/agents/tms-agent.md');
  assert.equal(commits[0].path, '.claude/agents/tms-agent.md');
  assert.equal(commits[0].insertions, 29);
  assert.equal(commits[0].deletions, 21);
});

test('parseGitLogOutput resolves a full-path rename with no common prefix', () => {
  const raw = record(
    { sha: 'rename2', shortSha: 'rename2', author: 'Jane Doe', date: '2026-08-06T09:45:53+02:00', message: 'Move agent file' },
    '10\t3\told-dir/qase-agent.md => new-dir/tms-agent.md',
  );
  const commits = parseGitLogOutput(raw, 'new-dir/tms-agent.md');
  assert.equal(commits[0].path, 'new-dir/tms-agent.md');
});

test('parseGitLogOutput preserves the pre-rename path for older commits', () => {
  const raw = record(
    { sha: 'orig1', shortSha: 'orig1', author: 'Jane Doe', date: '2026-08-05T08:31:24+02:00', message: 'first commit' },
    '39\t0\t.claude/agents/qase-agent.md',
  );
  const commits = parseGitLogOutput(raw, '.claude/agents/tms-agent.md');
  assert.equal(commits[0].path, '.claude/agents/qase-agent.md');
});

test('parseGitLogOutput handles multiple records in append order (newest first, as git log emits)', () => {
  const raw =
    record(
      { sha: 'newer', shortSha: 'newer', author: 'A', date: '2026-08-06T09:45:53+02:00', message: 'newer commit' },
      '29\t21\t.claude/agents/{qase-agent.md => tms-agent.md}',
    ) +
    record(
      { sha: 'older', shortSha: 'older', author: 'A', date: '2026-08-05T08:31:24+02:00', message: 'older commit' },
      '39\t0\t.claude/agents/qase-agent.md',
    );
  const commits = parseGitLogOutput(raw, '.claude/agents/tms-agent.md');
  assert.equal(commits.length, 2);
  assert.equal(commits[0].sha, 'newer');
  assert.equal(commits[1].sha, 'older');
});

test('parseGitLogOutput treats "-" insertions/deletions (binary files) as 0', () => {
  const raw = record(
    { sha: 'bin1', shortSha: 'bin1', author: 'A', date: '2026-08-05T10:00:00+00:00', message: 'add binary' },
    '-\t-\t.claude/agents/healer-agent.md',
  );
  const commits = parseGitLogOutput(raw, '.claude/agents/healer-agent.md');
  assert.equal(commits[0].insertions, 0);
  assert.equal(commits[0].deletions, 0);
});

test('parseGitLogOutput returns an empty array for empty output', () => {
  assert.deepEqual(parseGitLogOutput('', '.claude/agents/healer-agent.md'), []);
});

test('parseGitLogOutput falls back to the queried path when a commit has no numstat line', () => {
  const raw = record(
    { sha: 'nostat', shortSha: 'nostat', author: 'A', date: '2026-08-05T10:00:00+00:00', message: 'merge commit' },
  );
  const commits = parseGitLogOutput(raw, '.claude/agents/healer-agent.md');
  assert.equal(commits.length, 1);
  assert.equal(commits[0].path, '.claude/agents/healer-agent.md');
  assert.equal(commits[0].insertions, 0);
});
