import type { QuarantineEntry, TraceabilityEntry } from '../types/schemas';
import type { RiskBand, SuiteCaseRecord, SuppressionState, TraceabilityState } from './classify';
import {
  analyseSpecFiles,
  indexAnalyses,
  testKey,
  NO_AUTOMATION_ASSERTION_STATE,
  type SpecFile,
  type TestAssertionAnalysis,
} from './detectUnfailableAssertions';

/**
 * Joins the six Suite Health signals into one `SuiteCaseRecord` per test-management case, which is
 * what `classifyCase` consumes.
 *
 * PURE ON PURPOSE. Every input is passed in; nothing here reads a file, calls an API or looks at
 * the clock. The stores this replaces (`loadManifest`, `loadQuarantine`, the TMS client) are all
 * I/O, and a join that does its own I/O cannot be tested against the awkward cases - a case whose
 * spec file was deleted, a shared spec file with an ambiguous title, a suppression with no known
 * start date. Those are the cases this report gets judged on, so they need to be reachable in a
 * unit test. The thin caller that does the loading lives outside this file.
 *
 * NOTHING IS SILENTLY DROPPED. A case this cannot fully resolve still produces a record, plus a
 * warning saying what could not be resolved. A case that vanishes from the report because its
 * spec file moved is the exact failure this whole feature exists to prevent.
 */

/** One case as it comes out of the test management tool. */
export interface TmsCaseInput {
  /** The provider's case id - `TraceabilityEntry.externalCaseId`. */
  caseId: string;
  title: string;
}

/**
 * Run history for one case. Signal 6, and the only genuinely new ingestion in the feature: no
 * store in this repo records how many times a case has run, so it comes from the TMS.
 */
export interface CaseExecutionInput {
  caseId: string;
  totalRuns: number;
  failedRuns: number;
  lastRunAt: string | null;
}

export interface CollectSignalsInput {
  cases: TmsCaseInput[];
  /** `loadManifest().entries`. */
  traceability: TraceabilityEntry[];
  /** `loadQuarantine()`. */
  quarantine: QuarantineEntry[];
  /** Spec file contents. Parsed once here, not once per case. */
  specs: SpecFile[];
  execution: CaseExecutionInput[];
  /**
   * Groups of case ids that substantially duplicate each other.
   *
   * Passed in rather than computed, because `checkDuplicateCoverage` in `scenarioQualityRules`
   * does NOT answer this. It compares scenarios within one ticket's generated batch, before they
   * are ever created, and its `jaccard`/`tokenSet` helpers are private to that file. A
   * corpus-wide duplicate pass over existing TMS cases is separate work. Until it exists, pass
   * an empty array and the DUPLICATE verdict simply never fires - which is the honest behaviour.
   */
  duplicateGroups: string[][];
  /**
   * Case id -> risk band, from per-project configuration.
   *
   * Never inferred. One customer's "billing" is another's "core", and a guessed high band on the
   * About page is how the top of the report stops being trusted. Unconfigured cases fall to
   * DEFAULT_RISK_BAND and are warned about.
   */
  riskBands: Record<string, RiskBand>;
  /**
   * ISO date a `test.skip` / `test.fixme` began, keyed by `testKey(filePath, title)`.
   *
   * Quarantine carries its own `quarantinedAt`, so this is only for static suppressions, whose
   * start date is not recorded anywhere in the repo - it needs git history. Optional so the
   * report works before that adapter exists; see UNKNOWN_SUPPRESSION_DATE below for what happens
   * when a date is missing.
   */
  suppressedSince?: Record<string, string>;
  now: Date;
}

export type CollectionWarningCode =
  | 'no-traceability-entry'
  | 'spec-file-missing'
  | 'test-not-found'
  | 'ambiguous-test-title'
  | 'suppression-date-unknown'
  | 'no-execution-history'
  | 'risk-band-not-configured';

export interface CollectionWarning {
  code: CollectionWarningCode;
  caseId: string;
  message: string;
}

export interface CollectionResult {
  records: SuiteCaseRecord[];
  /** In case order, so two runs over the same corpus produce byte-identical output. */
  warnings: CollectionWarning[];
  /**
   * The spec analysis behind each record's assertion state, keyed by case id. Absent for a case
   * with no resolvable test.
   *
   * Exposed so the report can quote the offending assertion without redoing the case-to-test
   * join. Two joins that disagree about which test a case points at would put the wrong quote
   * under the right verdict, which is worse than no quote.
   */
  analysisByCaseId: Record<string, TestAssertionAnalysis>;
}

