import fs from 'node:fs';
import path from 'node:path';
import { FailureCategory, HealingEvent } from '../types/schemas';
import { isoWeekKey } from '../shared/isoWeek';
import { tenantDataPath } from '../config/tenantContext';

export { isoWeekKey };

export function REPORT_JSON_PATH(): string { return tenantDataPath('healing', 'report.json'); }
export function REPORT_MD_PATH(): string { return tenantDataPath('healing', 'report.md'); }

const CATEGORIES: FailureCategory[] = [
  'locator_drift',
  'ui_restructure',
  'copy_change',
  'real_regression',
  'environment_issue',
];

export interface WeekSuiteStats {
  week: string;
  suite: string;
  healed: number;
  escalated: number;
  passedNoHealNeeded: number;
  healingRate: number | null; // healed / (healed + escalated); null if neither happened
  avgAttemptsToHeal: number | null; // mean attemptNumber among healed events; null if none
  // Percentage (0-100) of *categorized* (healed/escalated) events in each category. Excludes
  // passed_no_heal_needed events, which never carry a category and would otherwise dilute it.
  categoryBreakdownPct: Record<FailureCategory, number>;
}

export interface SuiteTrend {
  suite: string;
  currentWeek: string;
  currentWeekHealingRate: number | null;
  previousWeek: string;
  previousWeekHealingRate: number | null;
  deltaPct: number | null; // percentage points, currentWeek - previousWeek
}

export interface HealingReport {
  generatedAt: string;
  totalEvents: number;
  overall: {
    healed: number;
    escalated: number;
    passedNoHealNeeded: number;
    healingRate: number | null;
    avgAttemptsToHeal: number | null;
  };
  byWeekAndSuite: WeekSuiteStats[];
  trendBySuite: SuiteTrend[];
}

function emptyCategoryBreakdown(): Record<FailureCategory, number> {
  return Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<FailureCategory, number>;
}

function computeRate(healed: number, escalated: number): number | null {
  const total = healed + escalated;
  return total === 0 ? null : healed / total;
}

function computeAvgAttempts(events: HealingEvent[]): number | null {
  const healed = events.filter((e) => e.outcome === 'healed');
  if (healed.length === 0) return null;
  return healed.reduce((sum, e) => sum + e.attemptNumber, 0) / healed.length;
}

function computeCategoryBreakdownPct(events: HealingEvent[]): Record<FailureCategory, number> {
  const categorized = events.filter((e) => e.category !== undefined);
  const breakdown = emptyCategoryBreakdown();
  if (categorized.length === 0) return breakdown;
  for (const e of categorized) breakdown[e.category as FailureCategory] += 1;
  for (const category of CATEGORIES) {
    breakdown[category] = (breakdown[category] / categorized.length) * 100;
  }
  return breakdown;
}

/**
 * Computes the full report from every event in the log. `now` is injectable so week-over-week
 * trend (which is anchored to "this calendar week" vs "last calendar week") is deterministic in
 * tests; production callers should leave it as the default.
 */
export function buildHealingReport(events: HealingEvent[], now: Date = new Date()): HealingReport {
  const byWeekSuite = new Map<string, HealingEvent[]>();
  for (const event of events) {
    const key = `${isoWeekKey(new Date(event.timestamp))}::${event.suite}`;
    const list = byWeekSuite.get(key) ?? [];
    list.push(event);
    byWeekSuite.set(key, list);
  }

  const byWeekAndSuite: WeekSuiteStats[] = [];
  for (const [key, groupEvents] of byWeekSuite) {
    const [week, suite] = key.split('::');
    const healed = groupEvents.filter((e) => e.outcome === 'healed').length;
    const escalated = groupEvents.filter((e) => e.outcome === 'escalated').length;
    const passedNoHealNeeded = groupEvents.filter((e) => e.outcome === 'passed_no_heal_needed').length;
    byWeekAndSuite.push({
      week,
      suite,
      healed,
      escalated,
      passedNoHealNeeded,
      healingRate: computeRate(healed, escalated),
      avgAttemptsToHeal: computeAvgAttempts(groupEvents),
      categoryBreakdownPct: computeCategoryBreakdownPct(groupEvents),
    });
  }
  byWeekAndSuite.sort((a, b) =>
    a.week === b.week ? a.suite.localeCompare(b.suite) : a.week.localeCompare(b.week),
  );

  const suites = [...new Set(events.map((e) => e.suite))].sort();
  const currentWeek = isoWeekKey(now);
  const previousWeek = isoWeekKey(new Date(now.getTime() - 7 * 24 * 3600 * 1000));

  const trendBySuite: SuiteTrend[] = suites.map((suite) => {
    const current = byWeekAndSuite.find((s) => s.week === currentWeek && s.suite === suite);
    const previous = byWeekAndSuite.find((s) => s.week === previousWeek && s.suite === suite);
    const currentRate = current?.healingRate ?? null;
    const previousRate = previous?.healingRate ?? null;
    const deltaPct =
      currentRate !== null && previousRate !== null ? (currentRate - previousRate) * 100 : null;
    return {
      suite,
      currentWeek,
      currentWeekHealingRate: currentRate,
      previousWeek,
      previousWeekHealingRate: previousRate,
      deltaPct,
    };
  });

  const healed = events.filter((e) => e.outcome === 'healed').length;
  const escalated = events.filter((e) => e.outcome === 'escalated').length;
  const passedNoHealNeeded = events.filter((e) => e.outcome === 'passed_no_heal_needed').length;

  return {
    generatedAt: now.toISOString(),
    totalEvents: events.length,
    overall: {
      healed,
      escalated,
      passedNoHealNeeded,
      healingRate: computeRate(healed, escalated),
      avgAttemptsToHeal: computeAvgAttempts(events),
    },
    byWeekAndSuite,
    trendBySuite,
  };
}

