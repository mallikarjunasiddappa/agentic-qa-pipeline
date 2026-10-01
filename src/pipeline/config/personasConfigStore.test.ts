import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTenantId, resetTenantIdForTests } from './tenantContext';
import { loadPersonasConfig, getPersona } from './personasConfigStore';

let tmpDir: string;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'personas-config-store-test-'));
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  setTenantId('acme');
});

afterEach(() => {
  resetTenantIdForTests();
});

test('loadPersonasConfig returns an empty persona list stamped with the tenant when the file does not exist', () => {
  const cfg = loadPersonasConfig(path.join(tmpDir, 'nope.json'));
  assert.equal(cfg.tenantId, 'acme');
  assert.equal(cfg.configVersion, 1);
  assert.deepEqual(cfg.personas, []);
});

test('loadPersonasConfig parses a real personas.json and applies per-persona defaults', () => {
  const p = path.join(tmpDir, 'acme-personas.json');
  fs.writeFileSync(
    p,
    JSON.stringify({
      tenantId: 'acme',
      personas: [
        { id: 'browsing-student', displayName: 'Browsing student', goals: ['look around'], context: 'desktop, no goal' },
      ],
    }),
    'utf-8',
  );
  const cfg = loadPersonasConfig(p);
  assert.equal(cfg.personas.length, 1);
  const persona = cfg.personas[0];
  assert.equal(persona.id, 'browsing-student');
  assert.deepEqual(persona.habits, []);
  assert.deepEqual(persona.blindSpots, []);
  assert.deepEqual(persona.outOfBounds, []);
  assert.equal(persona.stepBudget, 40);
  assert.equal(persona.timeBoxMinutes, 10);
  assert.equal(persona.startUrl, undefined);
});

test('loadPersonasConfig throws when the declared tenantId does not match the tenant it was loaded for', () => {
  const p = path.join(tmpDir, 'mismatched.json');
  fs.writeFileSync(p, JSON.stringify({ tenantId: 'someone-else', personas: [] }), 'utf-8');
  assert.throws(() => loadPersonasConfig(p), /declares tenantId "someone-else".*loaded for tenant "acme"/s);
});

test('loadPersonasConfig rejects duplicate persona ids within a tenant', () => {
  const p = path.join(tmpDir, 'dupe.json');
  fs.writeFileSync(
    p,
    JSON.stringify({
      tenantId: 'acme',
      personas: [
        { id: 'x', displayName: 'X', goals: ['g'], context: 'c' },
        { id: 'x', displayName: 'X2', goals: ['g'], context: 'c' },
      ],
    }),
    'utf-8',
  );
  assert.throws(() => loadPersonasConfig(p), /duplicate persona id/);
});

test('loadPersonasConfig rejects a persona with no goals', () => {
  const p = path.join(tmpDir, 'nogoals.json');
  fs.writeFileSync(
    p,
    JSON.stringify({ tenantId: 'acme', personas: [{ id: 'x', displayName: 'X', goals: [], context: 'c' }] }),
    'utf-8',
  );
  assert.throws(() => loadPersonasConfig(p));
});

test('getPersona returns the matching persona and throws an actionable error for an unknown id', () => {
  const cfg = loadPersonasConfig(path.join(tmpDir, 'nope.json'));
  assert.throws(() => getPersona(cfg, 'missing'), /No persona "missing".*\(none provisioned\)/s);
});