/**
 * Where a case has no configured risk band. Deliberately the middle band: 'high' would salt the
 * top of the report with unconfigured noise, 'low' would bury a real payments case under the
 * fold. Every use is warned about, so "unconfigured" stays visible rather than becoming the
 * silent default state of the whole suite.
 */
export const DEFAULT_RISK_BAND: RiskBand = 'medium';

/**
 * WHY AN UNDATED SUPPRESSION IS STILL REPORTED.
 *
 * `SuppressionState.since` is null when a skip/fixme start date is not recorded anywhere. The
 * alternative was to omit the suppression entirely, and that is worse: §5.2 of the spec is that a
 * suppressed test is counted as covered while covering nothing, so dropping it restores exactly
 * the false confidence the report exists to remove. A `suppression-date-unknown` warning is
 * emitted alongside, so the report prints "duration unknown" rather than "0 days".
 */

interface ResolvedTest {
  analysis: TestAssertionAnalysis | null;
  warning: CollectionWarningCode | null;
}

function resolveTest(
  entry: TraceabilityEntry,
  index: Map<string, TestAssertionAnalysis>,
  byFile: Map<string, TestAssertionAnalysis[]>,
): ResolvedTest {
  const inFile = byFile.get(entry.testFilePath);
  if (!inFile || inFile.length === 0) {
    return { analysis: null, warning: 'spec-file-missing' };
  }

  if (entry.testTitle !== undefined) {
    const found = index.get(testKey(entry.testFilePath, entry.testTitle));
    return found ? { analysis: found, warning: null } : { analysis: null, warning: 'test-not-found' };
  }

  // No testTitle recorded. A file with exactly one test is unambiguous - that is why the field is
  // optional in the schema. More than one, and guessing would attribute an unfailable assertion to
  // the wrong scenario, which is a false accusation against a specific test. Refuse instead.
  if (inFile.length === 1) return { analysis: inFile[0], warning: null };
  return { analysis: null, warning: 'ambiguous-test-title' };
}

function findQuarantine(
  quarantine: QuarantineEntry[],
  testFilePath: string,
  testTitle: string | undefined,
): QuarantineEntry | undefined {
  const exact = quarantine.find(
    (q) => q.testFilePath === testFilePath && q.testTitle === testTitle,
  );
  if (exact) return exact;
  // A file-scoped quarantine entry (no testTitle) predates multi-test-per-file support and
  // suppresses the whole file, so it applies to any test in it.
  return quarantine.find((q) => q.testFilePath === testFilePath && q.testTitle === undefined);
}

function buildDuplicateIndex(groups: string[][]): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const group of groups) {
    for (const caseId of group) {
      const others = group.filter((other) => other !== caseId);
      if (others.length === 0) continue;
      index.set(caseId, [...(index.get(caseId) ?? []), ...others]);
    }
  }
  return index;
}

