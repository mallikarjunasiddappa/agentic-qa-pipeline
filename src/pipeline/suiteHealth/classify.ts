/**
 * Suite health classification - decides what a single test case is currently PROTECTING, and what
 * to do about it.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT A "RELEVANCE" CHECK: the obvious way to prune a bloated suite
 * is to compare each case against the currently active user stories and recommend the unmatched
 * ones for deletion. That is wrong in a specific and dangerous way. A regression test maps to no
 * active story PRECISELY BECAUSE that code has not changed - a refund edge case written three years
 * ago matches nothing in this sprint, not because it is obsolete, but because nobody has touched
 * refunds. It is the test that catches you when somebody finally does. Delete it on a relevance
 * score and the failure is silent and delayed: nobody notices for eighteen months, and by then the
 * connection back to the deletion is gone. "Relevance" also has no ground truth to check an answer
 * against, so it cannot be tested. "Is this protecting anything" can.
 *
 * PURE BY DESIGN: no filesystem, no network, no TMS client, no clock. Everything this needs arrives
 * in a SuiteCaseRecord assembled by collectSignals.ts, and `now` is a parameter - same convention as
 * blockerScan's computeIdleDays(). That is what makes the seven verdicts testable without standing
 * up Qase.
 *
 * NO DELETE, ANYWHERE: RecommendedAction deliberately has no 'remove' or 'delete' member, so the
 * type system enforces it rather than a code review. The failure mode of a deletion recommendation
 * is silent and delayed; the failure mode of a review recommendation is that somebody ignores it.
 * Those are not comparable, and one of them is recoverable.
 */

export type CaseVerdict =
  | 'PROTECTING_NOTHING'
  | 'SUPPRESSED'
  | 'ORPHANED'
  | 'STALE'
  | 'DUPLICATE'
  | 'COLD_BUT_LOAD_BEARING'
  | 'HEALTHY';

/**
 * What a person should do. Note what is absent: nothing here deletes anything. Even 'consolidate'
 * means merge-then-archive. Archiving is reversible; deletion is not, and this report is advice
 * built from static signals, not a verified judgement about a running product.
 */
export type RecommendedAction =
  | 'fix-assertion'
  | 'unquarantine-or-accept-gap'
  | 'verify-then-archive'
  | 'review-against-requirement'
  | 'consolidate'
  | 'keep'
  | 'none';

export type RiskBand = 'high' | 'medium' | 'low';

/** The six states the traceability agent already produces, plus never-linked. */
export type TraceabilityState =
  | 'IN_SYNC'
  | 'CASE_DRIFTED'
  | 'TEST_DRIFTED'
  | 'BOTH_DRIFTED'
  | 'ORPHANED_CASE'
  | 'ORPHANED_TEST'
  | 'UNLINKED';

/**
 * Mapped from assertionGuard's output at the collectSignals boundary rather than imported, so this
 * module stays decoupled from that module's internal shape. `hasAutomation: false` is NOT the same
 * as `cannotFail: true` - a manual-only case has no assertion to weaken and must never be reported
 * as a placebo.
 */
export interface AssertionState {
  hasAutomation: boolean;
  cannotFail: boolean;
  /** From assertionGuard, e.g. 'no-assertion' | 'always-true-matcher' | 'asserts-the-mock'. */
  cannotFailReason?: string;
}

export interface SuppressionState {
  kind: 'quarantined' | 'skipped' | 'fixme';
  /**
   * ISO date the suppression started, or null when it is not recorded anywhere.
   *
   * The DURATION is the finding, not the fact - "uncovered since April" is the sentence that
   * lands, and "suppressed" on its own is not. Nullable because that date genuinely may not
   * exist: quarantine records its own `quarantinedAt`, but a `test.skip` written by hand records
   * nothing, and only git history knows when it appeared. Making this non-nullable would force a
   * caller to invent a date, and an invented date reads exactly like a measured one once it is a
   * number in a column.
   */
  since: string | null;
}

export interface ExecutionHistory {
  totalRuns: number;
  failedRuns: number;
  /** ISO timestamp, or null when the case has never been executed at all. */
  lastRunAt: string | null;
}

export interface SuiteCaseRecord {
  caseId: string;
  title: string;
  riskBand: RiskBand;
  assertion: AssertionState;
  /** null when the case is not suppressed. */
  suppression: SuppressionState | null;
  traceability: TraceabilityState;
  /** Case ids this substantially duplicates, from scenarioQualityRules' overlap detection. */
  duplicateOfCaseIds: string[];
  execution: ExecutionHistory;
}

export interface VerdictReason {
  code: string;
  message: string;
}

export interface CaseHealth {
  caseId: string;
  verdict: CaseVerdict;
  action: RecommendedAction;
  /** EVERY signal that matched, not just the one that decided the verdict. A verdict without its
   *  evidence is an opinion, and a reader who disagrees needs to see what we saw. */
  reasons: VerdictReason[];
}

