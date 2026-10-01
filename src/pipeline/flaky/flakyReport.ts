import fs from 'node:fs';
import path from 'node:path';
import { FlakyEvent, QuarantineEntry } from '../types/schemas';
import { tenantDataPath } from '../config/tenantContext';

export function REPORT_JSON_PATH(): string { return tenantDataPath('flaky', 'report.json'); }
export function REPORT_MD_PATH(): string { return tenantDataPath('flaky', 'report.md'); }

export interface SuiteBreakdown {
  suite: string;
  activeCount: number;
}

export interface FlakyReport {
  generatedAt: string;
  totalQuarantinedAllTime: number;
  currentlyActive: number;
  breakdownBySuite: SuiteBreakdown[];
  // Mean evidence-entry count among all-time quarantined events - how many observed runs it
  // typically took to catch a flaky test. null if nothing has ever been quarantined.
  avgRunsToDetect: number | null;
}

/**
 * `events` is the full history (flaky/telemetry.jsonl); `quarantine` is current state
 * (flaky/quarantine.json), cross-referenced here for the currently-active counts since a test can
 * be quarantined then later cleared and the log alone can't tell you which is still active.
 */
export function buildFlakyReport(
  events: FlakyEvent[],
  quarantine: QuarantineEntry[],
  now: Date = new Date(),
): FlakyReport {
  const quarantinedEvents = events.filter((e) => e.action === 'quarantined');

  const breakdownMap = new Map<string, number>();
  for (const entry of quarantine) {
    breakdownMap.set(entry.suite, (breakdownMap.get(entry.suite) ?? 0) + 1);
  }
  const breakdownBySuite: SuiteBreakdown[] = [...breakdownMap.entries()]
    .map(([suite, activeCount]) => ({ suite, activeCount }))
    .sort((a, b) => a.suite.localeCompare(b.suite));

  const avgRunsToDetect =
    quarantinedEvents.length === 0
      ? null
      : quarantinedEvents.reduce((sum, e) => sum + e.evidence.length, 0) / quarantinedEvents.length;

  return {
    generatedAt: now.toISOString(),
    totalQuarantinedAllTime: quarantinedEvents.length,
    currentlyActive: quarantine.length,
    breakdownBySuite,
    avgRunsToDetect,
  };
}

export function writeFlakyReports(report: FlakyReport): { reportJsonPath: string; reportMdPath: string } {
  fs.mkdirSync(path.dirname(REPORT_JSON_PATH()), { recursive: true });
  fs.writeFileSync(REPORT_JSON_PATH(), `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
  fs.writeFileSync(REPORT_MD_PATH(), buildReportMarkdown(report), 'utf-8');
  return { reportJsonPath: REPORT_JSON_PATH(), reportMdPath: REPORT_MD_PATH() };
}

function buildReportMarkdown(report: FlakyReport): string {
  const lines: string[] = [];
  lines.push('# Flaky Test Quarantine Report', '', `Generated: ${report.generatedAt}`, '');

  lines.push('## Overall', '');
  lines.push(`- Total quarantined (all-time): ${report.totalQuarantinedAllTime}`);
  lines.push(`- Currently active: ${report.currentlyActive}`);
  lines.push(
    `- Average runs to detect: ${
      report.avgRunsToDetect === null ? 'n/a' : report.avgRunsToDetect.toFixed(2)
    }`,
  );
  lines.push('');

  lines.push('## Currently active by suite', '', '| Suite | Active |', '|---|---|');
  for (const { suite, activeCount } of report.breakdownBySuite) {
    lines.push(`| ${suite} | ${activeCount} |`);
  }
  if (report.breakdownBySuite.length === 0) {
    lines.push('| _none_ | 0 |');
  }
  lines.push('');

  return lines.join('\n');
}
