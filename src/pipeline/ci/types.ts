// Provider-agnostic CI interface. Grounded in the 8 real guardrail-check names pipeline.ts's own
// 'verify-guardrails-locally' stage already uses (src/pipeline/orchestrator/pipeline.ts's `checks`
// array) - same strings, not a re-invented naming scheme, so a GuardrailCheckResult's `name` always
// matches what a human already sees in that stage's own console output and in each
// .github/workflows/*.yml's top-level `name:` field.

export type GuardrailCheckName =
  | 'Assertion Integrity Check'
  | 'Forbidden Playwright Patterns Check'
  | 'Locator Priority Check'
  | 'Manifest Provenance Check'
  | 'Required Test Tags Check'
  | 'Traceability Coverage Check'
  | 'Spec File Consolidation Check'
  | 'Secrets Guardrail';

export interface GuardrailCheckResult {
  name: GuardrailCheckName;
  passed: boolean;
  report: string;
}

export type CommitStatusState = 'pending' | 'success' | 'failure' | 'error';

/**
 * Provider-agnostic surface every CI adapter implements. Only GithubCIProvider exists today
 * (this repo has one CI provider, GitHub Actions) - kept as an interface for the same reason
 * RequirementsSource/TestRunner are, despite one real implementation each.
 */
export interface CIProvider {
  // Runs all 8 required guardrail checks in-process against a base SHA - literally the same
  // check functions pipeline.ts's 'verify-guardrails-locally' stage already calls (see
  // guardrailRunner.ts), exposed as one interface method instead of only a CLI stage.
  runGuardrailChecks(baseSha: string): Promise<GuardrailCheckResult[]>;
  // Reports one check's result back to the CI provider's own commit-status API.
  //
  // NOT YET CONFIRMED to resolve AGENTS.md's documented "stuck at Expected - Waiting for status
  // to be reported" issue - that's logged as a GitHub-side flakiness in receiving statuses from
  // the Actions-triggered path specifically, an untested hypothesis. This method's request/response
  // handling is real and correct (GitHub's Statuses API), but whether the `name` strings above
  // match this repo's actual configured required-check context strings in Settings -> Rules has
  // NOT been verified against live GitHub (no network egress from this environment - see AGENTS.md's
  // third known-issue entry). Confirm that mapping for real before relying on this to replace the
  // manual bypass-merge workaround.
  reportCheckStatus(commitSha: string, result: GuardrailCheckResult): Promise<void>;
}
