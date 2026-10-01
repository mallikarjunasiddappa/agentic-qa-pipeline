import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, runManifestProvenanceCheck, PrCommit } from './checkManifestProvenance';

function commit(hash: string, message: string): PrCommit {
  return { hash, message };
}

test('runManifestProvenanceCheck: not flagged at all when the manifest did not change', () => {
  const result = runManifestProvenanceCheck(false, [commit('aaa1111', 'unrelated change')]);
  assert.equal(result.ok, true);
  assert.equal(result.validatingCommits.length, 0);
});

test('runManifestProvenanceCheck: fails when the manifest changed but no commit explains why', () => {
  const result = runManifestProvenanceCheck(true, [
    commit('aaa1111', 'chore: tidy up formatting'),
    commit('bbb2222', 'test: add a new scenario'),
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.validatingCommits.length, 0);
});

test('runManifestProvenanceCheck: passes when one commit carries a recognized Traceability-Stage marker', () => {
  const result = runManifestProvenanceCheck(true, [
    commit('aaa1111', 'test: automate KAN-9\n\nTraceability-Stage: traceability-link'),
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.validatingCommits.length, 1);
  assert.equal(result.validatingCommits[0].marker, 'Traceability-Stage: traceability-link');
  assert.equal(result.validatingCommits[0].subject, 'test: automate KAN-9');
});

test('runManifestProvenanceCheck: rejects a Traceability-Stage marker naming an unrecognized stage', () => {
  const result = runManifestProvenanceCheck(true, [
    commit('aaa1111', 'sneaky change\n\nTraceability-Stage: made-up-stage'),
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.validatingCommits.length, 0);
});

test('runManifestProvenanceCheck: passes with a Traceability-Manual marker that has a real reason', () => {
  const result = runManifestProvenanceCheck(true, [
    commit('aaa1111', 'chore: one-time manifest migration\n\nTraceability-Manual: retiring KAN-1 cases after TMS migration'),
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.validatingCommits[0].marker, 'Traceability-Manual: retiring KAN-1 cases after TMS migration');
});

test('runManifestProvenanceCheck: rejects a Traceability-Manual marker with an empty reason', () => {
  const result = runManifestProvenanceCheck(true, [commit('aaa1111', 'edit\n\nTraceability-Manual:   ')]);
  assert.equal(result.ok, false);
});

test('runManifestProvenanceCheck: recognizes a marker even when the commit message line is indented', () => {
  // Reproduces a real failure: `git commit -am "subject" -m "   Traceability-Manual: ..."` (or
  // PowerShell's handling of an embedded newline) can leave leading spaces before the marker on
  // its own line - the marker must still be recognized, not just when it's flush against column 0.
  const result = runManifestProvenanceCheck(true, [
    commit('aaa1111', 'test: checking if the guardrail passes this\n   Traceability-Manual: testing the manifest provenance guardrail'),
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.validatingCommits[0].marker, 'Traceability-Manual: testing the manifest provenance guardrail');
});

test('runManifestProvenanceCheck: recognizes an indented Traceability-Stage marker too', () => {
  const result = runManifestProvenanceCheck(true, [
    commit('aaa1111', 'subject line\n  Traceability-Stage: drift-check'),
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.validatingCommits[0].marker, 'Traceability-Stage: drift-check');
});

test('runManifestProvenanceCheck: only one commit in the PR needs to carry the marker, not every commit', () => {
  const result = runManifestProvenanceCheck(true, [
    commit('aaa1111', 'wip'),
    commit('bbb2222', 'test: automate KAN-9\n\nTraceability-Stage: traceability-record'),
    commit('ccc3333', 'fix typo'),
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.validatingCommits.length, 1);
  assert.equal(result.validatingCommits[0].hash, 'bbb2222');
});

test('buildReport: reports nothing-to-check when the manifest was not touched', () => {
  const report = buildReport({ manifestChanged: false, validatingCommits: [], ok: true });
  assert.match(report, /nothing to check/);
});

test('buildReport: lists the validating commit and its marker when passing', () => {
  const report = buildReport({
    manifestChanged: true,
    ok: true,
    validatingCommits: [{ hash: 'aaa1111bbb', subject: 'test: automate KAN-9', marker: 'Traceability-Stage: traceability-link' }],
  });
  assert.match(report, /aaa1111/);
  assert.match(report, /Traceability-Stage: traceability-link/);
});

test('buildReport: explains both remediation options when failing', () => {
  const report = buildReport({ manifestChanged: true, ok: false, validatingCommits: [] });
  assert.match(report, /Traceability-Stage:/);
  assert.match(report, /Traceability-Manual:/);
  assert.match(report, /git commit --amend/);
});