/**
 * A case has to have run a meaningful number of times before "never failed" means anything. Twenty
 * is a judgement call, not a discovered constant: below it, "never failed" usually just means "new",
 * and reporting a three-run case as suspiciously stable would train people to ignore the report.
 */
export const COLD_MINIMUM_RUNS = 20;

/**
 * Suppression beyond this is reported with its duration in the headline. A test quarantined for two
 * days is normal maintenance; one quarantined for four months means everybody has believed that path
 * was covered for four months and it was not.
 */
export const SUPPRESSION_ALARM_DAYS = 30;

/**
 * Calendar days between an ISO date and `now`, floored. Calendar rather than business days, for the
 * same reason blockerScan chose calendar: business-day maths needs a weekend definition, a timezone
 * and probably a holiday calendar, none of which this report has or needs. A negative result (a
 * future date - clock skew, or a fixture) is returned as-is rather than clamped, so it can never
 * silently satisfy a positive threshold.
 */
export function daysSince(isoDate: string, now: Date): number {
  const then = new Date(isoDate).getTime();
  if (Number.isNaN(then)) {
    throw new Error(`daysSince: "${isoDate}" is not a parseable date`);
  }
  return Math.floor((now.getTime() - then) / (1000 * 60 * 60 * 24));
}

/** Never executed, ever. Distinct from "ran and never failed" - see classifyCase's precedence note. */
function neverExecuted(execution: ExecutionHistory): boolean {
  return execution.totalRuns === 0 || execution.lastRunAt === null;
}

/**
 * Has run enough times to draw a conclusion from, and has never once failed. On its own this is not
 * a problem - it is only interesting combined with what the assertion can do.
 */
function ranOftenAndNeverFailed(execution: ExecutionHistory): boolean {
  return execution.totalRuns >= COLD_MINIMUM_RUNS && execution.failedRuns === 0;
}

/**
 * Classifies one case.
 *
 * PRECEDENCE, and why this order: a case commonly matches several signals at once, but a report
 * needs one action per row or nobody acts on it. Every matched signal still appears in `reasons`.
 *
 *  1. PROTECTING_NOTHING - an assertion that cannot fail is worse than every other state here,
 *     because the test RUNS, goes green, and appears in the coverage report. It is producing active
 *     false confidence in CI. Nothing further matters until that is fixed.
 *  2. SUPPRESSED - provides no coverage right now. Second rather than first because a quarantined
 *     test at least appears on a quarantine list somewhere; a passing placebo appears nowhere.
 *  3. ORPHANED - the requirement is gone, so there is nothing to judge the case against.
 *  4. STALE - the requirement moved after the test was written. The test still passes, against last
 *     quarter's behaviour. This is the case a relevance-based tool misclassifies most often, because
 *     a drifted test still LOOKS related to an active story.
 *  5. DUPLICATE - real waste, but it is waste with coverage. Ranks below anything that means the
 *     coverage is absent.
 *  6. COLD_BUT_LOAD_BEARING - the deliberate answer to "no active story mentions it, so remove it".
 *     Reached only when the assertion has already been confirmed capable of failing, which is what
 *     separates good regression coverage from a placebo.
 *  7. HEALTHY.
 */
