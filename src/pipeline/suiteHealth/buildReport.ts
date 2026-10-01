import {
  classifyCase,
  daysSince,
  type CaseHealth,
  type CaseVerdict,
  type RecommendedAction,
  type RiskBand,
  type SuiteCaseRecord,
  type VerdictReason,
} from './classify';
import type { CollectionWarning } from './collectSignals';
import type { TestAssertionAnalysis } from './detectUnfailableAssertions';
import type { DuplicatePair } from './findDuplicateCoverage';
import type { RiskScore } from './riskWeight';

/**
 * Section 7 of the Suite Health spec: six sections, readable in ten minutes, forwardable to a
 * manager.
 *
 * TWO OUTPUTS ON PURPOSE. `buildReport` produces a structured object; `renderReportMarkdown`
 * turns it into text. Everything worth arguing about - which rows appear, in what order, with
 * what evidence - is decided in the structured half, where a test can assert on it. The renderer
 * only formats. A report whose ordering logic lives inside string concatenation cannot be tested,
 * and this is a report that will be argued with.
 *
 * SORTED BY RISK, NOT BY VERDICT. A QA lead reads the top twenty rows and nothing else.
 */

export interface BuildReportInput {
  records: SuiteCaseRecord[];
  riskScores: RiskScore[];
  /** From `collectSignals`, so the quoted assertion always belongs to the case it sits under. */
  analysisByCaseId: Record<string, TestAssertionAnalysis>;
  duplicatePairs: DuplicatePair[];
  /** Data-quality problems from the join. Printed, not hidden - see §7 section 6. */
  warnings: CollectionWarning[];
  /** Tests in the spec files that no case links to. Automation nobody is counting. */
  unlinkedTests: TestAssertionAnalysis[];
  now: Date;
}

export interface ReportRow {
  caseId: string;
  title: string;
  verdict: CaseVerdict;
  action: RecommendedAction;
  riskScore: number;
  riskBand: RiskBand;
  reasons: VerdictReason[];
  /** Quoted assertions, quarantine dates, drift states. A verdict without evidence is an opinion. */
  evidence: string[];
}

export interface SuppressedRow extends ReportRow {
  kind: 'quarantined' | 'skipped' | 'fixme';
  /** null when the start date is not recorded anywhere. */
  since: string | null;
  /** null when the start date is not recorded. Render as "unknown", never as 0. */
  durationDays: number | null;
}

export interface ReportHeadline {
  totalCases: number;
  healthyPercent: number;
  byVerdict: Record<CaseVerdict, number>;
  /**
   * Executions, not cases. "14 tests, 4,200 executions, zero possible failures" puts a cost on
   * the placebo as well as a risk; "14 tests" does not.
   */
  protectingNothingRunCount: number;
  /** null when every suppression has an unknown start date. */
  longestSuppressionDays: number | null;
  suppressionsWithUnknownDuration: number;
}

export interface SuiteHealthReport {
  generatedAt: string;
  headline: ReportHeadline;
  /** §7.2 - the assertion-integrity list, highest risk first. */
  protectingNothing: ReportRow[];
  /** §7.3 - coverage you think you have and do not. Longest first, then risk. */
  suppressed: SuppressedRow[];
  /** §7.4 - the requirement changed after the test was written. */
  stale: ReportRow[];
  /** §7.5 - consolidation candidates, strongest overlap first. */
  consolidation: DuplicatePair[];
  /** Cases the join could not fully resolve. Not a footnote: a missing row is a silent gap. */
  dataQuality: CollectionWarning[];
  /** Automation linked to no case at all. */
  unlinkedTests: Array<{ filePath: string; title: string }>;
  /** §7 section 6, mandatory. */
  notChecked: string[];
}

/**
 * The mandatory limits section.
 *
 * Not modesty. It is what stops a reader over-trusting the rest, and it is exactly what a
 * relevance-based tool omits. Hard-coded rather than assembled from what happened to run,
 * because the point is that these are the limits of the METHOD, true on every run.
 */
export const NOT_CHECKED: readonly string[] = Object.freeze([
  'Nothing here was executed. This reads test case text, spec source and run history only.',
  'Whether the feature a case describes still exists in the product is not known to this report.',
  'Whether an assertion checks a real value or its own mock cannot be determined from a static parse.',
  'Whether a locator still matches anything in the running application is not checked.',
  'Whether a passing test is passing for the right reason is not checked.',
  'Duplicate detection is word overlap, not semantic comparison. It can pair two cases that differ in one word that matters.',
]);

function verdictCounts(health: CaseHealth[]): Record<CaseVerdict, number> {
  const counts: Record<CaseVerdict, number> = {
    PROTECTING_NOTHING: 0,
    SUPPRESSED: 0,
    ORPHANED: 0,
    STALE: 0,
    DUPLICATE: 0,
    COLD_BUT_LOAD_BEARING: 0,
    HEALTHY: 0,
  };
  for (const item of health) counts[item.verdict] += 1;
  return counts;
}

