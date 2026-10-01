import { z } from 'zod';

export const PrioritySchema = z.enum(['low', 'medium', 'high', 'critical']);
export type Priority = z.infer<typeof PrioritySchema>;

export const ScenarioSchema = z.object({
  id: z.string(),
  title: z.string(),
  preconditions: z.string(),
  steps: z.array(z.string()).min(1),
  expectedResult: z.string(),
  priority: PrioritySchema,
  // Only populated when parsed from a specs/<feature>.plan.md's **File:** line (specParser.ts).
  // Absent for scenarios round-tripped through the Excel sign-off sheet, which has no such column.
  testFilePath: z.string().optional(),
  // The spec's "### N. <group name>" heading this scenario was generated under (specParser.ts) -
  // e.g. "Student Login", "My Subscriptions". Maps onto a TMS sub-suite (qaseClient.ts) so cases
  // land in Suite (the Jira ticket) > Sub-suite (this) > Case, instead of one flat list. Optional:
  // absent for a scenario with no enclosing group heading, or one round-tripped through an older
  // sign-off sheet written before the Suite column existed.
  suite: z.string().optional(),
  // Short, human-facing test-case id shown in the Excel sign-off sheet during Gate 1/2 review -
  // e.g. "KAN3-01" - assigned sequentially per Jira ticket by excelWriter.ts's assignDisplayIds().
  // Distinct from `id` (the kebab-case slug), which keeps driving file naming and traceability
  // unchanged; this field exists purely so a human reviewer isn't staring at
  // "should-open-my-profile-from-account-menu" as their only "ID" column. Not sent to the TMS -
  // once uploaded, the provider's own case id (externalCaseId) is the real, permanent identifier.
  // Optional: absent for scenarios that never went through stageExcelWrite (e.g. direct
  // --spec upload with no sign-off sheet, or older round-tripped sheets from before this existed).
  displayId: z.string().optional(),
});
export type Scenario = z.infer<typeof ScenarioSchema>;

export const ScenarioArraySchema = z.array(ScenarioSchema);

export const ScenarioWithCaseIdSchema = ScenarioSchema.extend({
  externalCaseId: z.string(),
});
export type ScenarioWithCaseId = z.infer<typeof ScenarioWithCaseIdSchema>;

export const JiraIssueSummarySchema = z.object({
  key: z.string(),
  summary: z.string(),
  description: z.string(),
});
export type JiraIssueSummary = z.infer<typeof JiraIssueSummarySchema>;

export const BugReportSchema = z.object({
  summary: z.string(),
  description: z.string(),
  labels: z.array(z.string()).default([]),
});
export type BugReport = z.infer<typeof BugReportSchema>;

export const SyncStateSchema = z.enum([
  'IN_SYNC',
  'CASE_DRIFTED',
  'TEST_DRIFTED',
  'BOTH_DRIFTED',
  'ORPHANED_CASE',
  'ORPHANED_TEST',
]);
export type SyncState = z.infer<typeof SyncStateSchema>;

export const TraceabilityEntrySchema = z.object({
  // Which tenant wrote this record (tenantContext.ts's getTenantId()) - defense-in-depth
  // self-identification on top of directory-based isolation (data/<tenantId>/...), so a
  // record is still correctly attributed if it's ever read outside its own tenant-scoped
  // file (e.g. a future cross-tenant export/report). Optional: absent on every entry written
  // before this field existed; every new entry populates it going forward.
  tenantId: z.string().optional(),
  jiraKey: z.string(),
  externalCaseId: z.string(),
  externalCaseHash: z.string(),
  externalCaseUpdatedAt: z.string(),
  tmsProvider: z.string(),
  testFilePath: z.string(),
  // Which `test(...)` block within testFilePath this entry is for, when the file holds more than
  // one (see src/pipeline/shared/testBlocks.ts's resolveTestBlock). Optional: a file with exactly
  // one test is unambiguous without it (every file generated before multi-test-per-file support
  // existed, and any single-scenario group today), so this is only ever required to disambiguate
  // a shared file. Absent on entries written before this field existed - backfilled by
  // scripts/backfillTestTitles.ts, which is deterministic-only (see its own comment) rather than
  // guessing when a file's test count doesn't resolve cleanly.
  testTitle: z.string().optional(),
  testContentHash: z.string(),
  testLastModified: z.string(),
  syncState: SyncStateSchema,
  lastCheckedAt: z.string(),
});
export type TraceabilityEntry = z.infer<typeof TraceabilityEntrySchema>;

// A single thing the Planning Agent found unclear or missing in the raw Jira requirement, found
// during Gate 0's pre-generation assessment - see WorkflowRecordSchema below.
export const RequirementGapSchema = z.object({
  description: z.string(),
});
export type RequirementGap = z.infer<typeof RequirementGapSchema>;

