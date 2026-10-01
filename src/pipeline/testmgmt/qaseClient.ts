import axios, { AxiosInstance } from 'axios';
import { requireTenantEnv } from '../config/env';
import { Scenario, ScenarioWithCaseId, ScenarioWithCaseIdSchema } from '../types/schemas';
import { TmsCreateCaseOptions } from './types';
import { findOrCreateSuiteId, resolveSuiteId, QaseSuiteRef } from './suiteResolver';

const PRIORITY_TO_QASE_SEVERITY: Record<Scenario['priority'], number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export type QaseResultStatus = 'passed' | 'failed' | 'blocked' | 'skipped' | 'invalid';

interface QaseCaseCreateResponse {
  result: { id: number };
}
interface QaseBulkCreateResponse {
  result: { ids: number[] };
}
interface QaseRunCreateResponse {
  result: { id: number };
}

export interface QaseCaseStep {
  action: string;
  expected_result?: string;
}

export interface QaseCaseDetail {
  id: number;
  title: string;
  description: string | null;
  preconditions: string | null;
  steps: QaseCaseStep[];
  // Not documented as a stable field on every Qase plan/endpoint version; callers should fall
  // back to "now" when absent rather than treat it as required.
  updated_at?: string;
}

interface QaseCaseGetResponse {
  result: QaseCaseDetail;
}

// One entry from Qase's results list (GET /result/{code}). Only the two fields the execution
// signal needs are typed; the endpoint returns many more. status is Qase's own result status
// vocabulary (passed/failed/blocked/skipped/invalid); end_time is an ISO-ish timestamp string,
// absent/null for a result that never completed.
export interface QaseResultEntity {
  status: string;
  end_time?: string | null;
}
interface QaseResultListResponse {
  result: { entities?: QaseResultEntity[] };
}

export interface QaseSuiteListItem {
  id: number;
  title: string;
  parent_id: number | null;
}
interface QaseSuiteListResponse {
  result: { entities: QaseSuiteListItem[] };
}
interface QaseSuiteCreateResponse {
  result: { id: number };
}

// Scenario.expectedResult is one combined string for the whole scenario (joined from every
// spec "- expect:" line - see specParser.ts), not one per step, so there's no per-step
// expected_result to send for steps 1..n-1. It's attached to the *last* step only - "after
// completing all steps, this is the outcome" is how the spec's expect: lines are already
// written, and it's the field Qase's UI actually surfaces as each step's Expected Result
// (previously this was silently never sent at all - only scenario.expectedResult's copy in the
// case-level `description` field was populated, which isn't the same column reviewers check).
// Exported (only) for qaseClient.test.ts - the rest of this file is a thin axios wrapper with no
// existing unit-test pattern in this codebase (see recordBaseline.test.ts's fakeTms() for how TMS
// logic is tested instead: against the provider-agnostic TestManagementClient interface, not this
// Qase-specific HTTP class) - this one function is pure payload-shaping, so it's worth testing
// directly rather than only through a live smoke test.
export function toQaseSteps(steps: string[], expectedResult: string) {
  return steps.map((action, index) => ({
    position: index + 1,
    action,
    ...(index === steps.length - 1 ? { expected_result: expectedResult } : {}),
  }));
}

// Pure: folds a case's raw Qase result entities into the totals the suite-health execution signal
// needs. Exported (only) for qaseClient.test.ts - the HTTP fetch around it is the untestable part,
// this fold is not. "failed" is the single Qase status that counts as a failure here; blocked/
// skipped/invalid are real outcomes but not test-detected regressions, so they are runs-not-fails.
export function aggregateExecutions(entities: QaseResultEntity[]): {
  totalRuns: number;
  failedRuns: number;
  lastRunAt: string | null;
} {
  let failedRuns = 0;
  let lastRunAt: string | null = null;
  for (const entity of entities) {
    if (entity.status === 'failed') failedRuns += 1;
    const t = entity.end_time ?? null;
    // String compare is safe: ISO-8601 timestamps sort lexicographically the same as chronologically.
    if (t !== null && (lastRunAt === null || t > lastRunAt)) lastRunAt = t;
  }
  return { totalRuns: entities.length, failedRuns, lastRunAt };
}

export class QaseClient {
  private http: AxiosInstance;
  private projectCode: string;
  private currentRunId: number | null = null;
  // Keyed by `${parentId ?? 'root'}::${title}` - avoids re-listing/re-creating the same suite for
  // every scenario in a batch that shares a sub-suite, and across repeated calls within one
  // process (e.g. bulkUploadScenarios resolving several groups back to back).
  private suiteCache = new Map<string, number>();

