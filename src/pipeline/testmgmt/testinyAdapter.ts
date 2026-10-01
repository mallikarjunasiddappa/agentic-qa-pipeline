import { TestinyClient, TestinyCaseDetail, toTestinyResultStatus } from './testinyClient';
import { Scenario, ScenarioWithCaseId } from '../types/schemas';
import { TestManagementClient, TmsCaseDetail, TmsResultStatus, TmsCreateCaseOptions } from './types';

function toTmsCaseDetail(caseDetail: TestinyCaseDetail): TmsCaseDetail {
  return {
    id: String(caseDetail.id),
    title: caseDetail.title,
    description: caseDetail.description,
    preconditions: caseDetail.preconditions,
    steps: caseDetail.steps.map((step) => ({
      action: step.action,
      expectedResult: step.expectedResult,
    })),
    updatedAt: caseDetail.updatedAt,
  };
}

/**
 * Wraps TestinyClient behind the provider-agnostic TestManagementClient interface - same role
 * QaseAdapter plays for QaseClient. Testiny's numeric case/run/folder ids are converted to/from
 * strings here, at the adapter boundary only, same "native numbers stay internal to the client"
 * contract as QaseAdapter.
 *
 * This class, plus the 'testiny' case added to testmgmt/index.ts's getTestManagementClient()
 * switch, are the ONLY two places anything outside src/pipeline/testmgmt/ had to change to add a
 * second real TMS provider - that's the actual Phase 0 genericity proof: TestManagementClient
 * (types.ts), suiteResolver.ts's pure find-or-create logic, and every caller of
 * getTestManagementClient() across the rest of the pipeline needed zero changes.
 */
export class TestinyAdapter implements TestManagementClient {
  constructor(private readonly client: TestinyClient) {}

  async getCase(caseId: string): Promise<TmsCaseDetail> {
    const caseDetail = await this.client.getCase(Number(caseId));
    return toTmsCaseDetail(caseDetail);
  }

  async createCase(scenario: Scenario, options?: TmsCreateCaseOptions): Promise<ScenarioWithCaseId> {
    return this.client.createCase(scenario, options);
  }

  async bulkCreateCases(scenarios: Scenario[], options?: TmsCreateCaseOptions): Promise<ScenarioWithCaseId[]> {
    return this.client.bulkUploadScenarios(scenarios, options);
  }

  async createRun(caseIds: string[], title?: string): Promise<string> {
    const runId = await this.client.createRun(caseIds.map(Number), title);
    return String(runId);
  }

  setActiveRun(runId: string): void {
    this.client.setActiveRun(Number(runId));
  }

  async submitResult(params: { caseId: string; status: TmsResultStatus; comment?: string }): Promise<void> {
    await this.client.submitResult({
      caseId: Number(params.caseId),
      status: toTestinyResultStatus(params.status),
      comment: params.comment,
    });
  }

  // moveCaseToSuite/moveSuiteUnderParent (both optional on TestManagementClient) are deliberately
  // NOT implemented yet: Testiny's generic "Update one entity" PUT route requires a conflict-tag
  // `_etag` in the request body (fetched from a prior read) unless the update is explicitly forced
  // - see the REST API quickstart's "Conflict tag `_etag`" section - and that hasn't been verified
  // live yet. scripts/migrateCasesToSuites.ts and scripts/moveSuiteUnderParent.ts both already
  // check for these methods' presence and skip cleanly (not error) when absent, same contract a
  // provider with no folder concept at all would get - so this is safe to leave unimplemented
  // until the etag-conflict-tag mechanics are confirmed against the real API, rather than ship an
  // update call likely to fail with "Conflict tag is enabled for this entity but missing".
}