// One row per Jira key, tracking the three human-decision gates that must happen before a story's
// scenarios/test cases are allowed to move forward - see the Human Approval Gates section of
// README.md. Deliberately separate from TraceabilityEntrySchema: a gate decision is about a whole
// Jira story, made once, before any TMS case or test file exists yet (so there is nothing
// case-level to attach it to); a TraceabilityEntry is a decision about one specific case-to-test
// link, made after those things exist, and a single story can fan out to many of them. Forcing
// both into one per-case row would mean either duplicating the same timestamp across every case a
// story produces, or leaving mostly-empty placeholder rows in what's otherwise a list of real case
// links - this keeps the two concerns honest instead.
export const WorkflowRecordSchema = z.object({
  // Same field/meaning/optionality as TraceabilityEntrySchema.tenantId - see its comment.
  tenantId: z.string().optional(),
  jiraKey: z.string(),
  // Gate 0: the Planning Agent's own assessment of whether the raw Jira requirement had enough
  // detail (acceptance criteria, clear scope, no material ambiguity) to generate scenarios from
  // without guessing at intent - run via --stage flag-requirement-gaps before any scenario
  // generation happens. Unlike Gates 1/2 this isn't a human sign-off on agent output, it's a
  // record of the agent's own judgment call about its input, which is why it's a findings list
  // rather than a single timestamp - see requirementsClearedAt below for the actual gate.
  requirementGapsCheckedAt: z.string().optional(),
  requirementGaps: z.array(RequirementGapSchema).optional(),
  // The actual Gate 0 latch: set automatically when a check finds zero gaps, or explicitly by a
  // human via --stage approve-requirements after either updating the ticket or deciding the
  // flagged gaps don't actually block generation. Required before --stage excel-write is allowed
  // to run for this jiraKey - checked first, ahead of Gate 1, since it covers whether scenario
  // generation should have started from a clear requirement in the first place.
  requirementsClearedAt: z.string().optional(),
  // Who cleared Gate 0 - resolveOperator()'s output (PIPELINE_OPERATOR, falling back to
  // JIRA_EMAIL) at the moment requirementsClearedAt was set. Optional and purely informational:
  // with more than one person running this pipeline, this is what lets someone glance at
  // manifest.json and see who's already started a ticket, or who to ask about a gate decision -
  // see README's Team Usage section. Absent on records written before this field existed.
  requirementsClearedBy: z.string().optional(),
  // Gate 1: scenarios generated from the Jira requirement have been reviewed and approved by a
  // human. Required before --stage excel-write is allowed to run for this jiraKey.
  scenariosApprovedAt: z.string().optional(),
  // Who approved Gate 1 - same resolveOperator() attribution as requirementsClearedBy above.
  scenariosApprovedBy: z.string().optional(),
  // Gate 2: the detailed Excel/TMS test cases generated from the approved scenarios have been
  // reviewed and approved by a human. Required before --stage tms-upload is allowed to run for
  // this jiraKey (and transitively, before Playwright generation, which only starts once
  // traceability-record has run after a successful tms-upload).
  testCasesApprovedAt: z.string().optional(),
  // Who approved Gate 2 - same resolveOperator() attribution as requirementsClearedBy above.
  testCasesApprovedBy: z.string().optional(),
});
export type WorkflowRecord = z.infer<typeof WorkflowRecordSchema>;

export const TraceabilityManifestSchema = z.object({
  workflow: z.array(WorkflowRecordSchema),
  entries: z.array(TraceabilityEntrySchema),
});
export type TraceabilityManifest = z.infer<typeof TraceabilityManifestSchema>;

export const FailureCategorySchema = z.enum([
  'locator_drift',
  'ui_restructure',
  'copy_change',
  'real_regression',
  'environment_issue',
]);
export type FailureCategory = z.infer<typeof FailureCategorySchema>;

export const HealingOutcomeSchema = z.enum(['healed', 'escalated', 'passed_no_heal_needed']);
export type HealingOutcome = z.infer<typeof HealingOutcomeSchema>;

export const HealingEventSchema = z
  .object({
    // Same field/meaning/optionality as TraceabilityEntrySchema.tenantId - see its comment.
    tenantId: z.string().optional(),
    timestamp: z.string(),
    jiraKey: z.string().optional(),
    externalCaseId: z.string().optional(),
    testFilePath: z.string(),
    // Which `test(...)` block within testFilePath this event is about - same field/meaning as
    // TraceabilityEntry.testTitle. Optional for the same reason: unambiguous (and thus omittable)
    // when the file has exactly one test.
    testTitle: z.string().optional(),
    // Derived automatically from the test file's path (first directory under tests/) - never
    // typed by the agent. See src/pipeline/telemetry/suite.ts.
    suite: z.string(),
    // Final-outcome-only recording (see README's Healing Telemetry section for why): this is how
    // many fix attempts it took to reach this event's outcome, not a separate event per attempt.
    // 0 for passed_no_heal_needed (no fix attempt was made).
    attemptNumber: z.number().int().min(0),
    outcome: HealingOutcomeSchema,
    category: FailureCategorySchema.optional(),
    durationMs: z.number().optional(),
  })
  .refine((event) => event.outcome === 'passed_no_heal_needed' || event.category !== undefined, {
    message: 'category is required when outcome is "healed" or "escalated"',
    path: ['category'],
  });
export type HealingEvent = z.infer<typeof HealingEventSchema>;

export const FlakyRunResultSchema = z.enum(['pass', 'fail']);
export type FlakyRunResult = z.infer<typeof FlakyRunResultSchema>;

export const FlakyEvidenceEntrySchema = z.object({
  attempt: z.number().int().min(1),
  result: FlakyRunResultSchema,
  timestamp: z.string(),
});
export type FlakyEvidenceEntry = z.infer<typeof FlakyEvidenceEntrySchema>;

