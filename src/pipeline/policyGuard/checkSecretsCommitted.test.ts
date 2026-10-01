import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, runSecretsCommittedCheck } from './checkSecretsCommitted';

test('runSecretsCommittedCheck: passes when nothing added matches a forbidden filename', () => {
  const result = runSecretsCommittedCheck(['src/ui/pages/LoginPage.ts', '.env.example'], ['.env']);
  assert.equal(result.ok, true);
  assert.equal(result.matchedFiles.length, 0);
});

test('runSecretsCommittedCheck: flags an exact forbidden basename anywhere in the tree', () => {
  const result = runSecretsCommittedCheck(['scripts/.env', 'src/foo.ts'], ['.env']);
  assert.equal(result.ok, false);
  assert.deepEqual(result.matchedFiles, ['scripts/.env']);
});

test('runSecretsCommittedCheck: .env.example never collides with .env (exact basename match, not prefix)', () => {
  const result = runSecretsCommittedCheck(['.env.example'], ['.env']);
  assert.equal(result.ok, true);
});

test('runSecretsCommittedCheck: flags storage-state.json and credentials.json independently', () => {
  const result = runSecretsCommittedCheck(
    ['tests/storage-state.json', 'src/credentials.json', 'src/ok.ts'],
    ['storage-state.json', 'credentials.json'],
  );
  assert.equal(result.ok, false);
  assert.equal(result.matchedFiles.length, 2);
});

test('buildReport: passing case has no remediation text', () => {
  const report = buildReport({ matchedFiles: [], ok: true });
  assert.match(report, /No forbidden filenames/);
});

test('buildReport: failing case explains there is no override and gives the fix command', () => {
  const report = buildReport({ matchedFiles: ['.env'], ok: false });
  assert.match(report, /no exception, no.*override|no override/i);
  assert.match(report, /git rm --cached/);
  assert.match(report, /rotate it/);
});
