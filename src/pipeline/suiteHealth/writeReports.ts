import fs from 'node:fs';
import path from 'node:path';
import { tenantDataPath } from '../config/tenantContext';
import { SuiteHealthReport, renderReportMarkdown } from './buildReport';

/**
 * Writes the Suite Health report to disk, mirroring flaky/healing report writers exactly: a
 * structured JSON plus the human-readable Markdown (rendered by buildReport's own
 * renderReportMarkdown - the writer never re-derives report text). Paths go through
 * tenantDataPath() like every other report here, so a `--tenant` run lands under data/<tenant>/.
 */
export function REPORT_JSON_PATH(): string { return tenantDataPath('suiteHealth', 'report.json'); }
export function REPORT_MD_PATH(): string { return tenantDataPath('suiteHealth', 'report.md'); }

export function writeSuiteHealthReports(report: SuiteHealthReport): {
  reportJsonPath: string;
  reportMdPath: string;
} {
  fs.mkdirSync(path.dirname(REPORT_JSON_PATH()), { recursive: true });
  fs.writeFileSync(REPORT_JSON_PATH(), `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
  fs.writeFileSync(REPORT_MD_PATH(), renderReportMarkdown(report), 'utf-8');
  return { reportJsonPath: REPORT_JSON_PATH(), reportMdPath: REPORT_MD_PATH() };
}
