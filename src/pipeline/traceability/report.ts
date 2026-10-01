import fs from 'node:fs';
import path from 'node:path';
import { SyncState } from '../types/schemas';
import { DriftCheckResult, DriftReportEntry } from './traceabilityAgent';
import { tenantDataPath } from '../config/tenantContext';

export function REPORT_JSON_PATH(): string { return tenantDataPath('traceability', 'report.json'); }
export function REPORT_MD_PATH(): string { return tenantDataPath('traceability', 'report.md'); }

const STATE_ORDER: SyncState[] = [
  'BOTH_DRIFTED',
  'CASE_DRIFTED',
  'TEST_DRIFTED',
  'ORPHANED_CASE',
  'ORPHANED_TEST',
  'IN_SYNC',
];

interface ReportJson {
  generatedAt: string;
  counts: Record<SyncState, number>;
  entries: DriftReportEntry[];
}

export function writeReports(result: DriftCheckResult): { reportJsonPath: string; reportMdPath: string } {
  const generatedAt = new Date().toISOString();
  const json: ReportJson = { generatedAt, counts: result.counts, entries: result.entries };

  fs.mkdirSync(path.dirname(REPORT_JSON_PATH()), { recursive: true });
  fs.writeFileSync(REPORT_JSON_PATH(), `${JSON.stringify(json, null, 2)}\n`, 'utf-8');
  fs.writeFileSync(REPORT_MD_PATH(), buildReportMarkdown(generatedAt, result), 'utf-8');

  return { reportJsonPath: REPORT_JSON_PATH(), reportMdPath: REPORT_MD_PATH() };
}

function buildReportMarkdown(generatedAt: string, result: DriftCheckResult): string {
  const lines: string[] = [];
  lines.push('# Traceability Drift Report', '', `Generated: ${generatedAt}`, '');

  lines.push('## Summary', '', '| State | Count |', '|---|---|');
  for (const state of STATE_ORDER) {
    lines.push(`| ${state} | ${result.counts[state]} |`);
  }
  lines.push('');

  for (const state of STATE_ORDER) {
    const entries = result.entries.filter((e) => e.syncState === state);
    if (entries.length === 0) continue;

    lines.push(`## ${state} (${entries.length})`, '');
    for (const entry of entries) {
      lines.push(
        `- **${entry.jiraKey}** — ${entry.tmsProvider} case ${entry.externalCaseId} ↔ \`${entry.testFilePath}\``,
      );
      if (state === 'CASE_DRIFTED' || state === 'BOTH_DRIFTED') {
        lines.push(
          `  - baseline case hash: \`${entry.externalCaseHash}\``,
          `  - current case hash: \`${entry.currentExternalCaseHash ?? '(unavailable)'}\``,
        );
      }
      if (state === 'TEST_DRIFTED' || state === 'BOTH_DRIFTED') {
        lines.push(
          `  - baseline test hash: \`${entry.testContentHash}\``,
          `  - current test hash: \`${entry.currentTestContentHash ?? '(unavailable)'}\``,
        );
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}
