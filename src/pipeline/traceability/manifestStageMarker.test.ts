import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordManifestStageMarker, MANIFEST_STAGE_MARKER_FILE } from './manifestStageMarker';

test('recordManifestStageMarker: writes a recognized stage to the marker file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'manifest-stage-'));
  recordManifestStageMarker('traceability-record', dir);
  assert.equal(readFileSync(join(dir, MANIFEST_STAGE_MARKER_FILE), 'utf8').trim(), 'traceability-record');
});

test('recordManifestStageMarker: writes traceability-link', () => {
  const dir = mkdtempSync(join(tmpdir(), 'manifest-stage-'));
  recordManifestStageMarker('traceability-link', dir);
  assert.equal(readFileSync(join(dir, MANIFEST_STAGE_MARKER_FILE), 'utf8').trim(), 'traceability-link');
});

test('recordManifestStageMarker: ignores a stage that does not touch the manifest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'manifest-stage-'));
  recordManifestStageMarker('jira', dir);
  assert.equal(existsSync(join(dir, MANIFEST_STAGE_MARKER_FILE)), false);
});