export const FlakyEventSchema = z.object({
  // Same field/meaning/optionality as TraceabilityEntrySchema.tenantId - see its comment.
  tenantId: z.string().optional(),
  timestamp: z.string(),
  jiraKey: z.string().optional(),
  externalCaseId: z.string().optional(),
  testFilePath: z.string(),
  // Same field/meaning as TraceabilityEntry.testTitle - see its comment.
  testTitle: z.string().optional(),
  // Same derivation as HealingEvent.suite - first directory under tests/, never typed by the agent.
  suite: z.string(),
  // The ordered pass/fail observations that led to this event's action - real evidence, not a
  // single-pass judgement call. Requires at least 2 so a lone observation can never be recorded.
  evidence: z.array(FlakyEvidenceEntrySchema).min(2),
  action: z.enum(['quarantined', 'cleared']),
});
export type FlakyEvent = z.infer<typeof FlakyEventSchema>;

export const QuarantineEntrySchema = z.object({
  // Same field/meaning/optionality as TraceabilityEntrySchema.tenantId - see its comment.
  tenantId: z.string().optional(),
  testFilePath: z.string(),
  // Same field/meaning as TraceabilityEntry.testTitle - see its comment. Required so
  // upsertQuarantineEntry/removeQuarantineEntry can quarantine (or clear) exactly the flaky
  // scenario within a shared file, not every sibling test that happens to live in the same one.
  testTitle: z.string().optional(),
  jiraKey: z.string().optional(),
  externalCaseId: z.string().optional(),
  suite: z.string(),
  quarantinedAt: z.string(),
  evidence: z.array(FlakyEvidenceEntrySchema).min(2),
});
export type QuarantineEntry = z.infer<typeof QuarantineEntrySchema>;

export const QuarantineManifestSchema = z.array(QuarantineEntrySchema);
export type QuarantineManifest = z.infer<typeof QuarantineManifestSchema>;

export const CostEventSchema = z.object({
  // Same field/meaning/optionality as TraceabilityEntrySchema.tenantId - see its comment.
  tenantId: z.string().optional(),
  timestamp: z.string(),
  // From the wrapper's launch context (planning-agent.md's cost-marker calls), never the OTel
  // agent.name attribute - that collapses to "custom" for every user-defined subagent. See
  // README's Cost/Latency Accounting section.
  agent: z.string(),
  model: z.string(),
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  cacheReadTokens: z.number().int().min(0),
  cacheCreationTokens: z.number().int().min(0),
  costUsd: z.number().min(0),
  wallClockMs: z.number().int().min(0),
  // Which Jira ticket this dispatch was working on, from --stage cost-marker's optional --issue
  // flag (see recordMarker.ts's AgentMarker.jiraKey and parseAgentLog.ts's pairMarkers/
  // buildCostEvents). Optional since not every agent dispatch is ticket-scoped (e.g.
  // pipeline-report, drift-check) - those events simply have no jiraKey, same as before this field
  // existed. --stage cost-report --issue <KEY> filters on this field.
  jiraKey: z.string().optional(),
});
export type CostEvent = z.infer<typeof CostEventSchema>;

/**
 * The deterministic subset of AGENTS.md's rules, externalized into data instead of being
 * hardcoded inside each guardrail's TypeScript. The point: adding "also forbid id_rsa" or "also
 * require @nightly" is a one-line edit to policy.json, not a code change to every guardrail that
 * cares about it - and there is exactly one list to keep in sync with AGENTS.md's prose, not one
 * per guardrail. Deliberately scoped to rules that reduce to a flat match/no-match - anything that
 * needs real judgement (e.g. "no business logic in tests") stays out of this file and out of CI,
 * same reasoning AGENTS.md's own ✅/🕐/unmarked legend documents.
 */
export const PolicySchema = z.object({
  policyVersion: z.number().int().min(1),
  // Matched as a literal substring against each added/modified line of *.spec.ts files in the PR
  // diff - not a regex engine, deliberately, so this file stays writable by a non-engineer without
  // learning regex escaping. "page.waitForTimeout" also catches "page.waitForTimeout(1000)" etc.
  // since it's substring matching, not a full-call match.
  forbiddenPlaywrightPatterns: z.array(z.string()).default([]),
  // At least one of these must appear in a new test's `{ tag: [...] }` option - see
  // checkRequiredTags.ts. Written without the leading "@" here (AGENTS.md's prose uses `@smoke`
  // for readability; Playwright's own tag option strings don't include the "@").
  requiredTestTags: z.array(z.string()).default([]),
  // Exact filenames (basename match, not a path/glob) that must never appear in a PR's added
  // files - checkSecretsCommitted.ts. This is the one guardrail in the whole pipeline with no
  // suppression/override mechanism at all; see its own doc comment for why.
  forbiddenCommittedFilenames: z.array(z.string()).default([]),
});
export type Policy = z.infer<typeof PolicySchema>;

