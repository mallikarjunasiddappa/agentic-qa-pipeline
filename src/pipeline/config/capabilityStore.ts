import fs from 'node:fs';
import path from 'node:path';
import { TenantCapabilities, TenantCapabilitiesSchema, TenantStageCapabilities } from '../types/schemas';
import { getTenantId } from './tenantContext';

/**
 * Admin-provisioned per-tenant config, not pipeline-generated state - deliberately outside
 * data/<tenantId>/ (which is exclusively stage output: manifest.json, quarantine.json,
 * telemetry.jsonl, etc.), same category as the repo-root policy.json. Kept as a function (not a
 * top-level const) for the same reason every tenant-scoped path in this pipeline is - it must not
 * evaluate before setTenantId() has run.
 *
 * Nested under config/tenants/<tenantId>/ (not the old flat config/tenants/<tenantId>.json) so a
 * second per-tenant admin-config file has somewhere to live without a path-scheme change - see
 * ScrumConfigSchema's doc comment in schemas.ts for the decision this migration completes, and
 * scrumConfigStore.ts's SCRUM_CONFIG_PATH() for the sibling file this now sits alongside.
 */
export function CAPABILITIES_PATH(): string {
  return path.join('config', 'tenants', getTenantId(), 'capabilities.json');
}

/**
 * Every flag on, no TMS/notification provider chosen - the exact behavior this pipeline had
 * before capabilities.json existed. Returned as-is when a tenant has no config/tenants/<id>.json
 * file at all, so "default" and every existing single-tenant setup keeps working with zero
 * provisioning - this is an opt-OUT model for narrower plans, not an opt-in lockdown a tenant
 * must configure their way out of.
 */
function fullAccessDefaults(tenantId: string): TenantCapabilities {
  return TenantCapabilitiesSchema.parse({ tenantId });
}

/**
 * Loads and validates config/tenants/<tenantId>.json. Missing file -> fullAccessDefaults(), not a
 * thrown error (contrast policyStore.ts's loadPolicy(), which fails loud on a missing file since
 * an absent policy.json means guardrails would silently pass everything - a real safety
 * regression. A missing capabilities.json instead means "this tenant hasn't been given a
 * narrower plan yet," which is a normal, safe starting state, not a misconfiguration).
 *
 * A tenantId inside the file that doesn't match the tenant this path was resolved for (path
 * segment vs. the file's own declared tenantId) throws - almost always a copy-paste mistake when
 * provisioning a new tenant from an existing one's file, and silently applying the wrong tenant's
 * capabilities would be exactly the kind of quiet failure this whole gating exists to prevent.
 */
export function loadCapabilities(capabilitiesPath: string = CAPABILITIES_PATH()): TenantCapabilities {
  const tenantId = getTenantId();
  if (!fs.existsSync(capabilitiesPath)) {
    return fullAccessDefaults(tenantId);
  }
  const raw = JSON.parse(fs.readFileSync(capabilitiesPath, 'utf-8'));
  const parsed = TenantCapabilitiesSchema.parse(raw);
  if (parsed.tenantId !== tenantId) {
    throw new Error(
      `${capabilitiesPath} declares tenantId "${parsed.tenantId}" but was loaded for tenant ` +
        `"${tenantId}" - this almost always means the file was copy-pasted from another tenant's ` +
        'config without updating its tenantId field. Fix the file (or its path) before continuing ' +
        "rather than risk applying the wrong tenant's capabilities.",
    );
  }
  return parsed;
}

/**
 * Maps every real --stage value (pipeline.ts's switch) to the TenantStageCapabilities key that
 * gates it. `null` means "not tenant-gateable" - the CI guardrail-check stages run identically
 * for every tenant regardless of plan, so they're deliberately excluded rather than mapped to a
 * capability that would let a narrower plan silently skip policy enforcement.
 *
 * Kept exhaustive on purpose (every case label in pipeline.ts's switch has an entry, verified by
 * capabilityStore.test.ts against the real stage list) so a newly added --stage can't slip through
 * ungated by omission - forgetting to add an entry here is a test failure, not a silent gap.
 */
