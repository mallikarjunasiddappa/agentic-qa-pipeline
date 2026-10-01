import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveSuite } from './suite';

test('deriveSuite reads the first directory under tests/', () => {
  assert.equal(deriveSuite('tests/auth/should-log-in-successfully.spec.ts'), 'auth');
  assert.equal(
    deriveSuite('tests/student/should-display-profile-menu-options.spec.ts'),
    'student',
  );
});

test('deriveSuite handles Windows-style backslashes', () => {
  assert.equal(deriveSuite('tests\\auth\\should-log-in-successfully.spec.ts'), 'auth');
});

test('deriveSuite throws for a path with no tests/ segment', () => {
  assert.throws(() => deriveSuite('src/foo.ts'), /Cannot derive a suite/);
});

test('deriveSuite throws when tests/ is the last segment', () => {
  assert.throws(() => deriveSuite('some/path/tests'), /Cannot derive a suite/);
});
