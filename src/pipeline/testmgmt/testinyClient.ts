import axios, { AxiosInstance } from 'axios';
import { requireTenantEnv } from '../config/env';
import { Scenario, ScenarioWithCaseId, ScenarioWithCaseIdSchema } from '../types/schemas';
import { TmsCreateCaseOptions } from './types';
import { findOrCreateSuiteId, resolveSuiteId, QaseSuiteRef } from './suiteResolver';

// Testiny's canonical result vocabulary (per its REST API docs' "Set a test result" example) is a
// clean superset match for our TmsResultStatus - no lossy translation needed the way Qase's extra
// 'invalid' status requires (see types.ts's own doc comment on that). Just uppercased.
export type TestinyResultStatus = 'PASSED' | 'FAILED' | 'BLOCKED' | 'SKIPPED';
const RESULT_STATUS_TO_TESTINY: Record<string, TestinyResultStatus> = {
  passed: 'PASSED',
  failed: 'FAILED',
  blocked: 'BLOCKED',
  skipped: 'SKIPPED',
};

// Testiny's REST API docs (testiny.io/docs/api-quickstart) don't publicly document a numeric
// priority scale the way Qase's severity field is documented, and the "Working with Test Cases"
// page never lists "priority" among a test case's built-in fields at all - the api-quickstart
// example body's `"priority": 3` may be illustrative rather than a stable documented contract.
// Rather than guess a 4-level-to-N-level mapping and risk silently filing cases at the wrong
// priority, this adapter deliberately omits `priority` from the create payload for now. Revisit
// once scripts/verify-testiny-tms.ts's live run confirms (by reading a created case back) whether
// the field exists, what values it accepts, and how many levels it actually has.

interface TestinyCaseCreateResponse {
  id: number;
  title: string;
  project_id: number;
  precondition_text: string | null;
  steps_text: string | null;
  expected_result_text: string | null;
  updated_at?: string;
  [key: string]: unknown;
}

// Per the REST API docs' "Create multiple new 'TestCase' entities" page: "Returns a list of new
// ids only" - unconfirmed whether that's raw numbers or {id} objects until verified live. Coded
// defensively to accept either shape (see bulkUploadScenarios below) rather than assume one.
type TestinyBulkCreateResponse = Array<number | { id: number }>;

export interface TestinyCaseStep {
  action: string;
  expectedResult?: string;
}

export interface TestinyCaseDetail {
  id: number;
  title: string;
  description: string | null;
  preconditions: string | null;
  steps: TestinyCaseStep[];
  updatedAt?: string;
}

export interface TestinyFolderListItem {
  id: number;
  title: string;
  // Real field name confirmed live (KAN-10) via a raw JSON dump of /testcase-folder/find's
  // response - NOT "parent_id" (that name doesn't exist in the response at all; TypeScript let it
  // through as `undefined` on every folder without complaint, no error, no warning, so the bug hid
  // silently until this diagnosis). Testiny also uses 0 as its "no parent" sentinel, not null -
  // both are normalized to `parentId: number | null` at the listFolderRefs() boundary below so
  // suiteResolver.ts's null-means-top-level contract still holds.
  testcase_folder_parent_id: number;
}

/**
 * Turns Scenario.steps (an array of plain action strings, same source data as Qase's
 * toQaseSteps) into Testiny's flat steps_text/expected_result_text fields - Testiny's default
 * "Text template" has no per-step structure the way Qase's steps array does (see the Steps
 * template vs. Text template distinction in Testiny's docs), so every step is joined into one
 * numbered block instead. expectedResult is attached once, at the end, same "whole-scenario
 * outcome" placement toQaseSteps uses for its last step's expected_result.
 */
export function toTestinyStepsText(steps: string[]): string {
  return steps.map((action, index) => `${index + 1}. ${action}`).join('\n');
}