/**
 * Per-tenant feature/integration gating - see config/tenants/<tenantId>.json (capabilityStore.ts).
 * Two independent axes, matching how a real customer plan actually varies: `integrations` is
 * what's configured/available (which TMS provider, which notification channels exist), `stages`
 * is which pipeline FEATURES this tenant's plan includes (grouped product capabilities, not a
 * 1:1 mirror of every --stage string - see capabilityStore.ts's STAGE_CAPABILITY_MAP). Every flag
 * defaults to enabled/true: this is an opt-OUT model for narrower plans, not an opt-in lockdown -
 * a tenant with no capabilities.json at all (including "default") behaves exactly as it did
 * before this file existed. Deliberately excludes CI guardrail-check stages (secrets-check,
 * forbidden-playwright-patterns-check, required-tags-check, scenario-quality-check,
 * manifest-provenance-check, spec-file-consolidation-check, assertion-check, locator-check,
 * traceability-coverage-check) - those are policy enforcement on every PR regardless of tenant
 * plan, not an opt-in feature a tenant's plan could be missing.
 *
 * Also deliberately excludes scenario/Playwright test generation itself: that happens via an
 * interactive agent dispatch, not a --stage in pipeline.ts's switch, so it has no hook this model
 * can gate yet. Known, deliberate gap - revisit once tenant-aware agent dispatch is itself a
 * real question (not yet, with one tenant in play) rather than solving it speculatively here.
 */
export const TmsIntegrationSchema = z.object({
  enabled: z.boolean().default(true),
  // Open string, not a zod enum of e.g. ["qase","xray","zephyr"] - a new adapter never needs a
  // schema change here, only a real case added to getTestManagementClient()'s switch
  // (testmgmt/index.ts). Validated against the actual adapter registry at the point of use, same
  // as TMS_PROVIDER's "unknown provider" throw today - this schema doesn't gatekeep which
  // providers exist, it just records the tenant's choice.
  provider: z.string().optional(),
});
export type TmsIntegration = z.infer<typeof TmsIntegrationSchema>;

export const NotificationChannelSchema = z.object({
  enabled: z.boolean().default(false),
});
export type NotificationChannel = z.infer<typeof NotificationChannelSchema>;

export const NotificationsIntegrationSchema = z.object({
  enabled: z.boolean().default(true), // master switch: can this tenant receive ANY notification
  // Record instead of hardcoded slack/teams/email fields - adding a new channel later is a config
  // change, not a schema change. Only "slack" is actually implemented today; "teams" and "email"
  // are named here for forward-compat but have no adapter yet.
  channels: z.record(z.string(), NotificationChannelSchema).default({}),
});
export type NotificationsIntegration = z.infer<typeof NotificationsIntegrationSchema>;

/**
 * Which secrets backend this tenant's credentials resolve through - the Secrets-manager fix
 * (per-tenant credential isolation). See src/pipeline/config/secretsProvider.ts's SecretsProvider
 * interface and env.ts's resolveTenantEnv()/requireTenantEnv(), which every credential-consuming
 * module already goes through. Open string, not a zod enum, same "don't gatekeep in the schema"
 * reasoning as TmsIntegrationSchema.provider above and ScrumVcsConfigSchema.provider
 * (scrumConfigStore.ts) - validated against the real provider registry
 * (secretsProvider.ts's selectSecretsProvider()) at the point of use, not here.
 *
 * Defaults to 'env-file' - today's single flat .env + <KEY>__<TENANT> override behavior
 * (EnvFileSecretsProvider) - so every existing tenant's credential resolution is completely
 * unchanged until it explicitly opts into a real secrets manager (e.g. 'azure-key-vault').
 * Unlike TmsIntegrationSchema.provider (which is `.optional()`, with the fallback supplied by the
 * caller - see capabilityStore.ts's resolveTmsProvider()), this field defaults directly to
 * 'env-file' in the schema itself: there was never a pre-capabilities.json env var for "which
 * secrets backend" that a caller-supplied fallback would need to preserve compatibility with.
 */
export const SecretsIntegrationSchema = z.object({
  provider: z.string().default('env-file'),
});
export type SecretsIntegration = z.infer<typeof SecretsIntegrationSchema>;

export const TenantIntegrationsSchema = z.object({
  jira: z.object({ enabled: z.boolean().default(true) }).default({ enabled: true }),
  tms: TmsIntegrationSchema.default({ enabled: true }),
  notifications: NotificationsIntegrationSchema.default({ enabled: true, channels: {} }),
  secrets: SecretsIntegrationSchema.default({ provider: 'env-file' }),
});
export type TenantIntegrations = z.infer<typeof TenantIntegrationsSchema>;