export function collectSignals(input: CollectSignalsInput): CollectionResult {
  const analyses = analyseSpecFiles(input.specs);
  const index = indexAnalyses(analyses);

  const byFile = new Map<string, TestAssertionAnalysis[]>();
  for (const analysis of analyses) {
    byFile.set(analysis.filePath, [...(byFile.get(analysis.filePath) ?? []), analysis]);
  }

  // First entry wins, for the same reason indexAnalyses keeps the first: a duplicated link is a
  // real defect, but letting order decide which one is judged would make the report unstable.
  const entryByCaseId = new Map<string, TraceabilityEntry>();
  for (const entry of input.traceability) {
    if (!entryByCaseId.has(entry.externalCaseId)) entryByCaseId.set(entry.externalCaseId, entry);
  }

  const executionByCaseId = new Map(input.execution.map((e) => [e.caseId, e]));
  const duplicates = buildDuplicateIndex(input.duplicateGroups);
  const suppressedSince = input.suppressedSince ?? {};

  const records: SuiteCaseRecord[] = [];
  const warnings: CollectionWarning[] = [];
  const analysisByCaseId: Record<string, TestAssertionAnalysis> = {};

  const warn = (code: CollectionWarningCode, caseId: string, message: string): void => {
    warnings.push({ code, caseId, message });
  };

  for (const tmsCase of input.cases) {
    const entry = entryByCaseId.get(tmsCase.caseId);

    let analysis: TestAssertionAnalysis | null = null;
    if (!entry) {
      warn(
        'no-traceability-entry',
        tmsCase.caseId,
        'No traceability entry links this case to a spec file. Treated as having no automation.',
      );
    } else {
      const resolved = resolveTest(entry, index, byFile);
      analysis = resolved.analysis;
      if (resolved.warning === 'spec-file-missing') {
        warn(
          'spec-file-missing',
          tmsCase.caseId,
          `Linked to ${entry.testFilePath}, which was not in the spec set. The file may have moved or been deleted.`,
        );
      } else if (resolved.warning === 'test-not-found') {
        warn(
          'test-not-found',
          tmsCase.caseId,
          `${entry.testFilePath} exists but contains no test titled "${entry.testTitle}". It may have been renamed.`,
        );
      } else if (resolved.warning === 'ambiguous-test-title') {
        warn(
          'ambiguous-test-title',
          tmsCase.caseId,
          `${entry.testFilePath} holds ${byFile.get(entry.testFilePath)?.length} tests and the link records no testTitle. Not guessed.`,
        );
      }
    }

    let suppression: SuppressionState | null = null;
    if (entry) {
      const quarantined = findQuarantine(input.quarantine, entry.testFilePath, entry.testTitle);
      if (quarantined) {
        suppression = { kind: 'quarantined', since: quarantined.quarantinedAt };
      } else if (analysis && (analysis.isSkipped || analysis.isFixme)) {
        const key = testKey(analysis.filePath, analysis.title);
        const since = suppressedSince[key];
        if (since === undefined) {
          warn(
            'suppression-date-unknown',
            tmsCase.caseId,
            'Statically suppressed, but the start date is not recorded. Report the duration as unknown, not as zero.',
          );
        }
        suppression = {
          kind: analysis.isSkipped ? 'skipped' : 'fixme',
          since: since ?? null,
        };
      }
    }

    const executionInput = executionByCaseId.get(tmsCase.caseId);
    if (!executionInput) {
      warn(
        'no-execution-history',
        tmsCase.caseId,
        'No run history from the test management tool. Counted as never executed.',
      );
    }

    const riskBand = input.riskBands[tmsCase.caseId];
    if (riskBand === undefined) {
      warn(
        'risk-band-not-configured',
        tmsCase.caseId,
        `No risk band configured; using "${DEFAULT_RISK_BAND}". Risk is configured per project, never inferred.`,
      );
    }

    if (analysis) analysisByCaseId[tmsCase.caseId] = analysis;

    records.push({
      caseId: tmsCase.caseId,
      title: tmsCase.title,
      riskBand: riskBand ?? DEFAULT_RISK_BAND,
      assertion: analysis ? analysis.assertion : NO_AUTOMATION_ASSERTION_STATE,
      suppression,
      // SyncState and TraceabilityState share the same six names; UNLINKED is the seventh state,
      // for a case the manifest has never heard of, which SyncState has no way to express.
      traceability: (entry ? entry.syncState : 'UNLINKED') as TraceabilityState,
      duplicateOfCaseIds: duplicates.get(tmsCase.caseId) ?? [],
      execution: executionInput
        ? {
            totalRuns: executionInput.totalRuns,
            failedRuns: executionInput.failedRuns,
            lastRunAt: executionInput.lastRunAt,
          }
        : { totalRuns: 0, failedRuns: 0, lastRunAt: null },
    });
  }

  return { records, warnings, analysisByCaseId };
}

/**
 * Tests that exist in the spec files but are linked to no case at all.
 *
 * Not part of the per-case join, because there is no case to attach them to - but they are a real
 * finding: automation nobody is counting, which no coverage figure will ever mention.
 */
export function findUnlinkedTests(
  specs: SpecFile[],
  traceability: TraceabilityEntry[],
): TestAssertionAnalysis[] {
  const linked = new Set<string>();
  const whollyClaimedFiles = new Set<string>();
  for (const entry of traceability) {
    if (entry.testTitle === undefined) {
      // A link with no testTitle predates multi-test-per-file support and claims the whole file.
      whollyClaimedFiles.add(entry.testFilePath);
    } else {
      linked.add(testKey(entry.testFilePath, entry.testTitle));
    }
  }

  return analyseSpecFiles(specs).filter((analysis) => {
    if (whollyClaimedFiles.has(analysis.filePath)) return false;
    return !linked.has(testKey(analysis.filePath, analysis.title));
  });
}
