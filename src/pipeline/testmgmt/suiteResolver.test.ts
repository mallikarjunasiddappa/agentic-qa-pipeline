import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findOrCreateSuiteId, resolveSuiteId, resolveSuiteTitle, parseSuitePath, QaseSuiteRef } from './suiteResolver';

/** Records every listSuites()/createSuite() call so tests can assert on call counts, not just results. */
function fakeBackend(initialSuites: QaseSuiteRef[] = []) {
  const suites = [...initialSuites];
  let nextId = Math.max(0, ...suites.map((s) => s.id)) + 1;
  const listCalls: number[] = [];
  const createCalls: { title: string; parentId: number | null }[] = [];

  return {
    suites,
    listCalls,
    createCalls,
    listSuites: async () => {
      listCalls.push(listCalls.length);
      return suites;
    },
    createSuite: async (title: string, parentId: number | null) => {
      const id = nextId;
      nextId += 1;
      suites.push({ id, title, parentId });
      createCalls.push({ title, parentId });
      return id;
    },
  };
}

test('findOrCreateSuiteId: creates a new top-level suite when none matches', async () => {
  const backend = fakeBackend();
  const cache = new Map<string, number>();
  const id = await findOrCreateSuiteId('Profile Subscriptions', null, cache, backend.listSuites, backend.createSuite);
  assert.equal(id, backend.suites[0].id);
  assert.deepEqual(backend.createCalls, [{ title: 'Profile Subscriptions', parentId: null }]);
});

test('findOrCreateSuiteId: finds an existing suite by exact title + parent match instead of creating a duplicate', async () => {
  const backend = fakeBackend([{ id: 99, title: 'Profile Subscriptions', parentId: null }]);
  const cache = new Map<string, number>();
  const id = await findOrCreateSuiteId('Profile Subscriptions', null, cache, backend.listSuites, backend.createSuite);
  assert.equal(id, 99);
  assert.equal(backend.createCalls.length, 0);
});

test('findOrCreateSuiteId: a suite with the same title but a different parent is not treated as a match', async () => {
  const backend = fakeBackend([{ id: 99, title: 'Student Login', parentId: 5 }]);
  const cache = new Map<string, number>();
  const id = await findOrCreateSuiteId('Student Login', 7, cache, backend.listSuites, backend.createSuite);
  assert.notEqual(id, 99);
  assert.deepEqual(backend.createCalls, [{ title: 'Student Login', parentId: 7 }]);
});

test('findOrCreateSuiteId: second call for the same (title, parent) hits the cache, not listSuites again', async () => {
  const backend = fakeBackend();
  const cache = new Map<string, number>();
  const first = await findOrCreateSuiteId('Profile Subscriptions', null, cache, backend.listSuites, backend.createSuite);
  const second = await findOrCreateSuiteId('Profile Subscriptions', null, cache, backend.listSuites, backend.createSuite);
  assert.equal(first, second);
  assert.equal(backend.listCalls.length, 1);
  assert.equal(backend.createCalls.length, 1);
});

test('resolveSuiteId: returns undefined when no top-level title is given at all', async () => {
  const backend = fakeBackend();
  const cache = new Map<string, number>();
  const id = await resolveSuiteId(undefined, 'Student Login', cache, backend.listSuites, backend.createSuite);
  assert.equal(id, undefined);
  assert.equal(backend.createCalls.length, 0);
});

test('resolveSuiteId: top-level title alone resolves/creates just the root suite', async () => {
  const backend = fakeBackend();
  const cache = new Map<string, number>();
  const id = await resolveSuiteId('Profile Subscriptions', undefined, cache, backend.listSuites, backend.createSuite);
  assert.equal(id, backend.suites[0].id);
  assert.deepEqual(backend.createCalls, [{ title: 'Profile Subscriptions', parentId: null }]);
});