export const TenantStageCapabilitiesSchema = z.object({
  scenarioGeneration: z.boolean().default(true), // jira, excel-write/read, flag/approve-*-gates
  tmsUpload: z.boolean().default(true),          // tms-upload, tms-submit-result
  traceability: z.boolean().default(true),       // traceability-*, rename-spec-file, drift-check
  healing: z.boolean().default(true),            // healing-record, healing-report
  flakyManagement: z.boolean().default(true),    // flaky-record, flaky-clear, flaky-report
  costAccounting: z.boolean().default(true),     // cost-marker, cost-record, cost-report
  notifications: z.boolean().default(true),      // any stage with a Slack/Teams/email side-effect
  reporting: z.boolean().default(true),          // pipeline-report, prompt-version-report, ticket-summary
  // Write actions to external systems get their own gate throughout this project's design -
  // ticket transitions (jira-transitions/jira-transition) are a write action, kept separate from
  // scenarioGeneration's read-mostly bookkeeping rather than folded into it.
  jiraWorkflowActions: z.boolean().default(true), // jira-transitions, jira-transition
  // Scrum Master Automation Program flags (Phase 1 prerequisite, recorded in docs/planning's
  // Continuity Log so it wasn't skipped when sprint-status/standup-digest/dev-status were built -
  // see STAGE_CAPABILITY_MAP in capabilityStore.ts for the stage->flag mapping). Split in two, not
  // one shared flag, because the Continuity Log's confirmed launch config for the first tenant
  // turns them on separately ("ceremony + QA telemetry at launch" - VCS/dev telemetry is not part
  // of that launch set): scrumCeremony gates the Scrum-ceremony reporting duties, scrumDevStatus
  // gates the VCS-telemetry-sourced one. Both default true here for the same opt-out-not-opt-in
  // reason every other flag in this schema does - no real capabilities.json is being written for
  // any tenant in this PR (see capabilityStore.ts's fullAccessDefaults()), so this default is the
  // schema's contract for what a not-yet-provisioned tenant sees the day these stages first ship,
  // not a statement about any specific tenant's actual launch config (that provisioning step is a
  // later PR).
  scrumCeremony: z.boolean().default(true),  // sprint-status, standup-digest
  scrumDevStatus: z.boolean().default(true), // dev-status
  // blocker-scan (Phase 2) gets its own flag rather than folding into scrumCeremony, same
  // "write actions get their own gate" precedent as jiraWorkflowActions above - this is the first
  // scrum-master-agent stage that writes anything at all (Jira comments, Slack messages) rather
  // than pure reporting or DM-only delivery, so a tenant should be able to keep ceremony reporting
  // on while this stays off (or vice versa) independently. Defaults true for the same
  // opt-out-not-opt-in reason every flag here does (see scrumCeremony's own comment) - not a
  // statement that any real tenant has actually approved live blocker-scan writes yet; see this
  // stage's own doc comment (blockerScan.ts) for why it ships manual-CLI-only, not cron-wired, in
  // this PR regardless of this flag's default.
  scrumBlockerScan: z.boolean().default(true), // blocker-scan
  // backlog-groom-check (Phase 2, the second and final duty) gets its own flag too, same
  // per-duty-gets-its-own-gate precedent as scrumBlockerScan above - a tenant can keep ceremony
  // reporting and/or blocker-scan on while this stays off, or vice versa, independently. Gates
  // both --stage groom-check-fetch (the deterministic fetch half) and --stage groom-check-flag
  // (the comment-posting half) - see STAGE_CAPABILITY_MAP. There is deliberately no third,
  // automated "--stage backlog-groom-check" stage to gate: the actual judgment call is made in a
  // live agent session, not a deterministic function - see groomCheck.ts's own header comment for
  // the full Option-B reasoning (Continuity Log, Aug 22 "backlog-groom-check build approach").
  scrumGroomCheck: z.boolean().default(true), // groom-check-fetch, groom-check-flag
  // burndown-report (Phase 3, first duty) gets its own flag too, same per-duty-gets-its-own-gate
  // precedent as scrumBlockerScan/scrumGroomCheck above - a tenant can keep ceremony reporting
  // and/or either Phase 2 duty on while this stays off, or vice versa, independently. Fully
  // deterministic (see burndownReport.ts's own header comment) - no live-judgment step like
  // groom-check-fetch/-flag, and no write/escalation side effect like blocker-scan, so there's no
  // trust-boundary reason this couldn't have folded into scrumCeremony instead; kept separate
  // anyway for consistency with every other scrum duty getting its own independently-toggleable
  // flag, and because a narrower-plan tenant may want ceremony reporting without also getting a
  // brand-new Phase 3 duty turned on by default the moment it merges.
  scrumBurndown: z.boolean().default(true), // burndown-report
  // retro-notes (Phase 3, second and final duty) gets its own flag too, same per-duty-gets-its-
  // own-gate precedent as scrumBlockerScan/scrumGroomCheck/scrumBurndown above. Like
  // scrumGroomCheck, this gates a fetch/post pair with no automated judgment stage in between -
  // see retroNotes.ts's own header comment for the Option-B reasoning (same as backlog-groom-
  // check's). There is deliberately no third, automated "--stage retro-notes" stage to gate: the
  // actual retrospective synthesis is made in a live agent session, not a deterministic function.
  scrumRetro: z.boolean().default(true), // retro-notes-fetch, retro-notes-post
  // Phase C ("AI-Assisted Scrum and SDLC Console - Development Plan," docs/planning/) - gets its
  // own flag rather than folding into scenarioGeneration, same per-duty-gets-its-own-gate
  // precedent as every scrum duty above: this drafts a genuinely new artifact (a user story from
  // an Epic) and calls a new external system (backend/'s AI Queue, via queueClient.ts) that
  // scenarioGeneration's other stages don't touch, so a tenant should be able to toggle this
  // independently of test-scenario generation. Defaults true for the same opt-out-not-opt-in
  // reason every flag here does - not a statement that any real tenant has approved live
  // story-drafting writes yet.
  storyDrafting: z.boolean().default(true), // draft-story
  // Sprint plan, velocity half only (Phase C's other half, "AI-Assisted Scrum and SDLC Console -
  // Development Plan," docs/planning/) - its own flag, same per-duty-gate precedent as
  // storyDrafting above: this calls a new Anthropic prompt (draftSprintPlanNarrative.ts) and posts
  // a new sourceStage ('sprint-plan') to the AI Queue, independent of story drafting. Capacity/
  // Tempo integration is explicitly NOT part of what this flag gates - it doesn't exist yet
  // (unresolved pending a Tempo-vs-manual-input decision); this only gates the velocity-based
  // suggestion. Defaults true for the same opt-out-not-opt-in reason every flag here does.
  sprintPlanning: z.boolean().default(true), // draft-sprint-plan
  // Phase E ("AI-Assisted Scrum and SDLC Console - Development Plan," docs/planning/) - "Release
  // Stage." Its own flag, same per-duty-gate precedent as storyDrafting/sprintPlanning above, even
  // though this stage is read-only (never writes to Jira) - it still queries live Jira data and
  // posts a new sourceStage ('release') to the AI Queue, both real external effects a tenant should
  // be able to toggle independently. Defaults true for the same opt-out-not-opt-in reason every
  // flag here does.
  releaseSummary: z.boolean().default(true), // release-summary
  // Manual-Tester Agent (persona exploration + ticket-driven verification) - its own gate, same
  // per-duty-gets-its-own-gate precedent as every duty above. Gates all six manual-tester stages
  // (dogfood-run/-approve/-file, ticket-verify/-approve/-comment). Both modes drive the live app
  // and write to Jira (human-gated), so a tenant should be able to toggle this independently of
  // scenarioGeneration's scripted path. Defaults true for the same opt-out-not-opt-in reason.
  manualTesting: z.boolean().default(true), // dogfood-*, ticket-verify-*
});
export type TenantStageCapabilities = z.infer<typeof TenantStageCapabilitiesSchema>;

