import fs from 'node:fs';
import { parseScenariosFromSpec, parseJiraKeyFromSpec } from '../specs/specParser';
import type { TestManagementClient, TmsRunRecord } from '../testmgmt/types';
import { hashCase, hashScenarioTestBlock } from './hashing';
import { findTestBlocks, resolveTestBlock } from '../shared/testBlocks';
import { TraceabilityEntry } from '../types/schemas';
import { getTenantId } from '../config/tenantContext';

export interface BuildEntriesResult {
  entries: TraceabilityEntry[];
  skipped: string[];
}

/**
 * Builds baseline TraceabilityEntry objects for every scenario in one spec file that has both a
 * **File:** line (testFilePath, parsed by specParser.ts) and a matching case id in a tms-run.json
 * run record. This is the first point in the pipeline where jiraKey + externalCaseId +
 * testFilePath are all known together - the TMS upload happens after Generation, not before (see
 * README.md's pipeline order) - so this is called from the TMS Agent's traceability-record stage
 * right after tms-upload, and from the one-time backfill script for everything that predates this
 * feature.
 */
export async function buildEntriesForSpec(
  specFile: string,
  runRecord: TmsRunRecord,
  tms: TestManagementClient,
): Promise<BuildEntriesResult> {
  const entries: TraceabilityEntry[] = [];
  const skipped: string[] = [];
  const now = new Date().toISOString();

  const jiraKey = parseJiraKeyFromSpec(specFile);
  if (!jiraKey) {
    skipped.push(`${specFile}: no "<!-- Jira: KEY -->" marker, skipping all its scenarios`);
    return { entries, skipped };
  }

  const caseIdByScenarioId = new Map(runRecord.cases.map((c) => [c.id, c.externalCaseId]));
  const scenarios = parseScenariosFromSpec(specFile);

  for (const scenario of scenarios) {
    if (!scenario.testFilePath) {
      skipped.push(`${specFile}#${scenario.id}: no **File:** line in the spec`);
      continue;
    }
    if (!fs.existsSync(scenario.testFilePath)) {
      skipped.push(`${specFile}#${scenario.id}: test file ${scenario.testFilePath} not generated yet`);
      continue;
    }
    const externalCaseId = caseIdByScenarioId.get(scenario.id);
    if (externalCaseId === undefined) {
      skipped.push(`${specFile}#${scenario.id}: not found in the given TMS run record`);
      continue;
    }

    // Resolve which test(...) block within testFilePath this scenario is - unambiguous if the
    // file holds only this one scenario (every file generated before multi-test-per-file support,
    // and any single-scenario group today); otherwise requires a `// scenario-id: <scenario.id>`
    // marker above the right block (see test-generation.md and shared/testBlocks.ts). Skipped
    // (not guessed) when that can't be resolved cleanly, same deterministic-only philosophy as the
    // backfill script.
    const testSource = fs.readFileSync(scenario.testFilePath, 'utf-8');
    const blocks = findTestBlocks(testSource, scenario.testFilePath);
    const block = resolveTestBlock(blocks, scenario.id);
    if (!block) {
      skipped.push(
        `${specFile}#${scenario.id}: ${scenario.testFilePath} has ${blocks.length} test(...) blocks and none ` +
          `carries a "// scenario-id: ${scenario.id}" marker - cannot tell which one this scenario is`,
      );
      continue;
    }

    const caseDetail = await tms.getCase(externalCaseId);
    const externalCaseHash = hashCase(caseDetail);
    const testContentHash = await hashScenarioTestBlock(block.source);
    const testLastModified = fs.statSync(scenario.testFilePath).mtime.toISOString();

    entries.push({
      tenantId: getTenantId(),
      jiraKey,
      externalCaseId,
      externalCaseHash,
      externalCaseUpdatedAt: caseDetail.updatedAt ?? now,
      tmsProvider: runRecord.provider,
      testFilePath: scenario.testFilePath,
      testTitle: block.testTitle,
      testContentHash,
      testLastModified,
      syncState: 'IN_SYNC',
      lastCheckedAt: now,
    });
  }

  return { entries, skipped };
}