  // Constructor is now private - credentials must be resolved async (requireTenantEnv is async
  // since the Secrets-manager fix), so construction goes through the static async create()
  // factory below instead of `new QaseClient()`.
  private constructor(token: string, projectCode: string) {
    this.projectCode = projectCode;
    this.http = axios.create({
      baseURL: 'https://api.qase.io/v1',
      headers: { Token: token, 'Content-Type': 'application/json' },
    });

    // The free single-user Qase account has a strict rate limit; a batch stage like suite-health
    // (getCase + getCaseExecutions per case) trips it and returns 429. Retry 429s with backoff,
    // honouring Retry-After when present, so a rate limit slows a run down instead of failing it.
    // Only 429 is retried - every other error still surfaces immediately. Bounded to 5 attempts so
    // a persistent limit eventually errors rather than hanging forever.
    this.http.interceptors.response.use(undefined, async (error: any) => {
      if (error?.response?.status === 429 && error.config) {
        const attempt = (error.config.__retry ?? 0) + 1;
        if (attempt <= 5) {
          error.config.__retry = attempt;
          const retryAfter = Number(error.response.headers?.['retry-after']);
          const delayMs =
            Number.isFinite(retryAfter) && retryAfter > 0
              ? retryAfter * 1000
              : Math.min(1000 * 2 ** attempt, 15000);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          return this.http(error.config);
        }
      }
      return Promise.reject(error);
    });
  }

  static async create(): Promise<QaseClient> {
    const token = await requireTenantEnv('QASE_API_TOKEN', 'Qase Agent');
    const projectCode = await requireTenantEnv('QASE_PROJECT_CODE', 'Qase Agent');
    return new QaseClient(token, projectCode);
  }

  async getCase(caseId: number): Promise<QaseCaseDetail> {
    const { data } = await this.http.get<QaseCaseGetResponse>(`/case/${this.projectCode}/${caseId}`);
    return data.result;
  }

  // Fetches every result recorded for one case, paging through Qase's 100-per-page results list.
  // Aggregation is left to the pure aggregateExecutions() above; this method only owns the HTTP +
  // pagination. The offset cap is a safety stop against an unexpectedly unbounded pager, matching
  // listSuites' "fine for the scale this single-project setup realistically has" stance.
  async getCaseExecutions(caseId: number): Promise<QaseResultEntity[]> {
    const all: QaseResultEntity[] = [];
    const limit = 100;
    for (let offset = 0; offset <= 10000; offset += limit) {
      const { data } = await this.http.get<QaseResultListResponse>(`/result/${this.projectCode}`, {
        params: { case_id: caseId, limit, offset },
      });
      const entities = data.result.entities ?? [];
      all.push(...entities);
      if (entities.length < limit) break;
    }
    return all;
  }

  // No pagination handling - fine for the suite counts a single-project TMS setup like this one
  // realistically has today; revisit if a project ever grows past 100 suites.
  async listSuites(): Promise<QaseSuiteListItem[]> {
    const { data } = await this.http.get<QaseSuiteListResponse>(`/suite/${this.projectCode}`, {
      params: { limit: 100 },
    });
    return data.result.entities;
  }

  private async createSuiteHttp(title: string, parentId: number | null): Promise<number> {
    const { data } = await this.http.post<QaseSuiteCreateResponse>(`/suite/${this.projectCode}`, {
      title,
      ...(parentId !== null ? { parent_id: parentId } : {}),
    });
    return data.result.id;
  }

  private async listSuiteRefs(): Promise<QaseSuiteRef[]> {
    const suites = await this.listSuites();
    return suites.map((s) => ({ id: s.id, title: s.title, parentId: s.parent_id ?? null }));
  }

  /**
   * Finds an existing suite by exact title + parent match, or creates one. `parentId: null` means
   * a top-level suite. Delegates the actual find-or-create decision to suiteResolver.ts (pure,
   * unit-tested there) - this method just supplies the real HTTP calls and owns the cache.
   */
  async findOrCreateSuite(title: string, parentId: number | null): Promise<number> {
    return findOrCreateSuiteId(
      title,
      parentId,
      this.suiteCache,
      () => this.listSuiteRefs(),
      (t, p) => this.createSuiteHttp(t, p),
    );
  }

  /**
   * Resolves the suite_id a case should be filed under - see suiteResolver.ts's resolveSuiteId for
   * the actual (pure, unit-tested) logic. `topLevelTitle` alone resolves/creates one root suite;
   * `topLevelTitle` + `subTitle` nests a child suite under it instead.
   */
  async resolveSuiteId(topLevelTitle?: string, subTitle?: string): Promise<number | undefined> {
    return resolveSuiteId(
      topLevelTitle,
      subTitle,
      this.suiteCache,
      () => this.listSuiteRefs(),
      (t, p) => this.createSuiteHttp(t, p),
    );
  }

  // Used by the one-off scripts/migrateCasesToSuites.ts to retroactively file pre-existing cases
  // (created before suite support existed) into the same Suite > Sub-suite structure.
  async updateCaseSuite(caseId: number, suiteId: number): Promise<void> {
    await this.http.patch(`/case/${this.projectCode}/${caseId}`, { suite_id: suiteId });
  }

  // Used by the one-off scripts/moveSuiteUnderParent.ts to re-parent an already-existing suite -
  // a distinct operation from findOrCreateSuite/createSuiteHttp above, which only ever create a
  // *new* suite, never change an existing one's parent.
  async updateSuiteParent(suiteId: number, parentId: number): Promise<void> {
    await this.http.patch(`/suite/${this.projectCode}/${suiteId}`, { parent_id: parentId });
  }

