import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPolicy } from './policyStore';

let tmpDir: string;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-store-test-'));
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('loadPolicy throws when the file does not exist, rather than silently returning an empty policy', () => {
  assert.throws(() => loadPolicy(path.join(tmpDir, 'nope.json')), /not found/);
});

test('loadPolicy parses a fully-populated policy.json', () => {
  const p = path.join(tmpDir, 'full.json');
  fs.writeFileSync(
    p,
    JSON.stringify({
      policyVersion: 1,
      forbiddenPlaywrightPatterns: ['page.pause()'],
      requiredTestTags: ['smoke'],
      forbiddenCommittedFilenames: ['.env'],
    }),
    'utf-8',
  );
  const policy = loadPolicy(p);
  assert.equal(policy.policyVersion, 1);
  assert.deepEqual(policy.forbiddenPlaywrightPatterns, ['page.pause()']);
  assert.deepEqual(policy.requiredTestTags, ['smoke']);
  assert.deepEqual(policy.forbiddenCommittedFilenames, ['.env']);
});

test('loadPolicy defaults every rule list to empty when only policyVersion is given', () => {
  const p = path.join(tmpDir, 'minimal.json');
  fs.writeFileSync(p, JSON.stringify({ policyVersion: 1 }), 'utf-8');
  const policy = loadPolicy(p);
  assert.deepEqual(policy.forbiddenPlaywrightPatterns, []);
  assert.deepEqual(policy.requiredTestTags, []);
  assert.deepEqual(policy.forbiddenCommittedFilenames, []);
});

test('loadPolicy rejects a file missing policyVersion', () => {
  const p = path.join(tmpDir, 'invalid.json');
  fs.writeFileSync(p, JSON.stringify({ requiredTestTags: ['smoke'] }), 'utf-8');
  assert.throws(() => loadPolicy(p));
});

test('loadPolicy parses the repo\'s actual policy.json without error', () => {
  const policy = loadPolicy();
  assert.ok(policy.policyVersion >= 1);
  assert.ok(Array.isArray(policy.forbiddenPlaywrightPatterns));
  assert.ok(Array.isArray(policy.requiredTestTags));
  assert.ok(Array.isArray(policy.forbiddenCommittedFilenames));
});