export class TestinyClient {
  private http: AxiosInstance;
  private projectId: number;
  private currentRunId: number | null = null;
  // Same caching contract as QaseClient's suiteCache - findOrCreateSuiteId/resolveSuiteId
  // (suiteResolver.ts) are already provider-agnostic pure logic, reused here unchanged.
  private folderCache = new Map<string, number>();

  private constructor(apiKey: string, projectId: number) {
    this.projectId = projectId;
    this.http = axios.create({
      baseURL: 'https://app.testiny.io/api/v1',
      headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' },
    });
  }

  static async create(): Promise<TestinyClient> {
    const apiKey = await requireTenantEnv('TESTINY_API_KEY', 'Testiny Agent');
    const projectIdRaw = await requireTenantEnv('TESTINY_PROJECT_ID', 'Testiny Agent');
    const projectId = Number(projectIdRaw);
    if (!Number.isFinite(projectId)) {
      throw new Error(
        `TESTINY_PROJECT_ID must be a numeric project id, got "${projectIdRaw}" - find the real one ` +
          'in the Testiny UI project settings (not the project name or a slug).',
      );
    }
    return new TestinyClient(apiKey, projectId);
  }

  async getCase(caseId: number): Promise<TestinyCaseDetail> {
    const { data } = await this.http.get<TestinyCaseCreateResponse>(`/testcase/${caseId}`);
    return {
      id: data.id,
      title: data.title,
      description: data.expected_result_text ?? null,
      preconditions: data.precondition_text ?? null,
      // Testiny's steps_text is one flat field, not a structured array - returned as a single
      // pseudo-step so getCase()'s shape still satisfies TmsCaseDetail.steps without inventing
      // per-step boundaries Testiny itself doesn't track for the Text template.
      steps: data.steps_text ? [{ action: data.steps_text }] : [],
      updatedAt: data.updated_at,
    };
  }

  async listFolders(): Promise<TestinyFolderListItem[]> {
    // Real route is "/testcase-folder/find" - HYPHEN, confirmed straight from Testiny's own docs
    // page for this exact route (docs/rest-api/find-test-case-folder-entities-using-the-specified-
    // body-parameters, which literally prints "POST /testcase-folder/find"). Two earlier guesses
    // were both wrong and both produced real, live 404s: "/testcasefolder/find" (no separator) and
    // "/testcase_folder/find" (underscore - that's the JSON field/mapping name convention used
    // inside payloads, e.g. "testcase_folder_id" below, not the URL path convention, which uses a
    // hyphen instead - an easy mix-up since Testiny uses both conventions in different places).
    const { data } = await this.http.post<{ data: TestinyFolderListItem[] }>('/testcase-folder/find', {
      filter: { project_id: this.projectId },
      pagination: { limit: 500 },
    });
    return data.data;
  }

  private async createFolderHttp(title: string, parentId: number | null): Promise<number> {
    // "testcase_folder_parent_id", not "parent_id" - confirmed live (KAN-10): the old "parent_id"
    // key was silently dropped by Testiny (unknown field, no error), so every "sub-folder" this
    // pipeline ever created actually landed top-level with no parent at all. 0 is Testiny's own
    // sentinel for "no parent", sent explicitly here (not omitted) so a create call is never
    // ambiguous between "root" and "field not sent".
    const { data } = await this.http.post<{ id: number }>('/testcase-folder', {
      project_id: this.projectId,
      title,
      testcase_folder_parent_id: parentId ?? 0,
    });
    return data.id;
  }

  private async listFolderRefs(): Promise<QaseSuiteRef[]> {
    const folders = await this.listFolders();
    return folders.map((f) => ({
      id: f.id,
      title: f.title,
      parentId: f.testcase_folder_parent_id === 0 ? null : f.testcase_folder_parent_id,
    }));
  }

  async findOrCreateFolder(title: string, parentId: number | null): Promise<number> {
    return findOrCreateSuiteId(
      title,
      parentId,
      this.folderCache,
      () => this.listFolderRefs(),
      (t, p) => this.createFolderHttp(t, p),
    );
  }