export const TenantCapabilitiesSchema = z.object({
  // Required (not defaulted): config/tenants/<tenantId>.json's own filename already says which
  // tenant this is for, but requiring it inside the file too lets loadCapabilities() cross-check
  // the two and fail loud on a copy-paste mistake (a file meant for one tenant saved under
  // another's path) instead of silently applying the wrong tenant's capabilities.
  tenantId: z.string(),
  // Free-text label for which subscription/package this config was derived from -
  // documentation/audit only. Nothing in the pipeline branches on this string; a future
  // provisioning step would stamp the flags below FROM the plan, not have runtime code re-derive
  // flags by inspecting the plan name.
  plan: z.string().optional(),
  integrations: TenantIntegrationsSchema.default({
    jira: { enabled: true },
    tms: { enabled: true },
    notifications: { enabled: true, channels: {} },
    secrets: { provider: 'env-file' },
  }),
  stages: TenantStageCapabilitiesSchema.default({
    scenarioGeneration: true,
    tmsUpload: true,
    traceability: true,
    healing: true,
    flakyManagement: true,
    costAccounting: true,
    notifications: true,
    reporting: true,
    jiraWorkflowActions: true,
    scrumCeremony: true,
    scrumDevStatus: true,
    scrumBlockerScan: true,
    scrumGroomCheck: true,
    scrumBurndown: true,
    scrumRetro: true,
    storyDrafting: true,
    sprintPlanning: true,
    releaseSummary: true,
    manualTesting: true,
  }),
});
export type TenantCapabilities = z.infer<typeof TenantCapabilitiesSchema>;

/**
 * Per-tenant Scrum Master Automation Program config - scrum/config.json (docs/planning's Option 1
 * Technical Document, Section 4.4). Same admin-provisioned-config category as capabilities.json
 * (config/tenants/<tenantId>.json, see TenantCapabilitiesSchema above) and policy.json - a human
 * edits it through the dashboard's Settings panel (a schema-validated, git-backed write path,
 * Technical Document Section 4.8), and deterministic scrum stages (sprint-status, standup-digest,
 * blocker-scan, burndown-report, ...) read from it instead of hardcoded constants.
 *
 * Phase 0 scope note: this is the schema only. No loader/store module (mirroring
 * policyStore.ts/capabilityStore.ts's LOAD_PATH()+load*() pattern) exists yet, and no stage reads
 * this file yet - that lands in Phase 1 alongside the first stage that actually needs it. Phase 0
 * is scoping, not implementation (Technical Document Section 7's phase table: Phase 0 writes no
 * code that touches Jira/Slack).
 *
 * File path: DECIDED (not just proposed) as a nested per-tenant directory -
 * config/tenants/<tenantId>/capabilities.json + config/tenants/<tenantId>/scrum.json - rather than
 * a flat config/tenants/<tenantId>-scrum.json sibling. Reasoning: the dashboard-auth proposal in
 * this phase's write-up already wants a second per-tenant admin-config concern (the Settings-panel
 * login allowlist, proposed to live in capabilities.json specifically so the Settings panel can't
 * self-escalate by editing its own allowlist) - "more than one file per tenant" is not
 * hypothetical, so the nested shape earns its cost immediately rather than being spec work for a
 * someday-maybe third file. capabilityStore.ts's CAPABILITIES_PATH() has been migrated to
 * path.join('config', 'tenants', tenantId, 'capabilities.json') in this same PR, alongside the new
 * scrumConfigStore.ts loader (SCRUM_CONFIG_PATH() at the matching nested scrum.json path) - the
 * "one migration, not two" this comment used to flag as still-pending is done.
 *
 * Field naming is deliberately tracker-neutral (boardIds, storyPointsField - not jiraBoardIds,
 * jiraStoryPointsField) per docs/planning's Issue Tracker Abstraction Future Plan doc (Section 4).
 * Jira is the only issue tracker this project supports today (see that doc's Section 2), and nothing
 * about that changes here - this is the one naming decision made now specifically because it is
 * free today (a schema not yet built) and a real migration later (touching a live config file,
 * dashboard UI, and docs) once a real non-Jira client needs it (that doc's Section 6 trigger
 * checklist is unchanged and ungated by this). The existing jiraKey field already threaded through
 * TraceabilityEntry/CostEvent/healing-telemetry schemas is explicitly untouched - see that doc's
 * Section 5, Step 5.
 */

