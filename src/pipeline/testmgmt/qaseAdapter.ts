import { QaseClient, QaseCaseDetail, QaseResultStatus, aggregateExecutions } from './qaseClient';
import { Scenario, ScenarioWithCaseId } from '../types/schemas';
import { CaseExecution, TestManagementClient, TmsCaseDetail, TmsResultStatus, TmsCreateCaseOptions } from './types';

function toTmsCaseDetail(caseDetail: QaseCaseDetail): TmsCaseDetail {
  return {
    id: String(caseDetail.id),
    title: caseDetail.title,
    description: caseDetail.description,
    preconditions: caseDetail.preconditions,
    steps: caseDetail.steps.map((step) => ({
      action: step.action,
      expectedResult: step.expected_result,
    })),
    updatedAt: caseDetail.updated_at,
  };
}

/**
 * Wraps the existing QaseClient (axios logic, severity mapping, and Qase status handling all stay
 * inside QaseClient, unchanged) behind the provider-agnostic TestManagementClient interface.
 * Qase's numeric case/run ids are converted to/from strings here, at the adapter boundary only -
 * QaseClient itself keeps using its native numbers internally, and already returns
 * ScenarioWithCaseId with a stringified externalCaseId (see ScenarioWithCaseIdSchema), so
 * createCase/bulkCreateCases pass its result straight through.
 */
export class QaseAdapter implements TestManagementClient {
  constructor(private readonly client: QaseClient) {}

  async getCase(caseId: string): Promise<TmsCaseDetail> {
    const caseDetail = await this.client.getCase(Number(caseId));
    return toTmsCaseDetail(caseDetail);
  }

  async getCaseExecutions(caseId: string): Promise<CaseExecution> {
    const entities = await this.client.getCaseExecutions(Number(caseId));
    return { caseId, ...aggregateExecutions(entities) };
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
      status: params.status as QaseResultStatus,
      comment: params.comment,
    });
  }

  async moveCaseToSuite(caseId: string, topLevelTitle: string, subTitle?: string): Promise<void> {
    const suiteId = await this.client.resolveSuiteId(topLevelTitle, subTitle);
    if (suiteId === undefined) return;
    await this.client.updateCaseSuite(Number(caseId), suiteId);
  }

  async moveSuiteUnderParent(suiteTitle: string, newParentTitle: string): Promise<void> {
    const existing = await this.client.findSuiteByTitle(suiteTitle);
    if (!existing) {
      throw new Error(
        `No suite titled "${suiteTitle}" exists in Qase - nothing to re-parent. Check the exact ` +
          'title (case-sensitive) in the Qase UI.',
      );
    }
    // Top-level only (no subTitle) - the new parent itself always resolves/creates as a root
    // suite, same as any other top-level suite this pipeline manages.
    const parentId = await this.client.resolveSuiteId(newParentTitle);
    if (parentId === undefined) return;
    await this.client.updateSuiteParent(existing.id, parentId);
  }
}