  // Exact title match only (case-sensitive) - deliberately not fuzzy, since silently matching the
  // wrong suite when re-parenting it would be a confusing, hard-to-notice mistake. Returns
  // undefined if none match; throws if more than one does, rather than picking the first - Qase
  // doesn't enforce unique suite titles, so a genuine collision is possible and should be a loud
  // error, not a silent guess.
  async findSuiteByTitle(title: string): Promise<QaseSuiteListItem | undefined> {
    const suites = await this.listSuites();
    const matches = suites.filter((s) => s.title === title);
    if (matches.length > 1) {
      throw new Error(
        `More than one suite titled "${title}" exists (ids: ${matches.map((s) => s.id).join(', ')}) - ` +
          'resolve the ambiguity in Qase directly rather than guessing which one was meant.',
      );
    }
    return matches[0];
  }

  async createCase(scenario: Scenario, options?: TmsCreateCaseOptions): Promise<ScenarioWithCaseId> {
    const suiteId = await this.resolveSuiteId(options?.suiteTitle, scenario.suite);
    const { data } = await this.http.post<QaseCaseCreateResponse>(`/case/${this.projectCode}`, {
      title: scenario.title,
      preconditions: scenario.preconditions,
      severity: PRIORITY_TO_QASE_SEVERITY[scenario.priority],
      steps: toQaseSteps(scenario.steps, scenario.expectedResult),
      description: scenario.expectedResult,
      ...(suiteId !== undefined ? { suite_id: suiteId } : {}),
    });
    return ScenarioWithCaseIdSchema.parse({ ...scenario, externalCaseId: String(data.result.id) });
  }

  async bulkUploadScenarios(
    scenarios: Scenario[],
    options?: TmsCreateCaseOptions,
  ): Promise<ScenarioWithCaseId[]> {
    // Resolve one suite_id per distinct sub-suite group up front (each resolution is itself
    // cached in suiteCache/findOrCreateSuite) rather than inline per-scenario below, so the bulk
    // payload construction stays a simple synchronous map.
    const suiteIdByGroup = new Map<string, number | undefined>();
    for (const scenario of scenarios) {
      const key = scenario.suite ?? '';
      if (!suiteIdByGroup.has(key)) {
        suiteIdByGroup.set(key, await this.resolveSuiteId(options?.suiteTitle, scenario.suite));
      }
    }

    const { data } = await this.http.post<QaseBulkCreateResponse>(
      `/case/${this.projectCode}/bulk`,
      {
        cases: scenarios.map((scenario) => {
          const suiteId = suiteIdByGroup.get(scenario.suite ?? '');
          return {
            title: scenario.title,
            preconditions: scenario.preconditions,
            severity: PRIORITY_TO_QASE_SEVERITY[scenario.priority],
            steps: toQaseSteps(scenario.steps, scenario.expectedResult),
            description: scenario.expectedResult,
            ...(suiteId !== undefined ? { suite_id: suiteId } : {}),
          };
        }),
      },
    );
    return scenarios.map((scenario, index) =>
      ScenarioWithCaseIdSchema.parse({ ...scenario, externalCaseId: String(data.result.ids[index]) }),
    );
  }

  async completeActiveRuns(): Promise<void> {
    try {
      const { data } = await this.http.get<{ result?: { entities?: Array<{ id: number }> } }>(
        `/run/${this.projectCode}?status=active&limit=100`,
      );
      if (data?.result?.entities) {
        for (const run of data.result.entities) {
          await this.http.post(`/run/${this.projectCode}/${run.id}/complete`).catch(() => {});
        }
      }
    } catch {
      // Ignore if auto-completing active runs fails
    }
  }

  async createRun(caseIds: number[], title = `Automated run ${new Date().toISOString()}`): Promise<number> {
    await this.completeActiveRuns();
    const { data } = await this.http.post<QaseRunCreateResponse>(`/run/${this.projectCode}`, {
      title,
      cases: caseIds,
    });
    this.currentRunId = data.result.id;
    return this.currentRunId;
  }

  // Lets a later process resume submitting results against a run created by an earlier one
  // (createRun's return value / the run id persisted by the caller), since currentRunId only
  // lives in memory for the process that called createRun().
  setActiveRun(runId: number): void {
    this.currentRunId = runId;
  }

  async submitResult(params: { caseId: number; status: QaseResultStatus; comment?: string }): Promise<void> {
    if (this.currentRunId === null) {
      throw new Error(
        'No active Qase run. Call createRun(caseIds) or setActiveRun(runId) before submitResult().',
      );
    }
    await this.http.post(`/result/${this.projectCode}/${this.currentRunId}`, {
      case_id: params.caseId,
      status: params.status,
      comment: params.comment,
    });
  }
}

let client: QaseClient | null = null;
export async function getQaseClient(): Promise<QaseClient> {
  if (!client) client = await QaseClient.create();
  return client;
}
