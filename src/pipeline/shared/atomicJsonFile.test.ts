import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LOCK_STALE_MS, withFileLock, writeJsonFileAtomic } from './atomicJsonFile';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-json-'));
}

// --- writing ------------------------------------------------------------------------------------

test('writes JSON that reads back identically, creating the directory', () => {
  const target = path.join(tempDir(), 'nested', 'store.json');
  writeJsonFileAtomic(target, { entries: [{ id: 'A-1' }] });
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf-8')), { entries: [{ id: 'A-1' }] });
});

test('the file ends with a newline, as the stores have always written it', () => {
  const target = path.join(tempDir(), 'store.json');
  writeJsonFileAtomic(target, { a: 1 });
  assert.ok(fs.readFileSync(target, 'utf-8').endsWith('\n'));
});

test('overwriting leaves no temp files behind', () => {
  const dir = tempDir();
  const target = path.join(dir, 'store.json');
  writeJsonFileAtomic(target, { v: 1 });
  writeJsonFileAtomic(target, { v: 2 });
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf-8')), { v: 2 });
  assert.deepEqual(fs.readdirSync(dir), ['store.json']);
});

test('a failed write leaves the previous file intact and drops the temp file', () => {
  // The whole point of writing to a temp file first: the destination is never truncated, so a
  // reader sees the complete old file or the complete new one, never a half-written one.
  const dir = tempDir();
  const target = path.join(dir, 'store.json');
  writeJsonFileAtomic(target, { v: 'original' });

  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.throws(() => writeJsonFileAtomic(target, circular));

  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf-8')), { v: 'original' });
  assert.deepEqual(fs.readdirSync(dir), ['store.json']);
});

// --- locking ------------------------------------------------------------------------------------

test('the lock is released after the callback returns', () => {
  const target = path.join(tempDir(), 'store.json');
  assert.equal(withFileLock(target, () => 'result'), 'result');
  assert.equal(fs.existsSync(`${target}.lock`), false);
});

test('the lock is released even when the callback throws', () => {
  const target = path.join(tempDir(), 'store.json');
  assert.throws(() => withFileLock(target, () => { throw new Error('boom'); }), /boom/);
  assert.equal(
    fs.existsSync(`${target}.lock`),
    false,
    'a lock left behind by a thrown callback would block every later writer',
  );
});

test('a held lock is visible while the callback runs', () => {
  const target = path.join(tempDir(), 'store.json');
  withFileLock(target, () => {
    assert.equal(fs.existsSync(`${target}.lock`), true);
  });
});

test('a second lock attempt times out rather than proceeding concurrently', () => {
  // Proceeding would be the lost update this exists to prevent: both processes read the same
  // starting state, both write a valid file, and one of them silently loses every change.
  const target = path.join(tempDir(), 'store.json');
  withFileLock(target, () => {
    assert.throws(() => withFileLock(target, () => 'should not run'), /Timed out.*waiting for the lock/s);
  });
});

test('a stale lock left by a dead process is broken rather than blocking forever', () => {
  const target = path.join(tempDir(), 'store.json');
  const lockPath = `${target}.lock`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.mkdirSync(lockPath);

  const longAgo = new Date(Date.now() - LOCK_STALE_MS - 60_000);
  fs.utimesSync(lockPath, longAgo, longAgo);

  assert.equal(withFileLock(target, () => 'acquired'), 'acquired');
  assert.equal(fs.existsSync(lockPath), false);
});

test('a fresh lock is not treated as stale', () => {
  const target = path.join(tempDir(), 'store.json');
  const lockPath = `${target}.lock`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.mkdirSync(lockPath);
  assert.throws(() => withFileLock(target, () => 'should not run'), /Timed out/);
});

test('lock and write compose: the value written inside the lock is the one on disk', () => {
  const target = path.join(tempDir(), 'store.json');
  withFileLock(target, () => writeJsonFileAtomic(target, { entries: ['A-1'] }));
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf-8')), { entries: ['A-1'] });
  assert.equal(fs.existsSync(`${target}.lock`), false);
});