function evidenceFor(
  record: SuiteCaseRecord,
  analysis: TestAssertionAnalysis | undefined,
  now: Date,
): string[] {
  const evidence: string[] = [];

  if (analysis && analysis.assertion.cannotFail) {
    evidence.push(...analysis.evidence.map((line) => `${analysis.filePath} - ${line}`));
  }

  if (record.suppression) {
    const days = suppressionDays(record.suppression.since, now);
    evidence.push(
      days === null
        ? `${record.suppression.kind} since an unrecorded date - duration unknown.`
        : `${record.suppression.kind} since ${record.suppression.since} (${days} days), still counted as covered.`,
    );
  }

  if (record.traceability !== 'IN_SYNC') {
    evidence.push(`Traceability state: ${record.traceability}.`);
  }

  if (analysis?.weakOnly) {
    evidence.push('Every assertion is presence-only - it checks that things exist, not that they are correct.');
  }

  return evidence;
}

/** null rather than 0 when the date is unknown. Reporting "0 days" would understate a real gap. */
function suppressionDays(since: string | null, now: Date): number | null {
  return since === null ? null : daysSince(since, now);
}

export function buildReport(input: BuildReportInput): SuiteHealthReport {
  const scoreByCaseId = new Map(input.riskScores.map((score) => [score.caseId, score]));
  const recordByCaseId = new Map(input.records.map((record) => [record.caseId, record]));

  const health = input.records.map((record) => classifyCase(record, input.now));
  const healthByCaseId = new Map(health.map((item) => [item.caseId, item]));

  const rowFor = (caseId: string): ReportRow | null => {
    const record = recordByCaseId.get(caseId);
    const item = healthByCaseId.get(caseId);
    if (!record || !item) return null;
    const score = scoreByCaseId.get(caseId);
    return {
      caseId,
      title: record.title,
      verdict: item.verdict,
      action: item.action,
      // A case with no score sorts last rather than being dropped. Dropping it would hide a
      // finding because of a configuration gap, which is the failure mode this report is about.
      riskScore: score?.score ?? 0,
      riskBand: record.riskBand,
      reasons: item.reasons,
      evidence: evidenceFor(record, input.analysisByCaseId[caseId], input.now),
    };
  };

  // Same rule as riskWeight's compareByRisk - highest first, case id as the stable tiebreak - but
  // over report rows. The tiebreak is not cosmetic: a report that reorders itself when nothing
  // changed is a report nobody diffs.
  const byRisk = (a: ReportRow, b: ReportRow): number =>
    b.riskScore - a.riskScore || a.caseId.localeCompare(b.caseId);

  const rowsWithVerdict = (verdict: CaseVerdict): ReportRow[] =>
    health
      .filter((item) => item.verdict === verdict)
      .map((item) => rowFor(item.caseId))
      .filter((row): row is ReportRow => row !== null)
      .sort(byRisk);

  const protectingNothing = rowsWithVerdict('PROTECTING_NOTHING');
  const stale = rowsWithVerdict('STALE');

  const suppressed: SuppressedRow[] = rowsWithVerdict('SUPPRESSED')
    .map((row) => {
      const record = recordByCaseId.get(row.caseId);
      const suppression = record?.suppression;
      return {
        ...row,
        kind: suppression?.kind ?? 'skipped',
        since: suppression?.since ?? null,
        durationDays: suppression ? suppressionDays(suppression.since, input.now) : null,
      };
    })
    // Longest first, because duration IS the finding here - "uncovered since April" is the
    // sentence that lands. Unknown durations sort last: they might be the worst rows in the
    // table, but claiming a position for them would be inventing the number.
    .sort(
      (a, b) =>
        (b.durationDays ?? -1) - (a.durationDays ?? -1) || byRisk(a, b),
    );

  const protectingNothingRunCount = protectingNothing.reduce(
    (total, row) => total + (recordByCaseId.get(row.caseId)?.execution.totalRuns ?? 0),
    0,
  );

  const knownDurations = suppressed
    .map((row) => row.durationDays)
    .filter((days): days is number => days !== null);

  const counts = verdictCounts(health);

  return {
    generatedAt: input.now.toISOString(),
    headline: {
      totalCases: input.records.length,
      healthyPercent:
        input.records.length === 0
          ? 0
          : Math.round((counts.HEALTHY / input.records.length) * 100),
      byVerdict: counts,
      protectingNothingRunCount,
      longestSuppressionDays: knownDurations.length > 0 ? Math.max(...knownDurations) : null,
      suppressionsWithUnknownDuration: suppressed.filter((row) => row.durationDays === null).length,
    },
    protectingNothing,
    suppressed,
    stale,
    consolidation: [...input.duplicatePairs].sort(
      (a, b) => b.similarity - a.similarity || a.caseIds[0].localeCompare(b.caseIds[0]),
    ),
    dataQuality: input.warnings,
    unlinkedTests: input.unlinkedTests.map((analysis) => ({
      filePath: analysis.filePath,
      title: analysis.title,
    })),
    notChecked: [...NOT_CHECKED],
  };
}

