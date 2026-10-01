// One-shot manifest fix for KAN-3/KAN-4/KAN-9 drift, done as a SINGLE read + SINGLE write to
// manifest.json (instead of 8 separate `--stage traceability-accept-baseline` process
// invocations each doing their own load/save cycle). Written specifically to rule out
// "many rapid rewrites of the same file trigger EDR/AV rollback" as the cause of the manifest
// repeatedly reverting to a stale state during this fix - see the Continuity Log / today's
// session for the full story. Safe to delete once this is confirmed resolved and committed.
//
// Run with: npx tsx scripts/fix-traceability-drift-once.ts

import fs from 'node:fs';
import { loadManifest, saveManifest } from '../src/pipeline/traceability/manifestStore';
import { hashCase, hashScenarioTestBlock } from '../src/pipeline/traceability/hashing';
import { findTestBlocks } from '../src/pipeline/shared/testBlocks';
import { getTestManagementClient } from '../src/pipeline/testmgmt';
import type { TraceabilityEntry } from '../src/pipeline/types/schemas';

interface Target {
  jiraKey: string;
  externalCaseId: string;
  testFilePath: string;
  testTitle: string;
}

const targets: Target[] = [
  {
    jiraKey: 'KAN-3',
    externalCaseId: '8',
    testFilePath: 'tests/ui/student/student-profile.spec.ts',
    testTitle: 'should open my profile from account menu',
  },
  {
    jiraKey: 'KAN-3',
    externalCaseId: '9',
    testFilePath: 'tests/ui/student/student-profile.spec.ts',
    testTitle: 'should reopen profile after navigating away',
  },
  {
    jiraKey: 'KAN-3',
    externalCaseId: '10',
    testFilePath: 'tests/ui/student/student-profile.spec.ts',
    testTitle: 'should list all profile sections and save controls',
  },
  {
    jiraKey: 'KAN-3',
    externalCaseId: '11',
    testFilePath: 'tests/ui/student/student-profile.spec.ts',
    testTitle: 'should navigate to each profile section without errors',
  },
  {
    jiraKey: 'KAN-4',
    externalCaseId: '16',
    testFilePath: 'tests/ui/student/student-personal-details.spec.ts',
    testTitle: 'should show existing personal detail values on profile page',
  },
  {
    jiraKey: 'KAN-4',
    externalCaseId: '17',
    testFilePath: 'tests/ui/student/student-personal-details.spec.ts',
    testTitle: 'should update and save all personal detail fields',
  },
  {
    jiraKey: 'KAN-4',
    externalCaseId: '18',
    testFilePath: 'tests/ui/student/student-personal-details.spec.ts',
    testTitle: 'should persist values after profile page reopened',
  },
  {
    jiraKey: 'KAN-9',
    externalCaseId: '19',
    testFilePath: 'tests/ui/test-prep/package-renewal.spec.ts',
    testTitle: 'should verify package renewal flow up to payment gateway without purchase',
  },
];

async function main() {
  const tms = await getTestManagementClient();
  const now = new Date().toISOString();
  const built: TraceabilityEntry[] = [];

  for (const t of targets) {
    if (!fs.existsSync(t.testFilePath)) {
      throw new Error(`${t.testFilePath} does not exist - aborting before writing anything.`);
    }
    const caseDetail = await tms.getCase(t.externalCaseId);
    const externalCaseHash = hashCase(caseDetail);
    const source = fs.readFileSync(t.testFilePath, 'utf-8');
    const blocks = findTestBlocks(source, t.testFilePath);
    const matches = blocks.filter((b) => b.testTitle === t.testTitle);
    if (matches.length !== 1) {
      throw new Error(
        `${t.testFilePath} has ${matches.length} test(...) block(s) titled "${t.testTitle}" ` +
          '(expected exactly 1) - aborting before writing anything.',
      );
    }
    const block = matches[0];
    const testContentHash = await hashScenarioTestBlock(block.source);
    const testLastModified = fs.statSync(t.testFilePath).mtime.toISOString();

    built.push({
      jiraKey: t.jiraKey,
      externalCaseId: t.externalCaseId,
      externalCaseHash,
      externalCaseUpdatedAt: caseDetail.updatedAt ?? now,
      tmsProvider: 'qase',
      testFilePath: t.testFilePath,
      testTitle: block.testTitle,
      testContentHash,
      testLastModified,
      syncState: 'IN_SYNC',
      lastCheckedAt: now,
    });
    console.log(`Prepared ${t.jiraKey} case ${t.externalCaseId} (in memory only, not yet saved).`);
  }

  // Single read, single write: drop any existing entry for these exact (jiraKey, externalCaseId)
  // pairs - regardless of what testTitle they currently have, stale or otherwise - then append
  // the freshly built, correct ones. Everything else (KAN-1, any future ticket) passes through
  // untouched.
  const manifest = loadManifest();
  const targetKeys = new Set(targets.map((t) => `${t.jiraKey}::${t.externalCaseId}`));
  const kept = manifest.entries.filter((e) => !targetKeys.has(`${e.jiraKey}::${e.externalCaseId}`));
  const nextEntries = [...kept, ...built];

  saveManifest({ workflow: manifest.workflow, entries: nextEntries });
  console.log(`\nDone - wrote ${nextEntries.length} total entries in one save (was ${manifest.entries.length}).`);
  console.log('Now run: git add -A -- data/default/traceability && git commit -m "fix(traceability): rebuild KAN-3/KAN-4/KAN-9 baselines in a single write"');
  console.log('Then run: npm run drift:check');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