export const STAGE_CAPABILITY_MAP: Record<string, keyof TenantStageCapabilities | null> = {
  jira: 'scenarioGeneration',
  'excel-write': 'scenarioGeneration',
  'excel-read': 'scenarioGeneration',
  'flag-requirement-gaps': 'scenarioGeneration',
  // Gate 0's headless-agent-cost path (headlessJudge.ts) - same requirement-clarity judgment as
  // flag-requirement-gaps above, just backed by a real Anthropic API call instead of a
  // hand-written --gaps-file, so it's gated behind the same scenarioGeneration capability rather
  // than a new one. Missing from this map since PR #103 first added the stage - caught by
  // capabilityStore.test.ts's own exhaustiveness check (STAGE_CAPABILITY_MAP has an entry for
  // every real --stage value in pipeline.ts), which was failing on master until this entry landed.
  'flag-requirement-gaps-headless': 'scenarioGeneration',
  'approve-requirements': 'scenarioGeneration',
  'approve-scenarios': 'scenarioGeneration',
  'approve-test-cases': 'scenarioGeneration',

  'tms-upload': 'tmsUpload',
  'qase-upload': 'tmsUpload',
  'tms-submit-result': 'tmsUpload',
  'qase-submit-result': 'tmsUpload',

  'traceability-record': 'traceability',
  'traceability-update-baseline': 'traceability',
  'traceability-link': 'traceability',
  'traceability-accept-baseline': 'traceability',
  'traceability-unlink': 'traceability',
  'rename-spec-file': 'traceability',
  'drift-check': 'traceability',

  'healing-record': 'healing',
  'healing-report': 'healing',

  'flaky-record': 'flakyManagement',
  'flaky-clear': 'flakyManagement',
  'flaky-report': 'flakyManagement',

  'cost-marker': 'costAccounting',
  'cost-record': 'costAccounting',
  'cost-report': 'costAccounting',

  'pipeline-report': 'reporting',
  'prompt-version-report': 'reporting',
  'ticket-summary': 'reporting',

  // suite-health (suiteHealth/): read-only aggregation over the traceability manifest, the TMS
  // (case titles + run history), quarantine state and generated spec files - it produces a report,
  // it does not gate the pipeline. Same 'reporting' precedent as pipeline-report/scrum-dashboard/
  // coverage-report/ask above (a read-only view over data other, independently-gated stages already
  // produce), not a feature-plan toggle of its own.
  'suite-health': 'reporting',

  'jira-transitions': 'jiraWorkflowActions',
  'jira-transition': 'jiraWorkflowActions',

  // Manual-Tester Agent (persona exploration + ticket-driven verification) - all six stages gated
  // by the single manualTesting flag (see TenantStageCapabilitiesSchema). Both modes drive the live
  // app and write to Jira behind a human gate, so they share one per-duty flag rather than one each.
  'ticket-verify': 'manualTesting',
  'ticket-verify-approve': 'manualTesting',
  'ticket-verify-comment': 'manualTesting',
  'dogfood-run': 'manualTesting',
  'dogfood-approve': 'manualTesting',
  'dogfood-file': 'manualTesting',
  'promote': 'manualTesting',

  // Scrum Master Automation Program stages (Phase 1) - added ahead of the stages themselves
  // existing in pipeline.ts's --stage switch. This is safe: capabilityStore.test.ts's
  // exhaustiveness check only asserts every real pipeline.ts case has a map entry, not the
  // reverse, so a map entry with no case yet does not fail that test. See
  // TenantStageCapabilitiesSchema's scrumCeremony/scrumDevStatus fields (schemas.ts) for why this
  // is two flags, not one.
  'sprint-status': 'scrumCeremony',
  'standup-digest': 'scrumCeremony',

  'dev-status': 'scrumDevStatus',

  // blocker-scan (Phase 2) - its own flag, not scrumCeremony, since it's the first
  // scrum-master-agent stage that writes anything (Jira comments, Slack messages) rather than
  // pure reporting/DM delivery - see TenantStageCapabilitiesSchema's scrumBlockerScan comment.
  'blocker-scan': 'scrumBlockerScan',

  // backlog-groom-check (Phase 2, second and final duty) - its own flag too, not scrumBlockerScan
  // or scrumCeremony, per the same per-duty-gets-its-own-gate precedent. Both halves (fetch and
  // flag) share one flag - there is no third stage to map, since the actual judgment is a live
  // agent-session step, not a deterministic --stage - see groomCheck.ts's own header comment.
  'groom-check-fetch': 'scrumGroomCheck',
  'groom-check-flag': 'scrumGroomCheck',

  // burndown-report (Phase 3, first duty) - its own flag too, same per-duty-gets-its-own-gate
  // precedent as blocker-scan/backlog-groom-check above - see TenantStageCapabilitiesSchema's
  // scrumBurndown comment.
  'burndown-report': 'scrumBurndown',

  // retro-notes (Phase 3, second and final duty) - its own flag too, same per-duty-gets-its-own-
  // gate precedent as blocker-scan/backlog-groom-check/burndown-report above. Both halves (fetch
  // and post) share one flag, same "no third stage to map" reasoning as groom-check-fetch/-flag -
  // the actual retrospective synthesis is a live agent-session step, not a deterministic --stage -
  // see retroNotes.ts's own header comment and TenantStageCapabilitiesSchema's scrumRetro comment.
  'retro-notes-fetch': 'scrumRetro',
  'retro-notes-post': 'scrumRetro',

  // draft-story (Phase C, "AI-Assisted Scrum and SDLC Console - Development Plan," docs/planning/)
  // - its own flag (storyDrafting), not scenarioGeneration, per the same per-duty-gets-its-own-gate
  // precedent as every scrum duty above - see TenantStageCapabilitiesSchema's storyDrafting
  // comment.
  'draft-story': 'storyDrafting',

  // draft-sprint-plan (Sprint plan, velocity half - Phase C's other half of the same dev plan) -
  // its own flag (sprintPlanning), same per-duty-gate precedent as draft-story above - see
  // TenantStageCapabilitiesSchema's sprintPlanning comment.
  'draft-sprint-plan': 'sprintPlanning',

  // release-summary (Phase E, "Release Stage" - read-only, deliberately the most conservative
  // stage in this program) - its own flag (releaseSummary), same per-duty-gate precedent as every
  // scrum/AI-Queue duty above - see TenantStageCapabilitiesSchema's releaseSummary comment.
  'release-summary': 'releaseSummary',

  // Dashboard v1, PR 1: read-only static HTML views over the five scrum reports above. Gated by
  // the existing 'reporting' flag, not a new scrum-specific one - same precedent as
  // 'pipeline-report' below, which aggregates cost/healing/flaky/traceability/promptVersions
  // without requiring all of THEIR flags to be on either. A tenant with e.g. scrumBurndown off
  // still gets a dashboard - it just shows that section as not generated yet, same honesty-over-
  // guessing convention scrumDashboard.ts's own header comment documents.
  'scrum-dashboard': 'reporting',

  // coverage-report: user-stories/test coverage (traceability manifest) + development coverage
  // (dev-status/retro-notes' VCS correlation) per active sprint. Same 'reporting' precedent as
  // scrum-dashboard immediately above - this is a read-only aggregation over data other,
  // independently-gated stages (traceability-record, dev-status) already produce, not a new
  // feature-plan toggle of its own. See coverageReport.ts's own header comment for the full
  // reasoning behind what this report actually measures.
  'coverage-report': 'reporting',

  // --stage ask (askEngine.ts): plain-language question in, classifies which existing report(s)
  // it's about, reads already-written report.json files read-only (no re-fetch, no side effects),
  // narrates an answer. Same 'reporting' precedent as scrum-dashboard/coverage-report above - a
  // read-only view over data other, independently-gated stages already produce, not a feature-plan
  // toggle of its own. Missing from this map since the stage was first added - caught by this same
  // exhaustiveness test alongside the pre-existing flag-requirement-gaps-headless gap above.
  'ask': 'reporting',

  // Dashboard v1, PR 2: the workflow_dispatch Settings panel's --stage settings-update
  // (pipeline.ts). Deliberately `null`, not a new capability flag: this is an admin
  // config-maintenance action (fix a tenant's own scrum.json), not a tenant feature-plan toggle -
  // gating it behind a capability that itself lives in a sibling admin config file would be
  // circular, and a tenant should be able to have e.g. storyPointsField corrected regardless of
  // which other scrum features are currently enabled for them. Access control for v1 is GitHub's
  // own repo-permission model (must have write access to trigger the workflow at all) rather than
  // an in-app capability - see settings-update.yml's own header comment.
  'settings-update': null,

  // CI guardrail checks - universal policy enforcement, not tenant-gateable. See this module's
  // doc comment and TenantStageCapabilitiesSchema's for why these are excluded on purpose.
  'assertion-check': null,
  'locator-check': null,
  'traceability-coverage-check': null,
  'manifest-provenance-check': null,
  'spec-file-consolidation-check': null,
  'secrets-check': null,
  'forbidden-playwright-patterns-check': null,
  'required-tags-check': null,
  'scenario-quality-check': null,
  // Local dev convenience aggregator (pipeline.ts's verify-guardrails-locally case) - runs the 8
  // checks above in-process, same universal-not-tenant-gateable reasoning as each of them.
  'verify-guardrails-locally': null,
};