function renderRows(rows: ReportRow[], emptyLine: string): string[] {
  if (rows.length === 0) return [emptyLine];
  const lines: string[] = [];
  for (const row of rows) {
    lines.push(`- **${row.caseId}** - ${row.title} _(risk ${row.riskScore}, ${row.riskBand})_`);
    for (const item of row.evidence) lines.push(`  - ${item}`);
    lines.push(`  - Action: ${row.action}`);
  }
  return lines;
}

/** Formats only. Every decision about what appears and in what order was made in buildReport. */
export function renderReportMarkdown(report: SuiteHealthReport): string {
  const h = report.headline;
  const lines: string[] = [];

  lines.push('# Suite health and coverage risk');
  lines.push('');
  lines.push(`Generated ${report.generatedAt}.`);
  lines.push('');

  lines.push('## 1. Headline');
  lines.push('');
  lines.push(
    `Of ${h.totalCases} cases: ${h.healthyPercent}% healthy, ` +
      `${h.byVerdict.PROTECTING_NOTHING} protecting nothing, ` +
      `${h.byVerdict.SUPPRESSED} suppressed, ` +
      `${h.byVerdict.DUPLICATE} duplicates, ` +
      `${h.byVerdict.STALE} stale, ` +
      `${h.byVerdict.ORPHANED} orphaned, ` +
      `${h.byVerdict.COLD_BUT_LOAD_BEARING} cold but load-bearing.`,
  );
  lines.push('');
  if (h.byVerdict.PROTECTING_NOTHING > 0) {
    lines.push(
      `**${h.byVerdict.PROTECTING_NOTHING} ${h.byVerdict.PROTECTING_NOTHING === 1 ? 'test' : 'tests'}. ` +
        `${h.protectingNothingRunCount} total executions. Zero possible failures.**`,
    );
    lines.push('');
  }
  if (h.longestSuppressionDays !== null) {
    lines.push(`**Longest suppression: ${h.longestSuppressionDays} days.**`);
    lines.push('');
  }
  if (h.suppressionsWithUnknownDuration > 0) {
    lines.push(
      `${h.suppressionsWithUnknownDuration} suppressed ${
        h.suppressionsWithUnknownDuration === 1 ? 'case has' : 'cases have'
      } no recorded start date, so the duration is unknown - not zero.`,
    );
    lines.push('');
  }

  lines.push('## 2. Protecting nothing');
  lines.push('');
  lines.push(...renderRows(report.protectingNothing, 'None found.'));
  lines.push('');

  lines.push('## 3. Coverage you think you have and do not');
  lines.push('');
  if (report.suppressed.length === 0) {
    lines.push('None found.');
  } else {
    for (const row of report.suppressed) {
      const duration = row.durationDays === null ? 'duration unknown' : `${row.durationDays} days`;
      lines.push(
        `- **${row.caseId}** - ${row.title} - ${row.kind}, ${duration} _(risk ${row.riskScore}, ${row.riskBand})_`,
      );
      lines.push(`  - Action: ${row.action}`);
    }
  }
  lines.push('');

  lines.push('## 4. Stale');
  lines.push('');
  lines.push(...renderRows(report.stale, 'None found.'));
  lines.push('');

  lines.push('## 5. Consolidation candidates');
  lines.push('');
  if (report.consolidation.length === 0) {
    lines.push('None found.');
  } else {
    for (const pair of report.consolidation) {
      lines.push(
        `- **${pair.caseIds[0]}** and **${pair.caseIds[1]}** - ${Math.round(pair.similarity * 100)}% overlap. ` +
          `Suggested survivor: ${pair.suggestedSurvivor}.`,
      );
      lines.push(`  - Shared terms: ${pair.sharedTerms.join(', ')}`);
      lines.push('  - Action: consolidate and archive. Nothing here is deleted.');
    }
  }
  lines.push('');

  if (report.dataQuality.length > 0 || report.unlinkedTests.length > 0) {
    lines.push('## 6. Data quality');
    lines.push('');
    for (const warning of report.dataQuality) {
      lines.push(`- **${warning.caseId}** (${warning.code}) - ${warning.message}`);
    }
    for (const item of report.unlinkedTests) {
      lines.push(`- ${item.filePath} - "${item.title}" is linked to no case. Nobody is counting it.`);
    }
    lines.push('');
  }

  lines.push('## 7. What we did not check');
  lines.push('');
  for (const item of report.notChecked) lines.push(`- ${item}`);
  lines.push('');

  return lines.join('\n');
}
