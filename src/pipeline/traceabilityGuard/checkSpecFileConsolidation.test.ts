import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReport,
  computeSplitKeys,
  runSpecFileConsolidationCheck,
  JiraFileSnapshot,
  PrCommit,
} from './checkSpecFileConsolidation';

function commit(hash: string, message: string): PrCommit {
  return { hash, message };
}

function snapshot(jiraKey: string, filesBefore: string[], filesAfter: string[]): JiraFileSnapshot {
  return { jiraKey, filesBefore, filesAfter };
}

test('computeSplitKeys: not flagged when a jiraKey has only one file after the PR', () => {
  const result = computeSplitKeys([snapshot('KAN-1', [], ['tests/ui/a.spec.ts'])]);
  assert.deepEqual(result, []);
});

test('computeSplitKeys: not flagged when a jiraKey already had two files before this PR and gained no new one', () => {
  const files = ['tests/ui/a.spec.ts', 'tests/ui/b.spec.ts'];
  const result = computeSplitKeys([snapshot('KAN-1', files, files)]);
  assert.deepEqual(result, [], 'already-explained split from an earlier PR should not be re-flagged');
});

test('computeSplitKeys: flagged when this PR grows a jiraKey from one file to two', () => {
  const result = computeSplitKeys([
    snapshot('KAN-1', ['tests/ui/a.spec.ts'], ['tests/ui/a.spec.ts', 'tests/ui/b.spec.ts']),
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].jiraKey, 'KAN-1');
  assert.deepEqual(result[0].files, ['tests/ui/a.spec.ts', 'tests/ui/b.spec.ts']);
});

test('computeSplitKeys: flagged when a brand-new jiraKey lands directly with two files in one PR', () => {
  const result = computeSplitKeys([
    snapshot('KAN-9', [], ['tests/ui/a.spec.ts', 'tests/ui/b.spec.ts']),
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].jiraKey, 'KAN-9');
});

test('computeSplitKeys: flagged again when an already-split jiraKey gains yet another new file', () => {
  const result = computeSplitKeys([
    snapshot(
      'KAN-1',
      ['tests/ui/a.spec.ts', 'tests/ui/b.spec.ts'],
      ['tests/ui/a.spec.ts', 'tests/ui/b.spec.ts', 'tests/ui/c.spec.ts'],
    ),
  ]);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].files, ['tests/ui/a.spec.ts', 'tests/ui/b.spec.ts', 'tests/ui/c.spec.ts']);
});

test('runSpecFileConsolidationCheck: passes trivially when nothing is split', () => {
  const result = runSpecFileConsolidationCheck(
    [snapshot('KAN-1', [], ['tests/ui/a.spec.ts'])],
    [commit('aaa1111', 'test: automate KAN-1')],
  );
  assert.equal(result.ok, true);
  assert.equal(result.splitKeys.length, 0);
});

test('runSpecFileConsolidationCheck: fails when a jiraKey splits and no commit explains why', () => {
  const result = runSpecFileConsolidationCheck(
    [snapshot('KAN-4', ['tests/ui/a.spec.ts'], ['tests/ui/a.spec.ts', 'tests/ui/b.spec.ts'])],
    [commit('aaa1111', 'test: automate KAN-4')],
  );
  assert.equal(result.ok, false);
  assert.equal(result.unexplainedKeys.length, 1);
  assert.equal(result.unexplainedKeys[0].jiraKey, 'KAN-4');
});

test('runSpecFileConsolidationCheck: passes when a commit carries a Spec-File-Split marker with a real reason', () => {
  const result = runSpecFileConsolidationCheck(
    [snapshot('KAN-4', ['tests/ui/a.spec.ts'], ['tests/ui/a.spec.ts', 'tests/ui/b.spec.ts'])],
    [commit('aaa1111', 'test: automate KAN-4\n\nSpec-File-Split: KAN-4: admin flow needed its own fixture')],
  );
  assert.equal(result.ok, true);
  assert.equal(result.validatingCommits.length, 1);
  assert.equal(result.validatingCommits[0].jiraKey, 'KAN-4');
  assert.equal(result.validatingCommits[0].reason, 'admin flow needed its own fixture');
});