  async resolveFolderId(topLevelTitle?: string, subTitle?: string): Promise<number | undefined> {
    return resolveSuiteId(
      topLevelTitle,
      subTitle,
      this.folderCache,
      () => this.listFolderRefs(),
      (t, p) => this.createFolderHttp(t, p),
    );
  }

  /**
   * Files a case into a folder. This is NOT a plain field settable at case-creation time -
   * confirmed live (KAN-10): the folder was created correctly and `testcase_folder_id` was
   * included in the /testcase create payload exactly as this file used to do, but the case landed
   * in "no folder" anyway, silently ignored rather than erroring. Testiny's own docs confirm why:
   * folder membership is a real mapping relationship with its own dedicated route
   * (docs/rest-api/add-remove-update-mappings-between-test-case-folder-entities-and-other-entities,
   * "POST /testcase-folder/mapping/bulk/:otherEntities") - the exact same pattern the quickstart
   * docs already show for testcase-to-testrun membership (`/testrun/mapping/bulk/testcase:testrun
   * ?op=add`), which is why suiteResolver.ts's "provider-agnostic" folder logic still needed a
   * real, Testiny-specific write step here that Qase's suite_id-as-a-plain-field model doesn't.
   */
  private async mapCasesToFolders(mappings: { caseId: number; folderId: number }[]): Promise<void> {
    if (mappings.length === 0) return;
    // The base route uses a hyphen ("/testcase-folder/..."), confirmed by the earlier 404 fix, but
    // the ":otherEntities" path segment is a different kind of value (an internal entity
    // identifier, not a URL resource slug) and Testiny rejected the hyphenated form here with
    // "API_INVALID_INPUT: One or more entity names are invalid" - confirmed live. Underscore here
    // instead, matching the identifier form used everywhere else (testcase_folder_id, etc.).
    await this.http.post(
      '/testcase-folder/mapping/bulk/testcase:testcase_folder?op=add_or_update',
      mappings.map((m) => ({ ids: { testcase_id: m.caseId, testcase_folder_id: m.folderId } })),
    );
  }

  async createCase(scenario: Scenario, options?: TmsCreateCaseOptions): Promise<ScenarioWithCaseId> {
    const folderId = await this.resolveFolderId(options?.suiteTitle, scenario.suite);
    const { data } = await this.http.post<TestinyCaseCreateResponse>('/testcase', {
      project_id: this.projectId,
      title: scenario.title,
      template: 'TEXT',
      precondition_text: scenario.preconditions,
      steps_text: toTestinyStepsText(scenario.steps),
      expected_result_text: scenario.expectedResult,
    });
    if (folderId !== undefined) {
      await this.mapCasesToFolders([{ caseId: data.id, folderId }]);
    }
    return ScenarioWithCaseIdSchema.parse({ ...scenario, externalCaseId: String(data.id) });
  }

  async bulkUploadScenarios(
    scenarios: Scenario[],
    options?: TmsCreateCaseOptions,
  ): Promise<ScenarioWithCaseId[]> {
    const folderIdByGroup = new Map<string, number | undefined>();
    for (const scenario of scenarios) {
      const key = scenario.suite ?? '';
      if (!folderIdByGroup.has(key)) {
        folderIdByGroup.set(key, await this.resolveFolderId(options?.suiteTitle, scenario.suite));
      }
    }

    const { data } = await this.http.post<TestinyBulkCreateResponse>(
      '/testcase/bulk',
      scenarios.map((scenario) => ({
        project_id: this.projectId,
        title: scenario.title,
        template: 'TEXT',
        precondition_text: scenario.preconditions,
        steps_text: toTestinyStepsText(scenario.steps),
        expected_result_text: scenario.expectedResult,
      })),
    );
    const results = scenarios.map((scenario, index) => {
      const entry = data[index];
      const id = typeof entry === 'number' ? entry : entry.id;
      return { scenario, id };
    });
    const mappings = results
      .map(({ scenario, id }) => {
        const folderId = folderIdByGroup.get(scenario.suite ?? '');
        return folderId !== undefined ? { caseId: id, folderId } : null;
      })
      .filter((m): m is { caseId: number; folderId: number } => m !== null);
    await this.mapCasesToFolders(mappings);
    return results.map(({ scenario, id }) => ScenarioWithCaseIdSchema.parse({ ...scenario, externalCaseId: String(id) }));
  }

