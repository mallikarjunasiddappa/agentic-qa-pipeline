import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTenantId, resetTenantIdForTests } from './tenantContext';
import { loadScrumConfig, saveScrumConfig, applyScrumSettingUpdate } from './scrumConfigStore';

let tmpDir: string;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrum-config-store-test-'));
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

test('loadScrumConfig returns schema defaults stamped with the current tenant when the file does not exist', () => {
  const cfg = loadScrumConfig(path.join(tmpDir, 'nope.json'));
  assert.equal(cfg.tenantId, 'acme');
  assert.equal(cfg.configVersion, 1);
  assert.deepEqual(cfg.boardIds, []);
  assert.equal(cfg.storyPointsField, undefined);
  assert.equal(cfg.standupDigest.dm, false);
  assert.deepEqual(cfg.blockerEscalation.relatedRecipients, []);
  assert.equal(cfg.blockerEscalation.idleDaysThreshold, 3);
});

test('loadScrumConfig parses a real config/tenants/<id>/scrum.json with populated real values', () => {
  const p = path.join(tmpDir, 'acme-scrum.json');
  fs.writeFileSync(
    p,
    JSON.stringify({
      tenantId: 'acme',
      boardIds: ['35'],
      storyPointsField: 'customfield_10016',
      standupDigest: { dm: true },
      vcs: { provider: 'github', branchKeyConvention: 'lowercase ticket key anywhere in branch name' },
      blockerEscalation: { relatedRecipients: [] },
    }),
    'utf-8',
  );
  const cfg = loadScrumConfig(p);
  assert.deepEqual(cfg.boardIds, ['35']);
  assert.equal(cfg.storyPointsField, 'customfield_10016');
  assert.equal(cfg.standupDigest.dm, true);
  assert.equal(cfg.vcs.provider, 'github');
  assert.equal(cfg.vcs.branchKeyConvention, 'lowercase ticket key anywhere in branch name');
  assert.deepEqual(cfg.blockerEscalation.relatedRecipients, []);
  // Untouched fields still default - a populated file only sets what it explicitly configures.
  assert.equal(cfg.blockerEscalation.idleDaysThreshold, 3);
});

test('loadScrumConfig throws when the file\'s declared tenantId does not match the tenant it was loaded for', () => {
  const p = path.join(tmpDir, 'mismatched.json');
  fs.writeFileSync(p, JSON.stringify({ tenantId: 'someone-else' }), 'utf-8');
  assert.throws(() => loadScrumConfig(p), /declares tenantId "someone-else".*loaded for tenant "acme"/s);
});

test('loadScrumConfig parses the repo\'s actual config/tenants/default/scrum.json without error', () => {
  resetTenantIdForTests();
  setTenantId('default');
  const cfg = loadScrumConfig();
  assert.equal(cfg.tenantId, 'default');
  assert.deepEqual(cfg.boardIds, ['1']);
  assert.equal(cfg.storyPointsField, 'customfield_10016');
  assert.equal(cfg.standupDigest.dm, true);
  assert.equal(cfg.vcs.provider, 'github');
});

test('applyScrumSettingUpdate updates storyPointsField and revalidates against ScrumConfigSchema', () => {
  const base = loadScrumConfig(path.join(tmpDir, 'nope2.json'));
  const updated = applyScrumSettingUpdate(base, 'storyPointsField', 'customfield_99999');
  assert.equal(updated.storyPointsField, 'customfield_99999');
  // Every other field is untouched.
  assert.equal(updated.tenantId, 'acme');
  assert.deepEqual(updated.boardIds, []);
  assert.equal(updated.blockerEscalation.idleDaysThreshold, 3);
});

test('applyScrumSettingUpdate trims whitespace around a storyPointsField value', () => {
  const base = loadScrumConfig(path.join(tmpDir, 'nope3.json'));
  const updated = applyScrumSettingUpdate(base, 'storyPointsField', '  customfield_10016  ');
  assert.equal(updated.storyPointsField, 'customfield_10016');
});

test('applyScrumSettingUpdate rejects an empty storyPointsField value', () => {
  const base = loadScrumConfig(path.join(tmpDir, 'nope4.json'));
  assert.throws(() => applyScrumSettingUpdate(base, 'storyPointsField', '   '), /storyPointsField cannot be set to an empty value/);
});