/**
 * Called once per CLI invocation, right after setTenantId() and before the --stage switch runs
 * (main(), pipeline.ts) - same "gate before any stage handler runs" placement as tenant
 * resolution itself. A stage missing from STAGE_CAPABILITY_MAP is treated as ungated (allowed),
 * not blocked - an unmapped stage is a map-maintenance gap for capabilityStore.test.ts to catch,
 * not something an end user's CLI invocation should fail on.
 */
export function assertStageAllowed(stage: string, capabilities: TenantCapabilities = loadCapabilities()): void {
  const capabilityKey = STAGE_CAPABILITY_MAP[stage];
  if (capabilityKey === null || capabilityKey === undefined) return;
  if (!capabilities.stages[capabilityKey]) {
    throw new Error(
      `--stage ${stage} is disabled for tenant "${capabilities.tenantId}" (capability ` +
        `"${capabilityKey}" is off in ${CAPABILITIES_PATH()}). Enable it there if this tenant's ` +
        'plan should include it.',
    );
  }
}

/**
 * Which TMS provider this tenant is configured for - config/tenants/<id>.json's
 * integrations.tms.provider, falling back to the given env-level default (TMS_PROVIDER) for a
 * tenant with no capabilities.json yet, so getTestManagementClient() (testmgmt/index.ts) keeps
 * working unchanged for every tenant that hasn't been provisioned with one.
 */
export function resolveTmsProvider(envProviderFallback: string, capabilities: TenantCapabilities = loadCapabilities()): string {
  return capabilities.integrations.tms.provider ?? envProviderFallback;
}

/**
 * Which secrets backend this tenant's credentials resolve through - config/tenants/<id>.json's
 * integrations.secrets.provider (the Secrets-manager fix, per-tenant credential isolation - see
 * secretsProvider.ts's SecretsProvider interface, env.ts's resolveTenantEnv()/requireTenantEnv()).
 * Defaults to 'env-file' for every tenant that hasn't opted into a real secrets manager yet,
 * including one with no capabilities.json at all.
 *
 * Unlike resolveTmsProvider() above, there's no separate env-var fallback to thread through here -
 * 'env-file' IS the fallback, baked directly into SecretsIntegrationSchema's own default rather
 * than supplied by the caller, since (unlike TMS_PROVIDER) there was never a pre-capabilities.json
 * env var for "which secrets backend" whose compatibility this needs to preserve.
 */
export function resolveSecretsProvider(capabilities: TenantCapabilities = loadCapabilities()): string {
  return capabilities.integrations.secrets.provider;
}