  async createRun(caseIds: number[], title = `Automated run ${new Date().toISOString()}`): Promise<number> {
    const { data } = await this.http.post<{ id: number }>('/testrun', {
      project_id: this.projectId,
      title,
    });
    this.currentRunId = data.id;
    if (caseIds.length > 0) {
      // op=add_or_update, not plain op=add - per the REST API docs' own "Add a test case to a
      // test run" example: whenever a `mapped` payload (here, the initial result_status) is set
      // alongside the mapping, the documented op is add_or_update. A real live run against
      // op=add returned a 400 - this fix is confirmed against that failure, not just the docs.
      // assigned_to is required on this mapping - undocumented in the REST API quickstart's
      // simplified examples, only surfaced by a real 400 (API_INVALID_INPUT_DATA: "assigned_to
      // must be one of the following values: USER, OWNER, ANY"). 'ANY' is the closest match to
      // this pipeline's existing "don't force an assignee" convention (Qase's runs are created
      // with no per-case assignment either) - USER would additionally require assigned_user_id,
      // OWNER ties it to the case's own owner field, neither of which this adapter tracks today.
      await this.http.post(
        `/testrun/mapping/bulk/testcase:testrun?op=add_or_update`,
        caseIds.map((caseId) => ({
          ids: { testcase_id: caseId, testrun_id: this.currentRunId },
          mapped: { result_status: 'NOTRUN', assigned_to: 'ANY' },
        })),
      );
    }
    return this.currentRunId;
  }

  setActiveRun(runId: number): void {
    this.currentRunId = runId;
  }

  async submitResult(params: { caseId: number; status: TestinyResultStatus; comment?: string }): Promise<void> {
    if (this.currentRunId === null) {
      throw new Error(
        'No active Testiny run. Call createRun(caseIds) or setActiveRun(runId) before submitResult().',
      );
    }
    // Same required assigned_to field as createRun()'s initial mapping above - included here too
    // since submitResult() can be called against a case that was never added via createRun() (a
    // caller that only did setActiveRun(runId)), so this can't assume the mapping already exists
    // with assigned_to set.
    await this.http.post(
      `/testrun/mapping/bulk/testcase:testrun?op=add_or_update`,
      [
        {
          ids: { testcase_id: params.caseId, testrun_id: this.currentRunId },
          mapped: { result_status: params.status, assigned_to: 'ANY' },
        },
      ],
    );
    if (params.comment) {
      const { data: comments } = await this.http.post<Array<{ id: number }>>('/comment/bulk', [
        { project_id: this.projectId, type: 'TEXT', text: params.comment },
      ]);
      const commentId = comments[0]?.id;
      if (commentId !== undefined) {
        await this.http.post(`/comment/mapping/bulk/comment:testcase:testrun?op=add`, [
          { ids: { comment_id: commentId, testcase_id: params.caseId, testrun_id: this.currentRunId } },
        ]);
      }
    }
  }
}

export function toTestinyResultStatus(status: string): TestinyResultStatus {
  const mapped = RESULT_STATUS_TO_TESTINY[status];
  if (!mapped) {
    throw new Error(`Unknown TmsResultStatus "${status}" - no Testiny equivalent defined.`);
  }
  return mapped;
}

let client: TestinyClient | null = null;
export async function getTestinyClient(): Promise<TestinyClient> {
  if (!client) client = await TestinyClient.create();
  return client;
}
