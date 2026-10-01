#!/usr/bin/env node
// Per-clone git configuration for this repo: the JSON-aware manifest merge driver, the union
// driver for append-only telemetry logs, and the repo-managed hooks path (the prepare-commit-msg
// hook auto-stamps the Traceability-Stage trailer the Manifest Provenance guardrail requires).
//
// Runs automatically on `npm install` via the "postinstall" script, and can be run manually with
// `npm run setup:git`. Safe to run repeatedly, and a deliberate no-op outside a git work tree
// (e.g. installed as a dependency, or a CI restore without .git) so it can never fail an install.

import { execFileSync } from 'node:child_process';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';

function git(args) {
  execFileSync('git', args, { stdio: ['ignore', 'ignore', 'ignore'] });
}

function inGitWorkTree() {
  try {
    return execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' }).trim() === 'true';
  } catch {
    return false;
  }
}

if (!inGitWorkTree()) {
  process.exit(0); // nothing to configure - never fail the install
}

try {
  git(['config', 'merge.manifest-merge.name', 'JSON-aware union merge for traceability/manifest.json']);
  git(['config', 'merge.manifest-merge.driver', 'node scripts/merge-manifest.mjs %O %A %B %P']);
  git(['config', 'merge.union.name', 'Line union merge for append-only telemetry logs']);
  git(['config', 'core.hooksPath', 'scripts/hooks']);

  // Hooks need the executable bit on macOS/Linux (Git for Windows ignores it).
  if (process.platform !== 'win32') {
    try {
      const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
      chmodSync(join(root, 'scripts', 'hooks', 'prepare-commit-msg'), 0o755);
    } catch {
      /* best-effort */
    }
  }
  console.log('git: merge drivers + hooks configured (manifest auto-merge, Traceability-Stage auto-stamp).');
} catch (err) {
  // A local git-config hiccup must never fail `npm install`.
  console.warn('setup-merge-drivers: skipped (could not configure git):', err && err.message ? err.message : err);
}