export function classifyCase(record: SuiteCaseRecord, now: Date): CaseHealth {
  const reasons: VerdictReason[] = [];

  if (record.assertion.hasAutomation && record.assertion.cannotFail) {
    reasons.push({
      code: 'assertion-cannot-fail',
      message: record.assertion.cannotFailReason
        ? `The assertion can never fail (${record.assertion.cannotFailReason}).`
        : 'The assertion can never fail.',
    });
  }

  if (record.suppression) {
    const { kind, since } = record.suppression;
    reasons.push({
      code: `suppressed-${kind}`,
      message:
        since === null
          ? `${kind}, start date not recorded, so the duration is unknown - not zero. ` +
            'It is still counted as covered.'
          : `${kind} since ${since} (${daysSince(since, now)} days). It is still counted as covered.`,
    });
  }

  if (record.traceability === 'ORPHANED_CASE' || record.traceability === 'ORPHANED_TEST') {
    reasons.push({
      code: 'traceability-orphaned',
      message: `Traceability state is ${record.traceability} - the artefact it paired with is gone.`,
    });
  }

  if (
    record.traceability === 'CASE_DRIFTED' ||
    record.traceability === 'TEST_DRIFTED' ||
    record.traceability === 'BOTH_DRIFTED'
  ) {
    reasons.push({
      code: 'traceability-drifted',
      message: `Traceability state is ${record.traceability} - it changed after the baseline was approved.`,
    });
  }

  if (record.duplicateOfCaseIds.length > 0) {
    reasons.push({
      code: 'duplicate-coverage',
      message: `Substantially duplicates ${record.duplicateOfCaseIds.join(', ')}.`,
    });
  }

  if (neverExecuted(record.execution)) {
    reasons.push({
      code: 'never-executed',
      message: 'Has never been executed. It contributes nothing to any coverage figure.',
    });
  } else if (ranOftenAndNeverFailed(record.execution)) {
    reasons.push({
      code: 'never-failed',
      message: `Ran ${record.execution.totalRuns} times and never failed.`,
    });
  }

  // --- precedence, see the header comment above ---

  if (record.assertion.hasAutomation && record.assertion.cannotFail) {
    return { caseId: record.caseId, verdict: 'PROTECTING_NOTHING', action: 'fix-assertion', reasons };
  }

  if (record.suppression) {
    return {
      caseId: record.caseId,
      verdict: 'SUPPRESSED',
      action: 'unquarantine-or-accept-gap',
      reasons,
    };
  }

  // A case that has never run AND has no automation is indistinguishable from an abandoned one.
  // A case that has never run but DOES have automation is a suppression we have not detected yet -
  // the suite is not executing it - so it is reported as suppressed rather than orphaned, because
  // the action is different: find out why it is not running, do not archive it.
  if (neverExecuted(record.execution) && !record.assertion.hasAutomation) {
    reasons.push({
      code: 'never-run-no-automation',
      message: 'Never executed and no automation is linked.',
    });
    return { caseId: record.caseId, verdict: 'ORPHANED', action: 'verify-then-archive', reasons };
  }

  if (neverExecuted(record.execution) && record.assertion.hasAutomation) {
    reasons.push({
      code: 'automated-but-never-run',
      message: 'Automation exists but the suite has never executed it.',
    });
    return {
      caseId: record.caseId,
      verdict: 'SUPPRESSED',
      action: 'unquarantine-or-accept-gap',
      reasons,
    };
  }

  if (record.traceability === 'ORPHANED_CASE' || record.traceability === 'ORPHANED_TEST') {
    return { caseId: record.caseId, verdict: 'ORPHANED', action: 'verify-then-archive', reasons };
  }

  if (
    record.traceability === 'CASE_DRIFTED' ||
    record.traceability === 'TEST_DRIFTED' ||
    record.traceability === 'BOTH_DRIFTED'
  ) {
    return {
      caseId: record.caseId,
      verdict: 'STALE',
      action: 'review-against-requirement',
      reasons,
    };
  }

  if (record.duplicateOfCaseIds.length > 0) {
    return { caseId: record.caseId, verdict: 'DUPLICATE', action: 'consolidate', reasons };
  }

  // Reached only once the assertion is known to be capable of failing. That is the whole difference
  // between "excellent regression coverage nobody has needed yet" and "a placebo", and it is why
  // this verdict can safely recommend KEEP on a case no active story mentions.
  if (ranOftenAndNeverFailed(record.execution) && record.riskBand === 'high') {
    reasons.push({
      code: 'cold-but-load-bearing',
      message:
        'Never failed, but the assertion is capable of failing and this covers a high-risk area. ' +
        'This is regression coverage, not dead weight.',
    });
    return { caseId: record.caseId, verdict: 'COLD_BUT_LOAD_BEARING', action: 'keep', reasons };
  }

  return { caseId: record.caseId, verdict: 'HEALTHY', action: 'none', reasons };
}

export interface SuiteHealthSummary {
  total: number;
  byVerdict: Record<CaseVerdict, number>;
  /** The two headline findings - see the Suite Health spec, section 5. */
  protectingNothingRunCount: number;
  longestSuppressionDays: number;
}

/**
 * Rolls a classified suite up into the numbers that go at the top of the report.
 *
 * protectingNothingRunCount is deliberately a count of EXECUTIONS, not of cases: "14 tests, 4,200
 * executions, zero possible failures" lands in a way "14 tests" does not, because it puts a cost on
 * the placebo as well as a risk.
 */
export function summariseSuiteHealth(
  results: CaseHealth[],
  records: SuiteCaseRecord[],
  now: Date,
): SuiteHealthSummary {
  const byId = new Map(records.map((record) => [record.caseId, record]));

  const byVerdict: Record<CaseVerdict, number> = {
    PROTECTING_NOTHING: 0,
    SUPPRESSED: 0,
    ORPHANED: 0,
    STALE: 0,
    DUPLICATE: 0,
    COLD_BUT_LOAD_BEARING: 0,
    HEALTHY: 0,
  };

  let protectingNothingRunCount = 0;
  let longestSuppressionDays = 0;

  for (const result of results) {
    byVerdict[result.verdict] += 1;
    const record = byId.get(result.caseId);
    if (!record) continue;

    if (result.verdict === 'PROTECTING_NOTHING') {
      protectingNothingRunCount += record.execution.totalRuns;
    }
    // An unknown start date is skipped rather than counted as zero. It might be the oldest
    // suppression in the suite; claiming otherwise would understate the headline.
    if (record.suppression && record.suppression.since !== null) {
      longestSuppressionDays = Math.max(longestSuppressionDays, daysSince(record.suppression.since, now));
    }
  }

  return {
    total: results.length,
    byVerdict,
    protectingNothingRunCount,
    longestSuppressionDays,
  };
}