export function writeHealingReports(
  report: HealingReport,
): { reportJsonPath: string; reportMdPath: string } {
  fs.mkdirSync(path.dirname(REPORT_JSON_PATH()), { recursive: true });
  fs.writeFileSync(REPORT_JSON_PATH(), `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
  fs.writeFileSync(REPORT_MD_PATH(), buildReportMarkdown(report), 'utf-8');
  return { reportJsonPath: REPORT_JSON_PATH(), reportMdPath: REPORT_MD_PATH() };
}

function pct(rate: number | null): string {
  return rate === null ? 'n/a' : `${(rate * 100).toFixed(1)}%`;
}

function buildReportMarkdown(report: HealingReport): string {
  const lines: string[] = [];
  lines.push('# Healing Telemetry Report', '', `Generated: ${report.generatedAt}`, '');

  lines.push('## Overall', '');
  lines.push(`- Total events: ${report.totalEvents}`);
  lines.push(`- Healed: ${report.overall.healed}`);
  lines.push(`- Escalated: ${report.overall.escalated}`);
  lines.push(`- Passed, no heal needed: ${report.overall.passedNoHealNeeded}`);
  lines.push(`- Healing rate: ${pct(report.overall.healingRate)}`);
  lines.push(
    `- Average attempts-to-heal: ${
      report.overall.avgAttemptsToHeal === null ? 'n/a' : report.overall.avgAttemptsToHeal.toFixed(2)
    }`,
  );
  lines.push('');

  lines.push(
    '## Week-over-week trend by suite',
    '',
    '| Suite | Previous week | This week | Δ |',
    '|---|---|---|---|',
  );
  for (const trend of report.trendBySuite) {
    const delta =
      trend.deltaPct === null
        ? 'n/a'
        : `${trend.deltaPct >= 0 ? '+' : ''}${trend.deltaPct.toFixed(1)}pp`;
    lines.push(
      `| ${trend.suite} | ${pct(trend.previousWeekHealingRate)} (${trend.previousWeek}) | ${pct(trend.currentWeekHealingRate)} (${trend.currentWeek}) | ${delta} |`,
    );
  }
  lines.push('');

  lines.push('## By week and suite', '');
  for (const stats of report.byWeekAndSuite) {
    lines.push(`### ${stats.week} — ${stats.suite}`, '');
    lines.push(
      `- Healed: ${stats.healed}, Escalated: ${stats.escalated}, Passed (no heal): ${stats.passedNoHealNeeded}`,
    );
    lines.push(`- Healing rate: ${pct(stats.healingRate)}`);
    lines.push(
      `- Average attempts-to-heal: ${
        stats.avgAttemptsToHeal === null ? 'n/a' : stats.avgAttemptsToHeal.toFixed(2)
      }`,
    );
    const categoryLines = CATEGORIES.filter((c) => stats.categoryBreakdownPct[c] > 0).map(
      (c) => `${c}: ${stats.categoryBreakdownPct[c].toFixed(1)}%`,
    );
    lines.push(`- Category breakdown: ${categoryLines.length > 0 ? categoryLines.join(', ') : 'none'}`);
    lines.push('');
  }

  return lines.join('\n');
}