/**
 * One channel/target pair for an escalation recipient - e.g. { channel: "slack", target:
 * "U012ABC" } or { channel: "email", target: "lead@example.com" }. `channel` is an open string
 * (not a zod enum of e.g. ["slack","teams","email"]), same "record the tenant's choice, don't
 * gatekeep which providers exist in the schema" reasoning as TmsIntegrationSchema.provider above -
 * validated against the real notifier registry wherever blocker-scan's delivery code is built
 * (Phase 2), not here. `target` is deliberately untyped free text since its shape depends
 * entirely on which channel it is for (a Slack user/channel ID, an email address, a Teams handle).
 */
export const ScrumEscalationChannelSchema = z.object({
  channel: z.string(),
  target: z.string(),
});
export type ScrumEscalationChannel = z.infer<typeof ScrumEscalationChannelSchema>;

/**
 * One "related team member" to notify alongside a blocked ticket's assignee - the confirmed
 * must-build second recipient from Technical Document Section 9's added bullet (see also
 * Continuity Log Section 7, "Blocker escalation scope"). The assignee itself is NOT a field here:
 * it is always notified, resolved from the ticket at blocker-scan runtime (Phase 2), never
 * configured - this schema only reserves the shape for the *additional* recipient the team
 * confirmed is required. `channels` is an array (not a single field) so one related recipient can
 * be reached on more than one channel at once (e.g. Slack AND email) - a tenant may need that
 * redundancy for a genuinely blocking issue; a single-channel tenant just supplies one entry.
 */
export const ScrumEscalationRecipientSchema = z.object({
  // Fixed set, not an open string - unlike `channel`/`provider` fields elsewhere in this file,
  // "who counts as a related team member" is a small, known set the product itself defines
  // (Technical Document Section 9: "team lead, component owner, or a configured backup"), not a
  // provider-registry concept that grows over time.
  role: z.enum(['team-lead', 'component-owner', 'backup']),
  // Free-text identifier for whoever holds this role for this tenant (an email address, a Slack
  // handle, a Jira account id - whatever the paired channel needs). Resolved as a literal
  // configured value, not looked up against Jira/Slack at config-write time.
  identifier: z.string(),
  channels: z.array(ScrumEscalationChannelSchema).min(1),
});
export type ScrumEscalationRecipient = z.infer<typeof ScrumEscalationRecipientSchema>;

/**
 * blocker-scan's full escalation config (Phase 2 build; Technical Document's Duty Breakdown and
 * Section 9 both describe this as a confirmed must-build, not a deferred/speculative item like
 * the second-issue-tracker-provider question). Reserved now, in Phase 0, so Phase 2 does not need
 * a schema retrofit - per the user's explicit instruction and Continuity Log Section 7.
 */
export const ScrumBlockerEscalationSchema = z.object({
  // Days a ticket can sit blocked/idle before blocker-scan escalates it. Matches "a configurable
  // threshold" language in Technical Document Section 3's Duty Breakdown row for blocker/
  // impediment tracking. Default is a reasonable placeholder, not a confirmed client value - see
  // this phase's open-questions list.
  idleDaysThreshold: z.number().int().min(1).default(3),
  // Zero or more related-team-member recipients (see ScrumEscalationRecipientSchema's comment for
  // why the assignee itself isn't listed here). Defaults to empty - a tenant with no related-
  // recipient configured yet still gets assignee-only escalation, the same behavior as today,
  // rather than blocker-scan failing to run because this array is unconfigured.
  relatedRecipients: z.array(ScrumEscalationRecipientSchema).default([]),
});
export type ScrumBlockerEscalation = z.infer<typeof ScrumBlockerEscalationSchema>;

/**
 * VCS/CI config for a tenant's development tickets (Technical Document Section 4.3's vcsClient.ts,
 * Phase 1 build). `provider` is an open string (not a zod enum) for the same "don't gatekeep in
 * the schema" reasoning as this file's other provider fields - validated against vcsClient.ts's
 * real adapter registry when that's built, not here.
 */
export const ScrumVcsConfigSchema = z.object({
  provider: z.string().optional(),
  // How this tenant's branch names/PR titles reference a ticket key - e.g. a literal "KAN-123"
  // appearing anywhere, or a fixed prefix convention like "feature/KAN-123-...". Free text, not a
  // fixed enum, since Section 9 flags this as varying per tenant and genuinely unconfirmed for any
  // real client yet - vcsClient.ts (Phase 1) is what actually parses against it.
  branchKeyConvention: z.string().optional(),
});
export type ScrumVcsConfig = z.infer<typeof ScrumVcsConfigSchema>;