test('resolveSuiteId: top-level + sub title nests the sub-suite under the resolved root', async () => {
  const backend = fakeBackend();
  const cache = new Map<string, number>();
  const id = await resolveSuiteId('Profile Subscriptions', 'Student Login', cache, backend.listSuites, backend.createSuite);

  assert.equal(backend.createCalls.length, 2);
  const [rootCall, subCall] = backend.createCalls;
  assert.deepEqual(rootCall, { title: 'Profile Subscriptions', parentId: null });
  assert.equal(subCall.title, 'Student Login');

  const rootId = backend.suites.find((s) => s.title === 'Profile Subscriptions')!.id;
  assert.equal(subCall.parentId, rootId);
  assert.equal(id, backend.suites.find((s) => s.title === 'Student Login')!.id);
});

test('resolveSuiteId: two scenarios in different sub-suites under the same ticket share one root suite, not two', async () => {
  const backend = fakeBackend();
  const cache = new Map<string, number>();
  await resolveSuiteId('Profile Subscriptions', 'Student Login', cache, backend.listSuites, backend.createSuite);
  await resolveSuiteId('Profile Subscriptions', 'My Subscriptions', cache, backend.listSuites, backend.createSuite);

  const rootSuites = backend.suites.filter((s) => s.title === 'Profile Subscriptions');
  assert.equal(rootSuites.length, 1);
  const subSuites = backend.suites.filter((s) => s.parentId === rootSuites[0].id);
  assert.equal(subSuites.length, 2);
});


test('resolveSuiteTitle: an explicit --suite wins over the spec marker and the Jira key', () => {
  assert.equal(resolveSuiteTitle('My Feature', 'Spec Suite', 'SCRUM-19'), 'My Feature');
});

test('resolveSuiteTitle: the spec Suite marker is used when no --suite is given', () => {
  assert.equal(resolveSuiteTitle(undefined, 'Spec Suite', 'SCRUM-19'), 'Spec Suite');
});

test('resolveSuiteTitle: falls back to the Jira key (never the summary, never undefined)', () => {
  assert.equal(resolveSuiteTitle(undefined, undefined, 'SCRUM-19'), 'SCRUM-19');
});

test('resolveSuiteTitle: treats blank/whitespace-only inputs as absent', () => {
  assert.equal(resolveSuiteTitle('   ', '  ', 'SCRUM-19'), 'SCRUM-19');
  assert.equal(resolveSuiteTitle('  ', 'Spec Suite', 'SCRUM-19'), 'Spec Suite');
});


test('parseSuitePath splits on "/", trims, and drops empty segments', () => {
  assert.deepEqual(parseSuitePath('IELTS Reading/Question'), ['IELTS Reading', 'Question']);
  assert.deepEqual(parseSuitePath('  IELTS Reading / Question '), ['IELTS Reading', 'Question']);
  assert.deepEqual(parseSuitePath('SCRUM-19'), ['SCRUM-19']);
  assert.deepEqual(parseSuitePath('a//b'), ['a', 'b']);
  assert.deepEqual(parseSuitePath(''), []);
  assert.deepEqual(parseSuitePath(undefined), []);
});

test('resolveSuiteId nests a "Parent/Child" suite title into real parent -> child suites', async () => {
  const backend = fakeBackend();
  const cache = new Map<string, number>();
  const id = await resolveSuiteId('IELTS Reading/Question', undefined, cache, backend.listSuites, backend.createSuite);
  const parent = backend.suites.find((s) => s.title === 'IELTS Reading');
  const child = backend.suites.find((s) => s.title === 'Question');
  assert.ok(parent && parent.parentId === null, 'IELTS Reading is a root suite');
  assert.ok(child && child.parentId === parent.id, 'Question nests under IELTS Reading');
  assert.equal(id, child.id);
});

test('resolveSuiteId appends the scenario group under a slash path (Parent/Child + group)', async () => {
  const backend = fakeBackend();
  const cache = new Map<string, number>();
  const id = await resolveSuiteId('IELTS Reading/Question', 'True-False-NotGiven', cache, backend.listSuites, backend.createSuite);
  const child = backend.suites.find((s) => s.title === 'Question');
  const leaf = backend.suites.find((s) => s.title === 'True-False-NotGiven');
  assert.ok(child && leaf && leaf.parentId === child.id, 'group nests under Question');
  assert.equal(id, leaf.id);
});