test('runSpecFileConsolidationCheck: rejects a Spec-File-Split marker with an empty reason', () => {
  const result = runSpecFileConsolidationCheck(
    [snapshot('KAN-4', ['tests/ui/a.spec.ts'], ['tests/ui/a.spec.ts', 'tests/ui/b.spec.ts'])],
    [commit('aaa1111', 'test: automate KAN-4\n\nSpec-File-Split: KAN-4:   ')],
  );
  assert.equal(result.ok, false);
});

test('runSpecFileConsolidationCheck: a marker naming a different jiraKey does not explain this one', () => {
  const result = runSpecFileConsolidationCheck(
    [snapshot('KAN-4', ['tests/ui/a.spec.ts'], ['tests/ui/a.spec.ts', 'tests/ui/b.spec.ts'])],
    [commit('aaa1111', 'test: automate KAN-4\n\nSpec-File-Split: KAN-9: unrelated ticket')],
  );
  assert.equal(result.ok, false);
  assert.equal(result.unexplainedKeys[0].jiraKey, 'KAN-4');
});

test('runSpecFileConsolidationCheck: only one commit in the PR needs to carry the marker, not every commit', () => {
  const result = runSpecFileConsolidationCheck(
    [snapshot('KAN-4', ['tests/ui/a.spec.ts'], ['tests/ui/a.spec.ts', 'tests/ui/b.spec.ts'])],
    [
      commit('aaa1111', 'wip'),
      commit('bbb2222', 'test: automate KAN-4\n\nSpec-File-Split: KAN-4: needed a separate fixture'),
      commit('ccc3333', 'fix typo'),
    ],
  );
  assert.equal(result.ok, true);
  assert.equal(result.validatingCommits[0].hash, 'bbb2222');
});

test('runSpecFileConsolidationCheck: a PR with two split tickets needs a marker for each independently', () => {
  const result = runSpecFileConsolidationCheck(
    [
      snapshot('KAN-4', ['tests/ui/a.spec.ts'], ['tests/ui/a.spec.ts', 'tests/ui/b.spec.ts']),
      snapshot('KAN-5', ['tests/ui/c.spec.ts'], ['tests/ui/c.spec.ts', 'tests/ui/d.spec.ts']),
    ],
    [commit('aaa1111', 'test: automate KAN-4 and KAN-5\n\nSpec-File-Split: KAN-4: needed a separate fixture')],
  );
  assert.equal(result.ok, false);
  assert.equal(result.unexplainedKeys.length, 1);
  assert.equal(result.unexplainedKeys[0].jiraKey, 'KAN-5');
});

test('buildReport: reports nothing-to-check when no jiraKey split', () => {
  const report = buildReport({ splitKeys: [], validatingCommits: [], unexplainedKeys: [], ok: true });
  assert.match(report, /nothing to check/);
});

test('buildReport: lists each split jiraKey and its explaining commit when passing', () => {
  const report = buildReport({
    splitKeys: [{ jiraKey: 'KAN-4', files: ['tests/ui/a.spec.ts', 'tests/ui/b.spec.ts'] }],
    validatingCommits: [
      { hash: 'aaa1111bbb', subject: 'test: automate KAN-4', jiraKey: 'KAN-4', reason: 'needed a separate fixture' },
    ],
    unexplainedKeys: [],
    ok: true,
  });
  assert.match(report, /KAN-4/);
  assert.match(report, /needed a separate fixture/);
});

test('buildReport: explains the marker format and gives an amend example when failing', () => {
  const report = buildReport({
    splitKeys: [{ jiraKey: 'KAN-4', files: ['tests/ui/a.spec.ts', 'tests/ui/b.spec.ts'] }],
    validatingCommits: [],
    unexplainedKeys: [{ jiraKey: 'KAN-4', files: ['tests/ui/a.spec.ts', 'tests/ui/b.spec.ts'] }],
    ok: false,
  });
  assert.match(report, /Spec-File-Split: <KEY>: <reason>/);
  assert.match(report, /git commit --amend/);
  assert.match(report, /Antigravity\/Gemini/);
});
