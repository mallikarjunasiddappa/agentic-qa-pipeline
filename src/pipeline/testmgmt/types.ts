import { Scenario, ScenarioWithCaseId } from '../types/schemas';

// Qase's real vocabulary also has 'invalid' (the test case itself is broken, not the app under
// test). That doesn't map cleanly onto other providers, so the canonical type drops it - the
// Qase adapter's caller is responsible for translating 'invalid' into 'blocked' (+ a comment
// note) before it reaches this type. See the deprecated --qase-submit-result path in pipeline.ts.
export type TmsResultStatus = 'passed' | 'failed' | 'blocked' | 'skipped';

export interface TmsCaseStep {
  action: string;
  expectedResult?: string;
}

export interface TmsCaseDetail {
  id: string;
  title: string;
  description: string | null;
  preconditions: string | null;
  steps: TmsCaseStep[];
  updatedAt?: string;
}

export interface TmsRunCase {
  id: string;
  title: string;
  externalCaseId: string;
}

export interface TmsRunRecord {
  provider: string;
  // Which Jira ticket this run belongs to - also encoded in the run file's own name
  // (output/tms-run-<key>.json, see buildRunFilePath in pipeline.ts) so each ticket's run/case
  // mapping is independently addressable instead of every --stage tms-upload overwriting one
  // shared output/tms-run.json. Kept here too so the record is self-describing on its own.
  jiraKey: string;
  runId: string;
  cases: TmsRunCase[];
}

export interface TmsCreateCaseOptions {
  // The top-level Suite title a case should be filed under - typically the source Jira ticket's
  // summary (see stageTmsUpload in pipeline.ts). Omitted entirely (not just falsy) when a caller
  // has no ticket context, so the case is created with no suite at all rather than a guessed one.
  // A provider with no suite/folder concept is free to just ignore this.
  suiteTitle?: string;
}

/**
 * Provider-agnostic surface every test management adapter implements. Case/run ids are strings
 * throughout - not every provider uses numeric ids the way Qase does - with any provider-native
 * numeric id converted to/from string at that provider's own adapter boundary only.
 */
/**
 * Per-case execution history. Signal 6 of Suite Health's `collectSignals` (see
 * suiteHealth/collectSignals.ts's CaseExecutionInput, which this maps onto 1:1). No store in this
 * repo records how many times a case has run, so it is read from the provider. Optional on the
 * interface below, same skip-not-error contract as moveCaseToSuite: a provider with no run-history
 * concept simply doesn't implement it, and the caller passes execution=[] instead.
 */
export interface CaseExecution {
  caseId: string;
  totalRuns: number;
  failedRuns: number;
  /** ISO timestamp of the most recent result, or null if the case has never run. */
  lastRunAt: string | null;
}

export interface TestManagementClient {
  getCase(caseId: string): Promise<TmsCaseDetail>;
  createCase(scenario: Scenario, options?: TmsCreateCaseOptions): Promise<ScenarioWithCaseId>;
  bulkCreateCases(scenarios: Scenario[], options?: TmsCreateCaseOptions): Promise<ScenarioWithCaseId[]>;
  createRun(caseIds: string[], title?: string): Promise<string>;
  setActiveRun(runId: string): void;
  submitResult(params: { caseId: string; status: TmsResultStatus; comment?: string }): Promise<void>;
  // Optional: per-case run history (total/failed/last-run), used by the suite-health report's
  // execution signal. A provider with no results API simply doesn't implement it - the caller
  // (stageSuiteHealth in pipeline.ts) checks for its presence and passes execution=[] when absent,
  // same skip-not-error contract as moveCaseToSuite/moveSuiteUnderParent below.
  getCaseExecutions?(caseId: string): Promise<CaseExecution>;
  // Optional: retroactively files an already-existing case into Suite (topLevelTitle) > Sub-suite
  // (subTitle, omit for top-level-only). Used by scripts/migrateCasesToSuites.ts to backfill cases
  // created before suite support existed. A provider with no suite/folder concept simply doesn't
  // implement this - the migration script checks for its presence and skips (rather than errors)
  // when it's absent, so adding a new provider never requires touching that script.
  moveCaseToSuite?(caseId: string, topLevelTitle: string, subTitle?: string): Promise<void>;
  // Optional: re-parents an *already-existing* suite (found by exact title match) under a
  // different top-level suite (found-or-created by title) - a one-time reorg operation, distinct
  // from moveCaseToSuite above (which moves a case, not a whole suite). Used by
  // scripts/moveSuiteUnderParent.ts. Throws if `suiteTitle` doesn't already exist - unlike a
  // case's target suite, silently creating an empty suite just because the name was typo'd would
  // leave a confusing empty suite behind with no obvious cause. A provider with no suite/folder
  // concept simply doesn't implement this, same skip-not-error contract as moveCaseToSuite.
  moveSuiteUnderParent?(suiteTitle: string, newParentTitle: string): Promise<void>;
}