/**
 * Top-level scrum/config.json shape. See this block's opening comment for the file-path proposal
 * and the tracker-neutral naming decision. Every field below traces to one of Technical Document
 * Section 9's open questions - each field's comment says which.
 */
export const ScrumConfigSchema = z.object({
  // Same cross-check reasoning as TenantCapabilitiesSchema.tenantId above: the file's own path
  // already says which tenant this is for, but requiring it inside the file too lets a future
  // loader fail loud on a copy-paste mistake instead of silently applying the wrong tenant's
  // scrum config.
  tenantId: z.string(),
  configVersion: z.number().int().min(1).default(1),
  // Section 9, Q1: "Which Jira board ID(s) / project(s) are in scope, per tenant?" Plural/array,
  // not a single string - Section 9 itself asks for "board ID(s)", and Technical Document Section
  // 4.3 notes agileClient.ts is written against one board at a time today, but a multi-board
  // tenant existing later shouldn't need a schema change to be representable.
  boardIds: z.array(z.string()).default([]),
  // Section 9, Q2: "What custom field holds story points on each tenant's Jira instance?" Left
  // optional/unconfirmed rather than defaulted to a guessed value (e.g. "customfield_10016") -
  // this varies per Jira instance and burndown-report (Phase 3) simply cannot run without a real
  // answer; a wrong guessed default would fail silently in the worst way (wrong numbers, not a
  // clear error).
  storyPointsField: z.string().optional(),
  // Section 9, Q3: "Which Slack channel should each tenant's standup digest post to, versus a
  // DM?" `dm: true` means the tenant wants standup-digest delivered as individual DMs instead of
  // a shared channel post - the two are not both-or-neither; a tenant may want one or the other.
  standupDigest: z
    .object({
      channel: z.string().optional(),
      dm: z.boolean().default(false),
    })
    .default({ dm: false }),
  // Section 9, Q4: "Which VCS/CI provider does each tenant use, and what is their Jira-key-in-
  // branch/PR convention?"
  vcs: ScrumVcsConfigSchema.default({}),
  // Section 9's 7th bullet (added Aug 21 - confirmed must-build escalation requirement, not
  // speculative; see ScrumBlockerEscalationSchema's own comment). Phase 2 is the actual
  // blocker-scan build; this reserves the shape now.
  blockerEscalation: ScrumBlockerEscalationSchema.default({
    idleDaysThreshold: 3,
    relatedRecipients: [],
  }),
});
export type ScrumConfig = z.infer<typeof ScrumConfigSchema>;

/**
 * One persona for the Manual-Tester Agent's persona-exploration mode (Mode A). A prompt frame, not
 * a script: the agent behaves as this user, pursues their goals, and reacts with their habits and
 * blind spots. The realistic imperfections (habits/blindSpots) are the instrument that surfaces
 * friction a happy-path script never would.
 */
export const PersonaSchema = z.object({
  // Stable slug used as --persona <id> and as a session-record key. Filesystem-safe (lowercase
  // alphanumeric + hyphens, starting alphanumeric) so it can be a literal path/filename segment.
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  displayName: z.string(),
  // What this user is trying to accomplish; at least one (a persona with no goal has nothing to
  // explore). The agent pursues each goal the way this persona would.
  goals: z.array(z.string()).min(1),
  // One line of situational framing (patience, expectations) that colours every decision.
  context: z.string(),
  // Realistic behaviours the persona exhibits - e.g. "clicks the first plausible button",
  // "doesn't scroll below the fold". This is what finds bugs a script's perfect path misses.
  habits: z.array(z.string()).default([]),
  blindSpots: z.array(z.string()).default([]),
  // Optional full start URL. Absent -> the stage starts at APP_BASE_URL (post-login landing).
  startUrl: z.string().url().optional(),
  // Hard stops enforced in code, not left to the model's judgement - e.g. "no payment submit",
  // "no account deletion", "no admin areas". Empty is allowed but discouraged for a prod target.
  outOfBounds: z.array(z.string()).default([]),
  // Bounds on one exploration session. Defaults match the spec (~40 interactions / ~10 min).
  stepBudget: z.number().int().min(1).default(40),
  timeBoxMinutes: z.number().int().min(1).default(10),
});
export type Persona = z.infer<typeof PersonaSchema>;

/**
 * Admin-provisioned per-tenant persona set - config/tenants/<tenantId>/personas.json. Same
 * admin-config category as scrum.json / capabilities.json (see personasConfigStore.ts). tenantId
 * is required for the same copy-paste cross-check every other per-tenant config file uses.
 */
export const PersonasConfigSchema = z
  .object({
    tenantId: z.string(),
    configVersion: z.number().int().min(1).default(1),
    // Missing file -> empty list (loader): "no personas provisioned yet" is a normal, safe state,
    // not a misconfiguration - same opt-out posture as scrum.json / capabilities.json.
    personas: z.array(PersonaSchema).default([]),
  })
  .superRefine((cfg, ctx) => {
    const seen = new Set<string>();
    for (const persona of cfg.personas) {
      if (seen.has(persona.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate persona id "${persona.id}" - persona ids must be unique within a tenant`,
          path: ['personas'],
        });
      }
      seen.add(persona.id);
    }
  });
export type PersonasConfig = z.infer<typeof PersonasConfigSchema>;