test('applyScrumSettingUpdate updates blockerEscalation.idleDaysThreshold and revalidates against ScrumConfigSchema', () => {
  const base = loadScrumConfig(path.join(tmpDir, 'nope5.json'));
  const updated = applyScrumSettingUpdate(base, 'blockerEscalation.idleDaysThreshold', '5');
  assert.equal(updated.blockerEscalation.idleDaysThreshold, 5);
  // relatedRecipients (the sibling field) is untouched.
  assert.deepEqual(updated.blockerEscalation.relatedRecipients, []);
  assert.equal(updated.storyPointsField, undefined);
});

test('applyScrumSettingUpdate rejects a non-numeric idleDaysThreshold value', () => {
  const base = loadScrumConfig(path.join(tmpDir, 'nope6.json'));
  assert.throws(
    () => applyScrumSettingUpdate(base, 'blockerEscalation.idleDaysThreshold', 'abc'),
    /must be a whole number >= 1, got "abc"/,
  );
});

test('applyScrumSettingUpdate rejects a non-integer idleDaysThreshold value', () => {
  const base = loadScrumConfig(path.join(tmpDir, 'nope7.json'));
  assert.throws(
    () => applyScrumSettingUpdate(base, 'blockerEscalation.idleDaysThreshold', '2.5'),
    /must be a whole number >= 1, got "2\.5"/,
  );
});

test('applyScrumSettingUpdate rejects an idleDaysThreshold value below the schema minimum', () => {
  const base = loadScrumConfig(path.join(tmpDir, 'nope8.json'));
  assert.throws(
    () => applyScrumSettingUpdate(base, 'blockerEscalation.idleDaysThreshold', '0'),
    /must be a whole number >= 1, got "0"/,
  );
  assert.throws(
    () => applyScrumSettingUpdate(base, 'blockerEscalation.idleDaysThreshold', '-1'),
    /must be a whole number >= 1, got "-1"/,
  );
});

test('applyScrumSettingUpdate rejects a setting name outside SCRUM_SETTING_KEYS', () => {
  const base = loadScrumConfig(path.join(tmpDir, 'nope9.json'));
  assert.throws(
    () => applyScrumSettingUpdate(base, 'boardIds', '["35"]'),
    /Unknown setting "boardIds" - the Settings panel only supports: storyPointsField, blockerEscalation\.idleDaysThreshold/,
  );
});

test('applyScrumSettingUpdate does not mutate the config object it was given', () => {
  const base = loadScrumConfig(path.join(tmpDir, 'nope10.json'));
  const snapshot = JSON.parse(JSON.stringify(base));
  applyScrumSettingUpdate(base, 'storyPointsField', 'customfield_1');
  applyScrumSettingUpdate(base, 'blockerEscalation.idleDaysThreshold', '9');
  assert.deepEqual(base, snapshot);
});

test('saveScrumConfig writes JSON that loadScrumConfig reads back identically', () => {
  const p = path.join(tmpDir, 'roundtrip-scrum.json');
  const base = loadScrumConfig(path.join(tmpDir, 'nope11.json'));
  const updated = applyScrumSettingUpdate(base, 'blockerEscalation.idleDaysThreshold', '7');
  saveScrumConfig(updated, p);
  const reloaded = loadScrumConfig(p);
  assert.deepEqual(reloaded, updated);
});

test('saveScrumConfig creates the parent directory when it does not exist yet', () => {
  const p = path.join(tmpDir, 'nested', 'deeper', 'scrum.json');
  const base = loadScrumConfig(path.join(tmpDir, 'nope12.json'));
  saveScrumConfig(base, p);
  assert.equal(fs.existsSync(p), true);
});

test('a load -> apply -> save -> load round trip persists the one changed field and leaves the rest at schema defaults', () => {
  const p = path.join(tmpDir, 'full-roundtrip-scrum.json');
  const first = loadScrumConfig(p); // file doesn't exist yet -> schema defaults
  const updated = applyScrumSettingUpdate(first, 'storyPointsField', 'customfield_42');
  saveScrumConfig(updated, p);

  const second = loadScrumConfig(p);
  assert.equal(second.storyPointsField, 'customfield_42');
  assert.equal(second.tenantId, 'acme');
  assert.equal(second.configVersion, 1);
  assert.deepEqual(second.boardIds, []);
  assert.equal(second.blockerEscalation.idleDaysThreshold, 3);
});
