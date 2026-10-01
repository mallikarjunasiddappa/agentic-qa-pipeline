import fs from 'node:fs';
import path from 'node:path';
import axios from 'axios';
import { getJiraClient } from '../jira/jiraClient';
import { writeScenarios, buildScenarioFileName, assignDisplayIds } from '../excel/excelWriter';
import { readScenarios } from '../excel/excelReader';
import { getTestManagementClient } from '../testmgmt';
import { TmsResultStatus, TmsRunRecord } from '../testmgmt/types';
import { parseScenariosFromSpec, parseJiraKeyFromSpec, parseSuiteFromSpec } from '../specs/specParser';
import { resolveSuiteTitle } from '../testmgmt/suiteResolver';
import { RequirementGap, Scenario, TraceabilityManifest } from '../types/schemas';
import { buildRequirementGapComment } from '../requirementGate/requirementGate';
import { judgeRequirementClarity, DEFAULT_MODEL } from '../requirementGate/headlessJudge';
import { answerQuestion } from '../ask/askEngine';
import { draftStoryFromEpic } from '../storyDraft/draftStory';
import { createQueueItem } from '../queueClient/queueClient';
import { env, resolveTenantEnv, requireTenantEnv } from '../config/env';
import { getTenantId, resolveTenantId, setTenantId, tenantDataPath } from '../config/tenantContext';
import { assertStageAllowed, resolveTmsProvider } from '../config/capabilityStore';
import { loadPersonasConfig, getPersona } from '../config/personasConfigStore';
import {
  parseTicket,
  classifyAmbiguity,
  suggestClarification,
  mapVerdicts,
  summarizeOutcome,
  composeVerificationComment,
} from '../manualTester/acVerification';
import { selectFileable, toBugDraft } from '../manualTester/frictionLog';
import { buildPlanScenario, promoteInputFromSession, nextGroupIndex, buildNewSpecFile } from '../manualTester/promote';
import {
  TicketVerifySession,
  DogfoodSession,
  writeTicketVerifySession,
  readTicketVerifySession,
  ticketVerifySessionPath,
  writeDogfoodSession,
  readDogfoodSession,
  dogfoodSessionPath,
  stampApproval,
  assertApproved,
} from '../manualTester/sessionStore';
import { resolveOperator, allowSlackNotify, allowEmailNotify } from '../config/teamConfig';
import { buildEntriesForSpec } from '../traceability/recordBaseline';
import { buildRunFilePath } from './runFilePath';
import {
  loadManifest,
  saveManifest,
  upsertEntry,
  updateTestBaseline,
  findWorkflowRecord,
  upsertWorkflowRecord,
  findEntry,
  removeEntry,
  findEntryByTestFilePath,
} from '../traceability/manifestStore';
import { recordManifestStageMarker } from '../traceability/manifestStageMarker';
import { hashCase, hashScenarioTestBlock } from '../traceability/hashing';
import { findTestBlocks } from '../shared/testBlocks';
import { checkDrift, toManifestEntry } from '../traceability/traceabilityAgent';
import { writeReports } from '../traceability/report';
import { buildPreviousSyncStateMap, findNewlyDrifted, postDriftComments } from '../traceability/jiraNotify';
import { postDriftCheckToSlack } from '../traceability/slackNotify';
import { appendHealingEvent, readHealingEvents } from '../telemetry/recordHealingEvent';
import { deriveSuite } from '../telemetry/suite';
import {
  FailureCategorySchema,
  FlakyEvent,
  FlakyRunResultSchema,
  HealingEvent,
  HealingOutcomeSchema,
} from '../types/schemas';
import { buildHealingReport, writeHealingReports } from '../telemetry/healingReport';
import { decideFlaky } from '../flaky/evaluateFlakiness';
import { appendFlakyEvent, readFlakyEvents } from '../flaky/recordFlakyEvent';
import { loadQuarantine, saveQuarantine, upsertQuarantineEntry, removeQuarantineEntry } from '../flaky/quarantineStore';
import { buildFlakyReport, writeFlakyReports } from '../flaky/flakyReport';
import { collectSignals, findUnlinkedTests } from '../suiteHealth/collectSignals';
import { candidateFromTmsCase, findDuplicateCoverage, toDuplicateGroups } from '../suiteHealth/findDuplicateCoverage';
import { scoreAllRisk, toRiskBands, DEFAULT_AREA_WEIGHT } from '../suiteHealth/riskWeight';
import { buildReport as buildSuiteHealthReport } from '../suiteHealth/buildReport';
import { writeSuiteHealthReports } from '../suiteHealth/writeReports';
import { buildPromptVersionReport } from '../promptVersions/buildChangelog';
import { writePromptVersionReports } from '../promptVersions/report';
import { buildPipelineReport, deriveSiteRoot, readTraceabilitySummary, writePipelineReports } from '../pipelineReport/pipelineReport';
import { postToSlack } from '../pipelineReport/slackNotify';
import { checkAssertionIntegrity } from '../assertionGuard/checkAssertionIntegrity';
import { checkLocatorPriority } from '../locatorGuard/checkLocatorPriority';
import { checkTraceabilityCoverage } from '../traceabilityGuard/checkTraceabilityCoverage';
import { checkManifestProvenance } from '../traceabilityGuard/checkManifestProvenance';
import { checkSpecFileConsolidation } from '../traceabilityGuard/checkSpecFileConsolidation';
import { checkSecretsCommitted } from '../policyGuard/checkSecretsCommitted';
import { checkForbiddenPlaywrightPatterns } from '../policyGuard/checkForbiddenPlaywrightPatterns';
import { checkRequiredTags } from '../policyGuard/checkRequiredTags';
import { checkScenarioQuality } from '../scenarioGuard/checkScenarioQuality';
import { appendMarker, readMarkers, MARKERS_LOG_PATH } from '../costAccounting/recordMarker';
import { buildCostEvents, parseMetricBlocks } from '../costAccounting/parseAgentLog';
import { appendCostEvents, readCostEvents } from '../costAccounting/recordCostEvents';
import { buildCostReport, writeCostReports, filterEventsByIssue, buildIssueReportPaths } from '../costAccounting/costReport';
import { postCostReportToSlack } from '../costAccounting/slackNotify';
import { gatherTicketSummary } from '../ticketSummary/gatherTicketSummary';
import { buildTicketSummaryText } from '../ticketSummary/buildTicketSummary';
import { sendTicketSummaryDm } from '../ticketSummary/slackDm';
import { getVcsClient, hasVcsConfigured } from '../scrum/vcsClient';
import { buildDevStatusReport, writeDevStatusReports, DevStatusReport } from '../scrum/stages/devStatus';
import { getAgileClient } from '../scrum/agileClient';
import { buildSprintStatusReport, writeSprintStatusReports, SprintStatusBoardSprint } from '../scrum/stages/sprintStatus';
import { buildBurndownSprintReport, writeBurndownReports } from '../scrum/stages/burndownReport';
import { buildBoardVelocityReport } from '../scrum/stages/velocityReport';
import { selectSprintPlanCandidates } from '../scrum/stages/sprintPlanCandidates';
import { draftSprintPlanNarrative } from '../scrum/stages/draftSprintPlanNarrative';
import { mapReleaseIssue, buildReleaseSummaryReport, buildReleaseSignOffNote, writeReleaseSummaryReports } from '../scrum/stages/releaseSummary';
import { loadScrumConfig, saveScrumConfig, applyScrumSettingUpdate, SCRUM_CONFIG_PATH } from '../config/scrumConfigStore';
import {
  buildStandupDigestReport,
  writeStandupDigestReports,
  StandupDigestDeliveryConfig,
  planStandupDigestDelivery,
  buildAssigneeEmailMap,
  buildStandupDigestSlackMessage,
} from '../scrum/stages/standupDigest';
import {
  buildBlockerScanReport,
  writeBlockerScanReports,
  buildBlockerEscalationComment,
  buildBlockerEscalationSlackMessage,
  assertSupportedChannel,
  BlockerEscalationAttempt,
} from '../scrum/stages/blockerScan';
import { getEmailClient, buildBlockerEscalationEmail } from '../email/emailClient';
import {
  buildGroomCheckFetchReport,
  writeGroomCheckFetchReports,
  buildGroomCheckComment,
  GroomCheckTicket,
} from '../scrum/stages/groomCheck';
import {
  buildRetroNotesFetchReport,
  writeRetroNotesFetchReports,
  findVcsActivityForTicket,
  buildRetroNotesFile,
  writeRetroNotesFile,
  RetroNotesTicket,
} from '../scrum/stages/retroNotes';
import { readScrumDashboardData, writeScrumDashboardReports } from '../scrum/stages/scrumDashboard';
import { buildCoverageReport, writeCoverageReports } from '../scrum/stages/coverageReport';

interface CliArgs {
  stage: string;
  tenant?: string;
  issue?: string;
  file?: string;
  spec?: string;
  scenarioId?: string;
  status?: string;
  comment?: string;
  runFile?: string;
  transitionId?: string;
  testFile?: string;
  // Disambiguates which test(...) within --test-file to act on, when the file holds more than one
  // (see src/pipeline/shared/testBlocks.ts). Takes the test's own literal title (the string passed
  // to test(...)) - not the spec's kebab-case scenario id (that's --scenario-id, a separate,
  // pre-existing flag for a different purpose: matching a case in a tms-upload run record).
  // --test-title is for these manual/CLI-driven stages specifically because they operate directly
  // on an already-written file with no spec context, so the test's own title is the only
  // identifier that's always present - unlike the spec-driven path (buildEntriesForSpec), which
  // already resolves this automatically via the "// scenario-id: <id>" marker convention.
  testTitle?: string;
  attempt?: string;
  outcome?: string;
  category?: string;
  externalCaseId?: string;
  durationMs?: string;
  baseSha?: string;
  agent?: string;
  event?: string;
  log?: string;
  markers?: string;
  results?: string;
  gapsFile?: string;
  // --force true - only meaningful for --stage traceability-unlink so far. Must be the literal
  // string "true"; anything else (including present-but-empty, since this parser always consumes
  // the next token as a flag's value) is treated as not forced - see stageTraceabilityUnlink for
  // why this exists.
  force?: string;
  // Destination path for --stage rename-spec-file - the file --test-file should be renamed to.
  // Kept as its own flag rather than overloading --test-file with a second value, since every
  // other stage already treats --test-file as "the one file this stage acts on" (singular).
  newPath?: string;
  // --stage retro-notes-post's target sprint - a string here (parsed/validated to a real integer
  // at the call site, same "parse at the point of use" convention as every other CliArgs numeric
  // flag in this file), since retro-notes has no single ticket to key off of the way
  // groom-check-flag's --issue does.
  sprintId?: string;
  // Points at a plain-text file holding the live-synthesized retro notes (what went well, what
  // didn't, action items) - a CLI flag rather than inlining the text directly, same file-handoff
  // reasoning as --gaps-file (shell-quoting problems across bash/PowerShell for free-text
  // content). Unlike --gaps-file, this is read as raw text, not JSON - retro-notes-post has no
  // structured shape to parse, it is a dumb poster for whatever prose the live synthesis step
  // produced.
  notesFile?: string;
  // --stage flag-requirement-gaps-headless's model override (headlessJudge.ts's
  // MODEL_PRICING keys) - defaults to DEFAULT_MODEL (Haiku 4.5) when omitted. Exists so the
  // spike can compare accuracy/cost across models on the same ticket without a code change.
  model?: string;
  // --stage settings-update's target field (e.g. "storyPointsField" or
  // "blockerEscalation.idleDaysThreshold") - validated against SCRUM_SETTING_KEYS
  // (scrumConfigStore.ts), not trusted as-is here. Named to match the workflow_dispatch input it
  // carries 1:1 (settings-update.yml's `setting` choice), same "CLI flag mirrors the caller's own
  // vocabulary" convention as --sprint-id/--notes-file above.
  setting?: string;
  // --stage settings-update's new raw value, always a string here regardless of the target
  // field's real type - GitHub Actions workflow_dispatch has no numeric input type, so the actual
  // type coercion (and rejection of a value that doesn't parse) happens inside
  // applyScrumSettingUpdate(), not in this CLI layer.
  value?: string;
  // --stage ask's plain-language question (askEngine.ts) - free text, so must be shell-quoted by
  // the caller (e.g. --question "what's blocking the sprint"), same as --comment/--notes-file.
  // Reuses --model (already defined above for flag-requirement-gaps-headless) for its own optional
  // model override, rather than a second, redundant flag name.
  question?: string;
  // --stage release-summary's target fixVersion (Phase E) - free text (Jira fixVersion names are
  // human-chosen, e.g. "2026.09" or "Release 1.0 (GA)"), so must be shell-quoted by the caller,
  // same reasoning as --question above.
  fixVersion?: string;
  // Manual-Tester Agent stages: --persona <id> (dogfood-run), --ticket <KEY> (ticket-verify*),
  // --session <path> (dogfood-approve/-file). Free text, same file-handoff/flag style as the rest.
  persona?: string;
  ticket?: string;
  session?: string;
  suite?: string;
  group?: string;
}

const TMS_RESULT_STATUSES: TmsResultStatus[] = ['passed', 'failed', 'blocked', 'skipped'];

function parseArgs(argv: string[]): CliArgs {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      args[token.slice(2)] = argv[i + 1];
      i += 1;
    }
  }
  return {
    stage: args.stage ?? '',
    tenant: args.tenant,
    issue: args.issue,
    file: args.file,
    spec: args.spec,
    scenarioId: args['scenario-id'],
    status: args.status,
    comment: args.comment,
    runFile: args['run-file'],
    transitionId: args['transition-id'],
    testFile: args['test-file'],
    testTitle: args['test-title'],
    attempt: args.attempt,
    outcome: args.outcome,
    category: args.category,
    // --external-case-id is the current flag; --qase-case-id is a deprecated alias for it.
    externalCaseId: args['external-case-id'] ?? args['qase-case-id'],
    durationMs: args['duration-ms'],
    baseSha: args['base-sha'],
    agent: args.agent,
    event: args.event,
    log: args.log,
    markers: args.markers,
    results: args.results,
    // Points at a JSON file containing a string[] of gap descriptions - a CLI flag rather than
    // inlining JSON directly avoids shell-quoting problems (this project is used from both bash
    // and PowerShell, and free-text gap descriptions can contain quotes, commas, etc.). Same
    // file-handoff pattern as --spec/--run-file elsewhere in this parser.
    gapsFile: args['gaps-file'],
    force: args.force,
    newPath: args['new-path'],
    sprintId: args['sprint-id'],
    notesFile: args['notes-file'],
    model: args.model,
    setting: args.setting,
    value: args.value,
    question: args.question,
    fixVersion: args['fix-version'],
    persona: args.persona,
    ticket: args.ticket,
    session: args.session,
    suite: args.suite,
    group: args.group,
  };
}

async function stageJira(issueKey: string) {
  const jira = await getJiraClient();
  const issue = await jira.getIssue(issueKey);
  return jira.extractDescription(issue);
}

/**
 * Hard rule, not a prompt-followed convention: throws unless a human has recorded the given
 * approval gate for this jiraKey via --stage approve-scenarios/approve-test-cases. Callers cannot
 * talk their way past this by being asked to "just run everything" - the check is against a
 * timestamp that only exists on disk if that stage was actually run.
 */
function assertGateApproved(
  manifest: TraceabilityManifest,
  jiraKey: string,
  field: 'requirementsClearedAt' | 'scenariosApprovedAt' | 'testCasesApprovedAt',
  gateLabel: string,
  approveCommand: string,
): void {
  const record = findWorkflowRecord(manifest.workflow, jiraKey);
  if (!record?.[field]) {
    throw new Error(
      `${gateLabel} has not been recorded for ${jiraKey}. This is a hard gate, not something a ` +
      `prompt can skip - run "${approveCommand}" once a human has actually reviewed and ` +
      'approved, then retry.',
    );
  }
}

/**
 * Gate 0: records the Planning Agent's own pre-generation assessment of whether the raw Jira
 * requirement was clear enough to generate scenarios from. Called with no --gaps-file (or one
 * containing an empty array) when the agent found the ticket clear - that immediately clears the
 * gate. Called with a populated gaps file when it found real ambiguity - that leaves the gate
 * unset (blocking --stage excel-write) and posts the findings back to the ticket itself, so the
 * ticket author sees exactly what's missing without needing pipeline access. Re-running this
 * stage after the ticket is updated re-evaluates from scratch; it does not accumulate gaps across
 * runs, since a stale unresolved gap from an earlier run would otherwise block forever even after
 * the ticket was fixed.
 */
async function stageFlagRequirementGaps(issue: string, gapsFilePath?: string): Promise<void> {
  // .replace(/^﻿/, '') strips a leading UTF-8 BOM - confirmed empirically that Windows
  // PowerShell's `Set-Content -Encoding utf8` (the natural way to produce this file on this
  // project's primary dev platform) writes one by default, and JSON.parse doesn't tolerate it.
  const descriptions: string[] = gapsFilePath
    ? (JSON.parse(fs.readFileSync(gapsFilePath, 'utf-8').replace(/^﻿/, '')) as string[])
    : [];
  const gaps: RequirementGap[] = descriptions.map((description) => ({ description }));

  const manifest = loadManifest();
  const now = new Date().toISOString();
  const operator = resolveOperator(await resolveTenantEnv('PIPELINE_OPERATOR'), await resolveTenantEnv('JIRA_EMAIL'));
  const nextWorkflow = upsertWorkflowRecord(manifest.workflow, {
    tenantId: getTenantId(),
    jiraKey: issue,
    requirementGapsCheckedAt: now,
    requirementGaps: gaps,
    requirementsClearedAt: gaps.length === 0 ? now : undefined,
    requirementsClearedBy: gaps.length === 0 ? operator : undefined,
  });
  saveManifest({ workflow: nextWorkflow, entries: manifest.entries });

  if (gaps.length === 0) {
    console.log(`Gate 0 cleared: no requirement gaps found for ${issue}.`);
    return;
  }

  console.log(`Gate 0 BLOCKED: ${gaps.length} requirement gap(s) found for ${issue}:`);
  for (const gap of gaps) console.log(`  - ${gap.description}`);
  console.log(
    `Scenario generation cannot proceed to --stage excel-write until this is resolved - update ` +
    'the Jira ticket and re-run --stage flag-requirement-gaps, or override with "npm run ' +
    `pipeline -- --stage approve-requirements --issue ${issue}" once a human has confirmed it's ` +
    'fine to proceed as-is.',
  );

  const jira = await getJiraClient();
  await jira.addComment(issue, buildRequirementGapComment(gaps));
  console.log(`Posted requirement-gap comment to ${issue}.`);
}

/** Human override for Gate 0 - see stageFlagRequirementGaps for the automatic path. */
async function stageApproveRequirements(issue: string): Promise<void> {
  const manifest = loadManifest();
  const nextWorkflow = upsertWorkflowRecord(manifest.workflow, {
    tenantId: getTenantId(),
    jiraKey: issue,
    requirementsClearedAt: new Date().toISOString(),
    requirementsClearedBy: resolveOperator(await resolveTenantEnv('PIPELINE_OPERATOR'), await resolveTenantEnv('JIRA_EMAIL')),
  });
  saveManifest({ workflow: nextWorkflow, entries: manifest.entries });
  console.log(`Gate 0 recorded: requirements cleared (human override) for ${issue}`);
}

/**
 * Gate 0 headless-agent-cost spike - same judgment stageFlagRequirementGaps() above expects a
 * human (via an interactive Planning Agent session) to have already written to a --gaps-file, but
 * produced instead by one real Anthropic Messages API call (headlessJudge.ts), with real
 * input/output token usage and cost captured into this project's existing cost-accounting
 * pipeline (recordCostEvents.ts's CostEvent - the same schema --stage cost-marker/cost-report
 * already populate, so this shows up in `npm run cost:report` for free instead of needing a
 * parallel reporting path).
 *
 * Deliberately reuses stageFlagRequirementGaps() unchanged for every downstream effect (manifest
 * write, gate block/clear, Jira comment, approve-requirements override) by writing the API's gap
 * list to the same --gaps-file JSON shape a human would have written by hand and calling straight
 * into it - this stage's only real job is producing that string[], not re-implementing anything
 * stageFlagRequirementGaps() already does correctly.
 */
async function stageFlagRequirementGapsHeadless(issue: string, modelOverride?: string): Promise<void> {
  const modelToUse = modelOverride ?? DEFAULT_MODEL;
  const jira = await getJiraClient();
  const rawIssue = await jira.getIssue(issue);
  const ticket = jira.extractDescription(rawIssue);

  const result = await judgeRequirementClarity(ticket, modelToUse);

  console.log(
    `Gate 0 headless judge (${result.model}) for ${issue}: ${result.inputTokens} input / ` +
    `${result.outputTokens} output tokens, $${result.costUsd.toFixed(5)}, ${result.wallClockMs}ms.`,
  );

  appendCostEvents([
    {
      tenantId: getTenantId(),
      timestamp: new Date().toISOString(),
      agent: 'gate0-headless-judge',
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: result.costUsd,
      wallClockMs: result.wallClockMs,
      jiraKey: issue,
    },
  ]);

  const tempGapsFile = path.join(
    tenantDataPath('cost', 'raw'),
    `gate0-headless-gaps-${issue}-${Date.now()}.json`,
  );
  fs.mkdirSync(path.dirname(tempGapsFile), { recursive: true });
  fs.writeFileSync(tempGapsFile, JSON.stringify(result.gaps), 'utf-8');
  try {
    await stageFlagRequirementGaps(issue, tempGapsFile);
  } finally {
    fs.rmSync(tempGapsFile, { force: true });
  }
}

/**
 * --stage ask: plain-language question -> real report data narrated conversationally
 * (askEngine.ts - see that file's header comment for the full "why this exists, why it reads
 * existing report files instead of re-fetching or re-running a stage" reasoning). Two real LLM
 * calls (classify, then narrate) - both real dispatches, both cost-recorded, same as every other
 * live LLM call in this pipeline (contrast: never logged as a single blended cost, since a
 * classification call and a narration call have genuinely different token profiles worth seeing
 * separately in --stage cost-report).
 */
async function stageAsk(question: string, modelOverride?: string): Promise<void> {
  const modelToUse = modelOverride ?? DEFAULT_MODEL;
  const result = await answerQuestion(question, modelToUse);

  console.log(result.answer);
  console.log('');
  if (result.reportsUsed.length > 0) {
    console.log(`(based on: ${result.reportsUsed.join(', ')})`);
  }
  if (result.reportsRequestedButMissing.length > 0) {
    console.log(`(not yet available: ${result.reportsRequestedButMissing.join(', ')})`);
  }
  console.log(
    `[classify: $${result.classify.costUsd.toFixed(5)}, ${result.classify.wallClockMs}ms] ` +
    `[narrate: $${result.narrate.costUsd.toFixed(5)}, ${result.narrate.wallClockMs}ms]`,
  );

  const timestamp = new Date().toISOString();
  const events = [
    {
      tenantId: getTenantId(),
      timestamp,
      agent: 'ask-classify',
      model: result.classify.model,
      inputTokens: result.classify.inputTokens,
      outputTokens: result.classify.outputTokens,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: result.classify.costUsd,
      wallClockMs: result.classify.wallClockMs,
    },
  ];
  // narrate is skipped (all-zero AskLlmCallResult) when classify found nothing relevant or every
  // matched report was missing - don't record a zero-cost, zero-token event for a call that never
  // actually happened.
  if (result.narrate.inputTokens > 0 || result.narrate.outputTokens > 0) {
    events.push({
      tenantId: getTenantId(),
      timestamp,
      agent: 'ask-narrate',
      model: result.narrate.model,
      inputTokens: result.narrate.inputTokens,
      outputTokens: result.narrate.outputTokens,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: result.narrate.costUsd,
      wallClockMs: result.narrate.wallClockMs,
    });
  }
  appendCostEvents(events);
}

/**
 * --stage draft-story (Phase C, "AI-Assisted Scrum and SDLC Console - Development Plan,"
 * docs/planning/) - the genuinely new AI judgment work that plan's Section 5 describes: draft a
 * user story + acceptance criteria from a Jira Epic (draftStory.ts, one real Anthropic call, same
 * cost-recording shape as Gate 0's headless judge above), then hand it to the AI Queue
 * (queueClient.ts, backend/'s Phase A/B work) as a SUGGESTED item for a Product Owner to review -
 * this stage never writes to Jira itself, and never registers anything as a real ticket. Reads the
 * epic via the existing JiraClient: an Epic is just another Jira issue key, so getIssue()/
 * extractDescription() already work for one - no new read adapter needed, despite the dev plan's
 * own estimate that reading an Epic would require one.
 */
async function stageDraftStory(epicKey: string, modelOverride?: string): Promise<void> {
  const modelToUse = modelOverride ?? DEFAULT_MODEL;
  const jira = await getJiraClient();
  const rawIssue = await jira.getIssue(epicKey);
  const epic = jira.extractDescription(rawIssue);

  const result = await draftStoryFromEpic(epic, modelToUse);

  console.log(
    `Draft story from epic ${epicKey} (${result.model}): "${result.title}" - ` +
    `${result.inputTokens} input / ${result.outputTokens} output tokens, ` +
    `$${result.costUsd.toFixed(5)}, ${result.wallClockMs}ms.`,
  );
  console.log(`  ${result.description}`);
  for (const criterion of result.acceptanceCriteria) console.log(`  - ${criterion}`);

  appendCostEvents([
    {
      tenantId: getTenantId(),
      timestamp: new Date().toISOString(),
      agent: 'draft-story',
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: result.costUsd,
      wallClockMs: result.wallClockMs,
      jiraKey: epicKey,
    },
  ]);

  const queueItem = await createQueueItem({
    type: 'SUGGESTED',
    sourceStage: 'stories',
    payload: {
      epicKey,
      title: result.title,
      description: result.description,
      acceptanceCriteria: result.acceptanceCriteria,
    },
  });
  console.log(
    `Queued for Product Owner review: QueueItem ${queueItem.id} (state: ${queueItem.state}). ` +
    'Nothing has been registered as a real Jira ticket yet - Phase D (Tickets auto-registration, ' +
    'not yet built) is what turns an approved queue item into one, per the dev plan.',
  );
}

// How many of a board's most recent CLOSED sprints feed the velocity average - see
// AgileClient.getClosedSprints()'s own doc comment for why this is capped at all, and
// velocityReport.ts's header comment for why this is velocity-only (capacity/Tempo is explicitly
// out of scope). Not a scrum.json setting (yet) - kept a plain constant for this first pass,
// consistent with the dev plan's own explicit "velocity half only" scoping for this PR; promote
// it to a SCRUM_SETTING_REGISTRY entry later if a tenant ever needs a different window.
const SPRINT_PLAN_VELOCITY_WINDOW = 6;

/**
 * --stage draft-sprint-plan (Sprint plan, VELOCITY HALF ONLY - "AI-Assisted Scrum and SDLC
 * Console - Development Plan," docs/planning/, Phase C's other half). Capacity/Tempo integration
 * is explicitly NOT built here - deferred pending the repo owner's own Tempo-vs-manual-input
 * decision - so this stage answers "what does this board's own recent velocity support," never
 * "what does the team have available." See velocityReport.ts/sprintPlanCandidates.ts/
 * draftSprintPlanNarrative.ts's own header comments for the full reuse/compute-vs-narrate design.
 *
 * For each configured board: (1) fetches its last SPRINT_PLAN_VELOCITY_WINDOW closed sprints and
 * computes average velocity by reusing buildSprintStatusReport()'s own categorization (same reuse
 * discipline burndown-report already follows - no point-summing logic is re-derived here); (2)
 * finds every not-yet-started ("future") sprint on that board - i.e. whatever a human has already
 * drafted into it via Jira's own UI - and deterministically (no LLM) selects which of its issues
 * fit inside the velocity-derived point budget; (3) makes one real Anthropic call whose only job
 * is to narrate that already-computed selection in prose, never to recompute it; (4) queues the
 * result as a NEEDS_SESSION AI Queue item (not SUGGESTED like draft-story - the dev plan's own
 * framing for sprint plans is "team confirms via the queue," a heavier bar than a single Product
 * Owner reviewing one drafted story) for the team to confirm before anything changes in Jira. This
 * stage never writes to Jira - it only ever reads sprints/issues and posts to the AI Queue.
 */
async function stageDraftSprintPlan(modelOverride?: string): Promise<void> {
  const modelToUse = modelOverride ?? DEFAULT_MODEL;
  const scrumConfig = loadScrumConfig();
  const boardIds = scrumConfig.boardIds;
  const storyPointsField = scrumConfig.storyPointsField ?? null;
  const agile = await getAgileClient();

  if (boardIds.length === 0) {
    console.log('No boards configured (scrum.json boardIds) - nothing to plan.');
    return;
  }

  let queuedCount = 0;

  for (const boardId of boardIds) {
    const closedSprints = await agile.getClosedSprints(boardId, SPRINT_PLAN_VELOCITY_WINDOW);
    const closedBoardSprints: SprintStatusBoardSprint[] = [];
    for (const sprint of closedSprints) {
      const issues = await agile.getSprintIssues(sprint.id, storyPointsField ?? '');
      closedBoardSprints.push({ boardId, sprint, issues });
    }
    const closedStatusReport = buildSprintStatusReport(boardIds, closedBoardSprints, storyPointsField);
    const velocity = buildBoardVelocityReport(boardId, closedStatusReport.sprints, storyPointsField);

    if (velocity.averageVelocity === null) {
      console.log(
        `Board ${boardId}: no velocity available (${storyPointsField === null ? 'storyPointsField not configured' : 'no closed sprints found'
        }) - skipping.`,
      );
      continue;
    }

    const futureSprints = (await agile.getActiveAndFutureSprints(boardId)).filter((s) => s.state === 'future');
    if (futureSprints.length === 0) {
      console.log(`Board ${boardId}: no future (not-yet-started) sprint found - nothing to plan against.`);
      continue;
    }

    for (const futureSprint of futureSprints) {
      const candidateIssues = await agile.getSprintIssues(futureSprint.id, storyPointsField ?? '');
      const selection = selectSprintPlanCandidates(candidateIssues, velocity.averageVelocity);

      const narrativeResult = await draftSprintPlanNarrative(
        {
          boardId,
          futureSprintName: futureSprint.name,
          averageVelocity: velocity.averageVelocity,
          closedSprintsUsed: velocity.closedSprints.length,
          pointBudget: selection.pointBudget,
          selected: selection.selected,
          deferred: selection.deferred,
          selectedStoryPoints: selection.selectedStoryPoints,
          unestimatedCandidateCount: selection.unestimatedCandidateCount,
        },
        modelToUse,
      );

      console.log(
        `Sprint plan for board ${boardId} / ${futureSprint.name}: velocity ${velocity.averageVelocity} pts ` +
        `(avg of ${velocity.closedSprints.length} closed sprint(s)), ${selection.selected.length} issue(s) ` +
        `selected (${selection.selectedStoryPoints} pts), ${selection.deferred.length} deferred ` +
        `(${selection.unestimatedCandidateCount} unestimated). ${narrativeResult.model}: ` +
        `${narrativeResult.inputTokens} input / ${narrativeResult.outputTokens} output tokens, ` +
        `$${narrativeResult.costUsd.toFixed(5)}, ${narrativeResult.wallClockMs}ms.`,
      );
      console.log(`  ${narrativeResult.narrative}`);

      appendCostEvents([
        {
          tenantId: getTenantId(),
          timestamp: new Date().toISOString(),
          agent: 'draft-sprint-plan',
          model: narrativeResult.model,
          inputTokens: narrativeResult.inputTokens,
          outputTokens: narrativeResult.outputTokens,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costUsd: narrativeResult.costUsd,
          wallClockMs: narrativeResult.wallClockMs,
        },
      ]);

      const queueItem = await createQueueItem({
        type: 'NEEDS_SESSION',
        sourceStage: 'sprint-plan',
        payload: {
          boardId,
          sprintId: futureSprint.id,
          sprintName: futureSprint.name,
          averageVelocity: velocity.averageVelocity,
          closedSprintsUsed: velocity.closedSprints.length,
          pointBudget: selection.pointBudget,
          selected: selection.selected.map((i) => ({ key: i.key, summary: i.summary, storyPoints: i.storyPoints })),
          deferred: selection.deferred.map((i) => ({ key: i.key, summary: i.summary, storyPoints: i.storyPoints })),
          selectedStoryPoints: selection.selectedStoryPoints,
          unestimatedCandidateCount: selection.unestimatedCandidateCount,
          narrative: narrativeResult.narrative,
        },
      });
      queuedCount += 1;
      console.log(
        `Queued for team confirmation: QueueItem ${queueItem.id} (state: ${queueItem.state}). ` +
        'Velocity only - capacity/availability was not factored in (Tempo integration is not yet built).',
      );
    }
  }

  if (queuedCount === 0) {
    console.log('No sprint plan suggestions were queued this run (see per-board notes above for why).');
  }
}

/**
 * --stage release-summary (Phase E, "AI-Assisted Scrum and SDLC Console - Development Plan,"
 * docs/planning/) - "Release Stage," deliberately built last and deliberately the most
 * conservative stage in this whole program, per the source deck's own "highest caution" label.
 * READ-ONLY: fetches every issue tagged with the given fixVersion (JiraClient.searchByFixVersion(),
 * a plain JQL search - core REST API v3, not the Agile API), summarizes done/not-done status, and
 * queues the result as a NEEDS_SESSION AI Queue item for a real Release Owner sign-off. This
 * function never sets a fixVersion, never transitions an issue, and never talks to a deploy tool -
 * see releaseSummary.ts's own header comment for the full "read-only by design" reasoning. There is
 * deliberately no corresponding fileJira*-style resolve action for this sourceStage (unlike
 * stories/defects) - Release has nothing to file; the sign-off itself (Approve/Reject/Dismiss on
 * the AI Queue dashboard) IS the entire owner action this stage supports.
 */
async function stageReleaseSummary(fixVersion: string): Promise<void> {
  const jira = await getJiraClient();
  const rawIssues = await jira.searchByFixVersion(fixVersion);
  const issues = rawIssues.map(mapReleaseIssue);
  const report = buildReleaseSummaryReport(fixVersion, issues);
  const { reportJsonPath, reportMdPath } = writeReleaseSummaryReports(report);

  const note = buildReleaseSignOffNote(report);
  console.log(note);
  console.log(`Reports written to ${reportJsonPath} and ${reportMdPath}`);

  const queueItem = await createQueueItem({
    type: 'NEEDS_SESSION',
    sourceStage: 'release',
    payload: {
      fixVersion,
      totalIssueCount: report.totalIssueCount,
      byStatusCategory: report.byStatusCategory,
      notDoneIssues: report.notDoneIssues,
      readyForRelease: report.readyForRelease,
      zeroIssuesFound: report.zeroIssuesFound,
      note,
    },
  });
  console.log(
    `Queued for Release Owner sign-off: QueueItem ${queueItem.id} (state: ${queueItem.state}). ` +
    'This stage is READ-ONLY - it never sets a fixVersion, transitions an issue, or triggers a ' +
    'release; it only informs a human sign-off decision made via the AI Queue.',
  );
}

async function stageApproveScenarios(issue: string): Promise<void> {
  const manifest = loadManifest();
  const nextWorkflow = upsertWorkflowRecord(manifest.workflow, {
    tenantId: getTenantId(),
    jiraKey: issue,
    scenariosApprovedAt: new Date().toISOString(),
    scenariosApprovedBy: resolveOperator(await resolveTenantEnv('PIPELINE_OPERATOR'), await resolveTenantEnv('JIRA_EMAIL')),
  });
  saveManifest({ workflow: nextWorkflow, entries: manifest.entries });
  console.log(`Gate 1 recorded: scenarios approved for ${issue}`);
}

async function stageApproveTestCases(issue: string): Promise<void> {
  const manifest = loadManifest();
  const existing = findWorkflowRecord(manifest.workflow, issue);
  if (!existing?.scenariosApprovedAt) {
    throw new Error(
      `Cannot approve test cases for ${issue} - Gate 1 (scenario approval) has not been recorded ` +
      `yet. Run "npm run pipeline -- --stage approve-scenarios --issue ${issue}" first.`,
    );
  }
  const nextWorkflow = upsertWorkflowRecord(manifest.workflow, {
    tenantId: getTenantId(),
    jiraKey: issue,
    testCasesApprovedAt: new Date().toISOString(),
    testCasesApprovedBy: resolveOperator(await resolveTenantEnv('PIPELINE_OPERATOR'), await resolveTenantEnv('JIRA_EMAIL')),
  });
  saveManifest({ workflow: nextWorkflow, entries: manifest.entries });
  console.log(`Gate 2 recorded: test cases approved for ${issue}`);
}

async function stageExcelWrite(specFilePath: string): Promise<string> {
  const jiraKey = parseJiraKeyFromSpec(specFilePath);
  if (!jiraKey) {
    throw new Error(
      `${specFilePath} has no "<!-- Jira: KEY -->" marker - cannot verify Gate 1 (scenario ` +
      'approval) without knowing which Jira story it belongs to.',
    );
  }
  const manifest = loadManifest();
  assertGateApproved(
    manifest,
    jiraKey,
    'requirementsClearedAt',
    'Gate 0 (requirement gap check)',
    `npm run pipeline -- --stage flag-requirement-gaps --issue ${jiraKey} (or --stage approve-requirements --issue ${jiraKey} to override)`,
  );
  assertGateApproved(
    manifest,
    jiraKey,
    'scenariosApprovedAt',
    'Gate 1 (scenario approval)',
    `npm run pipeline -- --stage approve-scenarios --issue ${jiraKey}`,
  );

  const scenarios = assignDisplayIds(jiraKey, parseScenariosFromSpec(specFilePath));
  const outPath = tenantDataPath(env.OUTPUT_DIR, buildScenarioFileName(jiraKey, specFilePath));
  const filePath = await writeScenarios(scenarios, outPath);
  console.log(`Wrote ${scenarios.length} scenarios from ${specFilePath} to ${filePath}`);
  return filePath;
}

async function stageTmsUpload(
  scenarios: Scenario[],
  source: string,
  jiraKey: string,
  suiteTitle: string,
): Promise<void> {
  // suiteTitle is resolved by the caller (resolveSuiteTitle: --suite flag > the spec's
  // `<!-- Suite: X -->` marker > the Jira key). It is the top-level Suite every case here is filed
  // under; each scenario's own `suite` (its spec's "### N. <group>" heading) becomes a sub-suite
  // nested beneath it. Deliberately NOT the Jira summary any more - that changed per ticket/edit and
  // scattered cases across one-off summary-named suites, and a fetch failure silently filed them
  // under no suite at all. The Jira key is always available at the Gate 2 check, so a case is never
  // created suite-less.
  console.log(`Filing cases under TMS suite "${suiteTitle}" (scenario groups become sub-suites).`);
  const tms = await getTestManagementClient();
  const tmsProvider = resolveTmsProvider(env.TMS_PROVIDER);
  const withIds = await tms.bulkCreateCases(scenarios, { suiteTitle });
  const runId = await tms.createRun(withIds.map((s) => s.externalCaseId));

  const record: TmsRunRecord = {
    provider: tmsProvider,
    jiraKey,
    runId,
    cases: withIds.map((s) => ({ id: s.id, title: s.title, externalCaseId: s.externalCaseId })),
  };
  const runFilePath = buildRunFilePath(jiraKey);
  fs.mkdirSync(path.dirname(runFilePath), { recursive: true });
  fs.writeFileSync(runFilePath, JSON.stringify(record, null, 2), 'utf-8');

  console.log(`Uploaded ${withIds.length} cases from ${source} to ${tmsProvider} and created run ${runId}`);
  console.log(`Run/case ids saved to ${runFilePath} for later --stage tms-submit-result --issue ${jiraKey} calls`);
}

async function stageTmsSubmitResult(
  runFile: string,
  scenarioId: string,
  status: TmsResultStatus,
  comment?: string,
): Promise<void> {
  const record = JSON.parse(fs.readFileSync(runFile, 'utf-8')) as TmsRunRecord;
  const match = record.cases.find((c) => c.id === scenarioId);
  if (!match) {
    throw new Error(`No case with scenario id "${scenarioId}" found in ${runFile}`);
  }

  const tms = await getTestManagementClient();
  tms.setActiveRun(record.runId);
  await tms.submitResult({ caseId: match.externalCaseId, status, comment });
  console.log(`Submitted "${status}" for ${scenarioId} (case ${match.externalCaseId}, run ${record.runId})`);
}

async function stageTraceabilityRecord(specFilePath: string, runFile: string): Promise<void> {
  if (!fs.existsSync(runFile)) {
    throw new Error(`${runFile} not found - run --stage tms-upload for this spec first.`);
  }
  const runRecord: TmsRunRecord = JSON.parse(fs.readFileSync(runFile, 'utf-8'));
  const tms = await getTestManagementClient();
  const { entries, skipped } = await buildEntriesForSpec(specFilePath, runRecord, tms);

  const manifest = loadManifest();
  let nextEntries = manifest.entries;
  for (const entry of entries) {
    nextEntries = upsertEntry(nextEntries, entry);
  }
  saveManifest({ workflow: manifest.workflow, entries: nextEntries });

  console.log(
    `Recorded ${entries.length} baseline traceability ${entries.length === 1 ? 'entry' : 'entries'} for ${specFilePath} in ${tenantDataPath('traceability', 'manifest.json')}`,
  );
  if (skipped.length > 0) {
    console.log(`Skipped ${skipped.length}:`);
    for (const reason of skipped) console.log(`  - ${reason}`);
  }
}

/**
 * testTitle (--test-title) disambiguates which test(...) block to hash when testFilePath holds
 * more than one - optional because it's only ever needed then (see resolveTestBlockForFile below).
 */
async function stageTraceabilityUpdateBaseline(testFilePath: string, testTitle?: string): Promise<void> {
  if (!fs.existsSync(testFilePath)) {
    throw new Error(`${testFilePath} does not exist`);
  }
  const source = fs.readFileSync(testFilePath, 'utf-8');
  const block = resolveTestBlockForFile(testFilePath, source, testTitle);
  const testContentHash = await hashScenarioTestBlock(block.source);
  const testLastModified = fs.statSync(testFilePath).mtime.toISOString();

  const manifest = loadManifest();
  const nextEntries = updateTestBaseline(
    manifest.entries,
    testFilePath,
    testContentHash,
    testLastModified,
    block.testTitle,
  );
  saveManifest({ workflow: manifest.workflow, entries: nextEntries });

  console.log(`Updated traceability baseline testContentHash for ${testFilePath} (test "${block.testTitle}")`);
}

/**
 * Resolves exactly which test(...) block in `source` a traceability or flaky/quarantine CLI call
 * is about, given whatever the caller already knows: an explicit --test-title, or nothing at all.
 * Deterministic-only, same as resolveTestBlock in shared/testBlocks.ts - throws with an actionable
 * message rather than guessing when the file holds more than one test and there's nothing to
 * disambiguate with, since silently hashing/linking/quarantining the wrong one would corrupt that
 * scenario's tracked state.
 */
function resolveTestBlockForFile(testFilePath: string, source: string, testTitle?: string) {
  const blocks = findTestBlocks(source, testFilePath);
  if (blocks.length === 0) {
    throw new Error(`No test(...) found in ${testFilePath} - nothing to hash.`);
  }
  if (testTitle !== undefined) {
    const matches = blocks.filter((b) => b.testTitle === testTitle);
    if (matches.length !== 1) {
      throw new Error(
        `${testFilePath} has ${matches.length} test(...) block(s) titled "${testTitle}" (expected exactly 1).`,
      );
    }
    return matches[0];
  }
  if (blocks.length === 1) return blocks[0];
  throw new Error(
    `${testFilePath} has ${blocks.length} test(...) blocks - pass --test-title "<exact test name>" to say which one.`,
  );
}

/**
 * Lightweight manual remediation for traceability entries that never went through the normal
 * generation flow - see README's Team Usage section. Two real scenarios this covers, both of
 * which leave a test with no manifest entry and therefore invisible to drift-check:
 *   1. Someone hand-writes and automates a test directly against an existing TMS case, bypassing
 *      Jira/scenario-generation/tms-upload entirely.
 *   2. A test case created directly in the TMS (no scenario/spec behind it, originally manual)
 *      later gets automated.
 * Unlike --stage traceability-record, this needs no spec file and no tms-upload run record - just
 * the three things that already exist in both scenarios above: the Jira key, the TMS case id, and
 * the already-written test file. Computes the same IN_SYNC baseline hashes buildEntriesForSpec()
 * would have computed had this gone through the normal flow, so drift-check treats it identically
 * to a pipeline-generated entry from this point on.
 */
async function stageTraceabilityLink(
  issue: string,
  externalCaseId: string,
  testFilePath: string,
  testTitle?: string,
): Promise<void> {
  if (!fs.existsSync(testFilePath)) {
    throw new Error(
      `${testFilePath} does not exist - traceability-link needs a real, already-written test ` +
      'file to hash; it does not generate one.',
    );
  }

  const tms = await getTestManagementClient();
  const tmsProvider = resolveTmsProvider(env.TMS_PROVIDER);
  const caseDetail = await tms.getCase(externalCaseId);
  const externalCaseHash = hashCase(caseDetail);
  const testSource = fs.readFileSync(testFilePath, 'utf-8');
  const block = resolveTestBlockForFile(testFilePath, testSource, testTitle);
  const testContentHash = await hashScenarioTestBlock(block.source);
  const testLastModified = fs.statSync(testFilePath).mtime.toISOString();
  const now = new Date().toISOString();

  const manifest = loadManifest();
  const nextEntries = upsertEntry(manifest.entries, {
    jiraKey: issue,
    externalCaseId,
    externalCaseHash,
    externalCaseUpdatedAt: caseDetail.updatedAt ?? now,
    tmsProvider: tmsProvider,
    testFilePath,
    testTitle: block.testTitle,
    testContentHash,
    testLastModified,
    syncState: 'IN_SYNC',
    lastCheckedAt: now,
  });
  saveManifest({ workflow: manifest.workflow, entries: nextEntries });

  console.log(
    `Linked ${testFilePath} (test "${block.testTitle}") <-> ${tmsProvider} case ${externalCaseId} <-> ${issue} in ` +
    `${tenantDataPath('traceability', 'manifest.json')} (IN_SYNC baseline recorded - drift-check will track it from here on).`,
  );
}

/**
 * Removes one stale entry from traceability/manifest.json - the remediation this project's own
 * readiness assessment flagged as missing (Section 10, "No CLI command exists to remove a stale
 * traceability entry"), reproduced live when four KAN-3 test files were consolidated into one and
 * the four old entries had to be found and deleted from the JSON by a hand-written script instead
 * of a real pipeline stage.
 *
 * Requires the exact same four flags as --stage traceability-link (--issue, --external-case-id,
 * --test-file, optional --test-title) - not just --test-file - so the operator states precisely
 * which entry they mean, same "refuse rather than guess" contract removeEntry itself has. If no
 * entry matches that exact key, this throws rather than silently doing nothing, so a typo in any
 * of the four fields surfaces immediately instead of looking like a successful no-op.
 *
 * Refuses to remove an entry whose testFilePath still exists on disk unless --force true is passed.
 * This is the one thing this stage checks that removeEntry() itself doesn't: manual JSON surgery on
 * an audit trail is exactly the kind of mistake-prone operation this command exists to replace, and
 * the single most likely mistake is removing a still-valid link by accident (wrong external-case-id
 * typed, or the file was only temporarily missing). A genuinely stale entry - the actual use case
 * this stage is for - points at a file that is really gone, so requiring --force for the other case
 * costs nothing in the normal flow and catches the dangerous one.
 */
async function stageTraceabilityUnlink(
  issue: string,
  externalCaseId: string,
  testFilePath: string,
  testTitle: string | undefined,
  force: boolean,
): Promise<void> {
  const manifest = loadManifest();
  const target = findEntry(manifest.entries, { jiraKey: issue, externalCaseId, testFilePath, testTitle });

  if (!target) {
    throw new Error(
      `No traceability entry found for jiraKey=${issue}, externalCaseId=${externalCaseId}, ` +
      `testFilePath=${testFilePath}${testTitle ? `, testTitle="${testTitle}"` : ''} - nothing to ` +
      `unlink. Check ${tenantDataPath('traceability', 'manifest.json')} for the exact values (all four fields must match ` +
      'precisely; this stage never fuzzy-matches or removes more than one entry).',
    );
  }

  if (fs.existsSync(testFilePath) && !force) {
    throw new Error(
      `${testFilePath} still exists on disk - traceability-unlink is for entries pointing at files ` +
      'that are genuinely gone (e.g. after consolidating or deleting a test), not for detaching a ' +
      'still-valid link. If you really mean to remove this entry anyway (e.g. migrating this test ' +
      'to a different TMS case), rerun with --force true.',
    );
  }

  const nextEntries = removeEntry(manifest.entries, { jiraKey: issue, externalCaseId, testFilePath, testTitle });
  saveManifest({ workflow: manifest.workflow, entries: nextEntries });

  console.log(
    `Unlinked ${testFilePath}${target.testTitle ? ` (test "${target.testTitle}")` : ''} <-> ` +
    `${target.tmsProvider} case ${externalCaseId} <-> ${issue} from ${tenantDataPath('traceability', 'manifest.json')}. ` +
    'drift-check will no longer report on this entry.',
  );
}

/**
 * Renames an already-generated, already-linked spec file and keeps every
 * traceability/manifest.json entry pointing at it in sync, in one operation - the file path and
 * its manifest entries have to move together, and doing that by hand (mv the file, then hand-edit
 * the JSON) is exactly how KAN-9's rename silently drifted its manifest entry out of sync with the
 * real file path, which the Traceability Coverage Check then caught days later as an "unlinked"
 * test instead of catching it at rename time.
 *
 * This is deliberately for the *after generation* case only. Choosing a file's name in the first
 * place is a human decision made in the plan's **File:** line before generation even runs (see
 * test-generation.md Section 1.4 and the Generator Agent, which writes to whatever path that line
 * says) - nothing here overrides that. This stage is for when a human decides afterwards, once a
 * test already exists and is linked, that it should be named differently.
 *
 * Updates every manifest entry currently pointing at oldPath - a shared multi-test file can have
 * more than one entry (see findEntryByTestFilePath). Renaming does not change the test's content,
 * so testContentHash/testLastModified/syncState are left exactly as they were; only testFilePath
 * moves. Refuses to run if no manifest entry points at oldPath at all - if the file was never
 * linked in the first place, a plain `git mv` is enough and this stage has nothing useful to do.
 *
 * Deliberately does not `git mv`/`git add`/commit itself - same convention as every other stage in
 * this file (traceability-record, traceability-link, ...): it prepares the working tree and leaves
 * staging/committing to the human, since the Manifest Provenance guardrail requires the commit
 * itself to carry a `Traceability-Stage: rename-spec-file` trailer that only the actual commit
 * author can add.
 */
async function stageRenameSpecFile(oldPath: string, newPath: string): Promise<void> {
  if (!fs.existsSync(oldPath)) {
    throw new Error(`${oldPath} does not exist - nothing to rename.`);
  }
  if (fs.existsSync(newPath)) {
    throw new Error(`${newPath} already exists - refusing to overwrite it.`);
  }
  if (!newPath.endsWith('.spec.ts')) {
    throw new Error(`${newPath} must end in .spec.ts, same as every other test file under tests/.`);
  }

  const manifest = loadManifest();
  const affected = findEntryByTestFilePath(manifest.entries, oldPath);
  if (affected.length === 0) {
    throw new Error(
      `No ${tenantDataPath('traceability', 'manifest.json')} entries point at ${oldPath} - if this file was never linked ` +
      '(it never went through --stage traceability-record or traceability-link), a plain ' +
      '`git mv` is enough; this stage exists specifically to keep the manifest in sync, so it ' +
      'refuses to run when there is nothing there to update.',
    );
  }

  fs.mkdirSync(path.dirname(newPath), { recursive: true });
  fs.renameSync(oldPath, newPath);

  const nextEntries = manifest.entries.map((e) =>
    e.testFilePath === oldPath ? { ...e, testFilePath: newPath } : e,
  );
  saveManifest({ workflow: manifest.workflow, entries: nextEntries });

  const entryLabels = affected.map((e) => `"${e.testTitle ?? '(whole file)'}"`).join(', ');
  console.log(
    `Renamed ${oldPath} -> ${newPath} and updated ${affected.length} ${tenantDataPath('traceability', 'manifest.json')} ` +
    `${affected.length === 1 ? 'entry' : 'entries'} (${entryLabels}).`,
  );
  console.log(
    `Next: git add -A -- "${oldPath}" "${newPath}" "${tenantDataPath('traceability', 'manifest.json')}", then commit with a ` +
    '"Traceability-Stage: rename-spec-file" trailer (the Manifest Provenance guardrail requires ' +
    'it - e.g. git commit -m "chore: rename spec file" -m "Traceability-Stage: rename-spec-file"), then push.',
  );
}

async function stageDriftCheck(): Promise<void> {
  const manifest = loadManifest();
  const previousSyncStates = buildPreviousSyncStateMap(manifest.entries);

  const tms = await getTestManagementClient();
  const concurrency = env.DRIFT_CHECK_CONCURRENCY ? Number(env.DRIFT_CHECK_CONCURRENCY) : undefined;
  const result = await checkDrift(manifest.entries, tms, concurrency);

  saveManifest({ workflow: manifest.workflow, entries: result.entries.map(toManifestEntry) });
  const { reportJsonPath, reportMdPath } = writeReports(result);

  console.log(`Checked ${result.entries.length} traceability entries:`);
  for (const [state, count] of Object.entries(result.counts)) {
    console.log(`  ${state}: ${count}`);
  }
  console.log(`Reports written to ${reportJsonPath} and ${reportMdPath}`);

  const newlyDrifted = findNewlyDrifted(result.entries, previousSyncStates);
  let posted: { jiraKey: string; entryCount: number }[] = [];
  if (newlyDrifted.length > 0) {
    const jira = await getJiraClient();
    posted = await postDriftComments(newlyDrifted, jira);
    for (const { jiraKey, entryCount } of posted) {
      console.log(
        `Posted drift comment to ${jiraKey} (${entryCount} ${entryCount === 1 ? 'entry' : 'entries'})`,
      );
    }
  }

  // Links to the self-hosted traceability/report.html on the same Pages site as the pipeline
  // health dashboard (see writeSubReportPages in pipelineReport.ts) - reuses
  // PIPELINE_REPORT_PUBLIC_URL rather than needing a separate URL configured just for this
  // workflow. That page is only regenerated/republished when pipeline-report.yml itself next
  // runs (15 minutes after this workflow on the shared daily schedule - see README), so this link
  // can be briefly stale immediately after a drift-check run; same tolerance as the "stale"
  // threshold pipelineReport.ts already applies to traceability data elsewhere.
  const reportUrl = deriveSiteRoot(env.PIPELINE_REPORT_PUBLIC_URL);
  const slackWebhook = allowSlackNotify(!!process.env.CI, env.SLACK_NOTIFY_LOCAL)
    ? await resolveTenantEnv('DRIFT_CHECK_SLACK_WEBHOOK_URL')
    : undefined;
  await postDriftCheckToSlack(result, posted, slackWebhook, reportUrl ? `${reportUrl}/traceability/report.html` : undefined);
}

interface HealingRecordArgs {
  testFile: string;
  attempt: string;
  outcome: string;
  category?: string;
  jiraKey?: string;
  externalCaseId?: string;
  durationMs?: string;
  testTitle?: string;
}

async function stageHealingRecord(args: HealingRecordArgs): Promise<void> {
  const attemptNumber = Number(args.attempt);
  if (!Number.isInteger(attemptNumber) || attemptNumber < 0) {
    throw new Error(`--attempt must be a non-negative integer, got "${args.attempt}"`);
  }
  const outcome = HealingOutcomeSchema.parse(args.outcome);
  const category = args.category !== undefined ? FailureCategorySchema.parse(args.category) : undefined;
  const externalCaseId = args.externalCaseId;
  const durationMs = args.durationMs !== undefined ? Number(args.durationMs) : undefined;

  // args.testTitle (--test-title) wins when given - the caller already knows exactly which test
  // this is. Otherwise, best-effort auto-resolve: a healing event with no testTitle is still a
  // useful record (this is an append-only log, nothing to mismatch by upserting), so a missing or
  // still-ambiguous file degrades rather than blocks the record from being written at all.
  let testTitle: string | undefined = args.testTitle;
  if (testTitle === undefined) {
    try {
      if (fs.existsSync(args.testFile)) {
        testTitle = resolveTestBlockForFile(args.testFile, fs.readFileSync(args.testFile, 'utf-8')).testTitle;
      }
    } catch (err) {
      console.warn(
        `Could not resolve which test in ${args.testFile} this is (${(err as Error).message}) - ` +
        'recording without a testTitle (pass --test-title to say which one explicitly).',
      );
    }
  }

  const event: HealingEvent = {
    tenantId: getTenantId(),
    timestamp: new Date().toISOString(),
    jiraKey: args.jiraKey,
    externalCaseId,
    testFilePath: args.testFile,
    testTitle,
    suite: deriveSuite(args.testFile),
    attemptNumber,
    outcome,
    category,
    durationMs,
  };
  appendHealingEvent(event);

  console.log(
    `Recorded healing event: ${outcome} for ${args.testFile} (attempt ${attemptNumber}${category ? `, ${category}` : ''})`,
  );
}

async function stageHealingReport(): Promise<void> {
  const events = readHealingEvents();
  const report = buildHealingReport(events);
  const { reportJsonPath, reportMdPath } = writeHealingReports(report);

  console.log(`Aggregated ${report.totalEvents} healing events.`);
  console.log(`  Overall healing rate: ${report.overall.healingRate ?? 'n/a'}`);
  console.log(`Reports written to ${reportJsonPath} and ${reportMdPath}`);
}

interface FlakyRecordArgs {
  testFile: string;
  results: string;
  jiraKey?: string;
  externalCaseId?: string;
  testTitle?: string;
}

/**
 * Synthesizes per-attempt timestamps a second apart, ending at `now` - the CLI only receives the
 * ordered pass/fail outcomes (the reruns already happened before this call), not real per-attempt
 * timestamps.
 */
function buildEvidence(results: ('pass' | 'fail')[], now: Date): { attempt: number; result: 'pass' | 'fail'; timestamp: string }[] {
  return results.map((result, index) => ({
    attempt: index + 1,
    result,
    timestamp: new Date(now.getTime() - (results.length - 1 - index) * 1000).toISOString(),
  }));
}

async function stageFlakyRecord(args: FlakyRecordArgs): Promise<void> {
  const results = args.results.split(',').map((r) => FlakyRunResultSchema.parse(r.trim()));
  if (results.length < 2) {
    throw new Error('--results must list at least 2 comma-separated pass/fail outcomes, e.g. fail,pass,fail');
  }

  const isFlaky = decideFlaky(results);
  if (!isFlaky) {
    console.log(`Not flaky: ${args.testFile} produced the same result (${results[0]}) on every rerun. Proceed to normal diagnosis.`);
    return;
  }

  // args.testTitle (--test-title) wins when given. Otherwise, resolves which test within
  // args.testFile this is, so quarantining it never sweeps in a sibling scenario sharing the same
  // file - see resolveTestBlockForFile's comment. Unlike the traceability stages, this degrades
  // rather than throws when it still can't resolve cleanly (file missing, or ambiguous with no
  // --test-title given): a flaky *file* recorded with no title still quarantines something real,
  // whereas refusing to record it at all would silently drop a genuine flaky signal.
  let testTitle: string | undefined = args.testTitle;
  if (testTitle === undefined) {
    try {
      if (fs.existsSync(args.testFile)) {
        testTitle = resolveTestBlockForFile(args.testFile, fs.readFileSync(args.testFile, 'utf-8')).testTitle;
      }
    } catch (err) {
      console.warn(
        `Could not resolve which test in ${args.testFile} this is (${(err as Error).message}) - ` +
        'recording without a testTitle (pass --test-title to say which one explicitly).',
      );
    }
  }

  const now = new Date();
  const evidence = buildEvidence(results, now);
  const suite = deriveSuite(args.testFile);

  const event: FlakyEvent = {
    tenantId: getTenantId(),
    timestamp: now.toISOString(),
    jiraKey: args.jiraKey,
    externalCaseId: args.externalCaseId,
    testFilePath: args.testFile,
    testTitle,
    suite,
    evidence,
    action: 'quarantined',
  };
  appendFlakyEvent(event);

  const quarantine = loadQuarantine();
  const next = upsertQuarantineEntry(quarantine, {
    tenantId: getTenantId(),
    testFilePath: args.testFile,
    testTitle,
    jiraKey: args.jiraKey,
    externalCaseId: args.externalCaseId,
    suite,
    quarantinedAt: now.toISOString(),
    evidence,
  });
  saveQuarantine(next);

  console.log(`FLAKY: ${args.testFile} produced different results across ${results.length} runs (${results.join(', ')}).`);
  console.log(`Quarantined in ${tenantDataPath('flaky', 'quarantine.json')}. Tag this test's title with @quarantined in ${args.testFile} - do not diagnose this failure.`);
}

async function stageFlakyClear(testFile: string, testTitleArg?: string): Promise<void> {
  const quarantine = loadQuarantine();
  const candidates = quarantine.filter((e) => e.testFilePath === testFile);
  if (candidates.length === 0) {
    throw new Error(`No quarantine entry found for ${testFile} in ${tenantDataPath('flaky', 'quarantine.json')}`);
  }
  // Same deterministic-only reasoning as resolveTestBlockForFile: a shared multi-test file with
  // more than one quarantined scenario has no safe way to pick "the" entry to clear without
  // --test-title to say which one - clearing the wrong one would un-quarantine a still-flaky test
  // while leaving the actually-fixed one still blocked.
  const matches = testTitleArg !== undefined ? candidates.filter((e) => e.testTitle === testTitleArg) : candidates;
  if (matches.length !== 1) {
    throw new Error(
      `${testFile} has ${candidates.length} quarantine entries (a shared multi-test file) - pass ` +
      `--test-title to say which one to clear (got ${matches.length} match${matches.length === 1 ? '' : 'es'} ` +
      `for ${testTitleArg ?? '<none given>'}).`,
    );
  }
  const entry = matches[0];

  saveQuarantine(removeQuarantineEntry(quarantine, testFile, entry.testTitle));

  const event: FlakyEvent = {
    tenantId: getTenantId(),
    timestamp: new Date().toISOString(),
    jiraKey: entry.jiraKey,
    externalCaseId: entry.externalCaseId,
    testFilePath: entry.testFilePath,
    testTitle: entry.testTitle,
    suite: entry.suite,
    evidence: entry.evidence,
    action: 'cleared',
  };
  appendFlakyEvent(event);

  console.log(`Cleared quarantine for ${testFile}. Remove the @quarantined tag from its title by hand if you haven't already.`);
}

// True for a "case not found" 404 from the test-management provider - a case id the manifest still
// references but the provider no longer has (the traceability system's ORPHANED_CASE state).
// Checks the axios response status, falling back to the message text for non-axios wrappers.
function isTmsNotFound(err: unknown): boolean {
  const status = (err as { response?: { status?: number } } | null)?.response?.status;
  if (status === 404) return true;
  const message = err instanceof Error ? err.message : String(err);
  return message.includes('status code 404');
}

async function stageSuiteHealth(): Promise<void> {
  const now = new Date();
  const manifest = loadManifest();
  const traceability = manifest.entries;
  const quarantine = loadQuarantine();

  // The assertion + unlinked signals parse the generated spec files. Normalise every path to
  // forward slashes: the traceability manifest stores testFilePath with "/", and collectSignals
  // joins cases to tests by exact path match - on Windows a backslash path here would miss every
  // manifest entry and silently report the whole suite as spec-file-missing.
  const specRoot = 'tests';
  const specs = (fs.existsSync(specRoot) ? (fs.readdirSync(specRoot, { recursive: true }) as string[]) : [])
    .map((rel) => String(rel))
    .filter((rel) => rel.endsWith('.spec.ts'))
    .map((rel) => ({
      path: `tests/${rel.split(path.sep).join('/')}`,
      content: fs.readFileSync(path.join(specRoot, rel), 'utf-8'),
    }));

  // Every TMS case the repo knows about, from the manifest (deduped).
  const caseIds = [...new Set(traceability.map((e) => e.externalCaseId))];

  const tms = await getTestManagementClient();
  const cases: Array<{ caseId: string; title: string }> = [];
  const duplicateCandidates = [];
  const execution: Array<{ caseId: string; totalRuns: number; failedRuns: number; lastRunAt: string | null }> = [];
  const missingCaseIds: string[] = [];
  for (const caseId of caseIds) {
    let detail;
    try {
      detail = await tms.getCase(caseId);
    } catch (err) {
      // A stale manifest entry whose case was deleted in the provider must not crash the whole
      // report - skip it and note it below.
      if (isTmsNotFound(err)) {
        missingCaseIds.push(caseId);
        continue;
      }
      throw err;
    }
    cases.push({ caseId, title: detail.title });
    duplicateCandidates.push(candidateFromTmsCase(detail));
    // Optional capability (layer 1). Absent for a provider with no results API - then execution
    // stays empty and collectSignals emits a no-execution-history warning per case, by design.
    if (tms.getCaseExecutions) {
      try {
        const exec = await tms.getCaseExecutions(caseId);
        execution.push({ caseId, totalRuns: exec.totalRuns, failedRuns: exec.failedRuns, lastRunAt: exec.lastRunAt });
      } catch (err) {
        // No results for this case (or none accessible) - leave execution empty for it;
        // collectSignals emits a no-execution-history warning by design. Only a 404 is tolerated.
        if (!isTmsNotFound(err)) throw err;
      }
    }
  }
  if (missingCaseIds.length > 0) {
    console.warn(
      `Suite Health: ${missingCaseIds.length} manifest case(s) no longer exist in the provider, skipped: ` +
        missingCaseIds.join(', '),
    );
  }

  const duplicatePairs = findDuplicateCoverage(duplicateCandidates);
  const duplicateGroups = toDuplicateGroups(duplicatePairs);

  // Risk areas/blocksRelease need per-project config that does not exist yet, so this runs
  // UNCONFIGURED: empty weights + default weight. Every case falls to the default band with an
  // areaConfigured=false warning - the module's designed "unconfigured" behaviour. Wiring real
  // per-area weights (and blocksRelease) from Jira/config is a scoped follow-up.
  const execByCase = new Map(execution.map((e) => [e.caseId, e]));
  const riskInputs = caseIds.map((caseId) => ({
    caseId,
    areas: [] as string[],
    blocksRelease: false,
    execution: execByCase.get(caseId) ?? { totalRuns: 0, failedRuns: 0, lastRunAt: null },
  }));
  const riskScores = scoreAllRisk(riskInputs, { weights: {}, defaultWeight: DEFAULT_AREA_WEIGHT });
  const riskBands = toRiskBands(riskScores);

  const { records, warnings, analysisByCaseId } = collectSignals({
    cases,
    traceability,
    quarantine,
    specs,
    execution,
    duplicateGroups,
    riskBands,
    now,
  });

  const unlinkedTests = findUnlinkedTests(specs, traceability);

  const report = buildSuiteHealthReport({
    records,
    riskScores,
    analysisByCaseId,
    duplicatePairs,
    warnings,
    unlinkedTests,
    now,
  });
  const { reportJsonPath, reportMdPath } = writeSuiteHealthReports(report);

  console.log(
    `Suite Health: ${report.headline.totalCases} case(s), ${report.headline.healthyPercent}% healthy; ` +
      `${report.dataQuality.length} data-quality warning(s).`,
  );
  console.log(`Reports written to ${reportJsonPath} and ${reportMdPath}`);
}

async function stageFlakyReport(): Promise<void> {
  const events = readFlakyEvents();
  const quarantine = loadQuarantine();
  const report = buildFlakyReport(events, quarantine);
  const { reportJsonPath, reportMdPath } = writeFlakyReports(report);

  console.log(`Aggregated ${report.totalQuarantinedAllTime} all-time quarantine event(s); ${report.currentlyActive} currently active.`);
  console.log(`Reports written to ${reportJsonPath} and ${reportMdPath}`);
}

async function stagePromptVersionReport(): Promise<void> {
  const report = buildPromptVersionReport();
  const { reportJsonPath, reportMdPath } = writePromptVersionReports(report);

  for (const agent of report.agents) {
    console.log(`${agent.agentFile}: ${agent.commits.length} commit(s)`);
  }
  console.log(`Reports written to ${reportJsonPath} and ${reportMdPath}`);
}

async function stageCostMarker(agent: string, event: 'start' | 'end', jiraKey?: string): Promise<void> {
  const marker = appendMarker(agent, event, MARKERS_LOG_PATH(), jiraKey);
  console.log(
    `Recorded ${marker.event} marker for ${marker.agent}${marker.jiraKey ? ` (${marker.jiraKey})` : ''} at ${marker.timestamp}`,
  );
}

async function stageCostRecord(logPath: string, markersPath?: string): Promise<void> {
  const logText = fs.readFileSync(logPath, 'utf-8');

  // Zero blocks parsed at all means the session log hasn't captured any OTel export cycles yet -
  // distinct from zero *matching* cost events, which is legitimate when an agent's interval truly
  // had no token/cost activity. Confirmed empirically: a freshly-started transcript can sit at
  // just its header for a while before the console exporter's first flush lands in the file.
  if (parseMetricBlocks(logText).length === 0) {
    throw new Error(
      `session log has no OTel metric blocks yet - re-run cost-record once the session has captured data (${logPath})`,
    );
  }

  const markers = readMarkers(markersPath);
  const events = buildCostEvents(logText, markers);
  appendCostEvents(events);

  console.log(`Recorded ${events.length} cost event(s) from ${logPath} to ${tenantDataPath('cost', 'telemetry.jsonl')}`);
  for (const e of events) {
    console.log(`  ${e.agent} (${e.model}): $${e.costUsd.toFixed(6)}, ${e.wallClockMs}ms`);
  }
}

/**
 * --stage dev-status: open-PR/branch activity for this tenant's configured GITHUB_REPO, matched
 * to Jira ticket keys via matchBranchToTicket() (see devStatus.ts's own doc comment for why that
 * function implements exactly one convention today, not scrum.json's branchKeyConvention as a
 * general-purpose parser). JIRA_PROJECT_KEY is required the same way jiraClient.ts already
 * requires it - without a known project key, no branch/PR can ever be linked to a ticket, so the
 * report would be 100% "unlinked" and effectively useless; failing loud here is more honest than
 * silently producing a report that looks complete but isn't.
 */
async function stageDevStatus(): Promise<void> {
  const repo = await requireTenantEnv('GITHUB_REPO', 'Dev Status Stage');
  const projectKey = await requireTenantEnv('JIRA_PROJECT_KEY', 'Dev Status Stage');
  const vcs = await getVcsClient();
  const [pullRequests, branches] = await Promise.all([vcs.listOpenPullRequests(repo), vcs.listBranches(repo)]);

  const report = buildDevStatusReport(pullRequests, branches, repo, projectKey);
  const { reportJsonPath, reportMdPath } = writeDevStatusReports(report);

  console.log(
    `Found ${report.pullRequests.length} open PR(s) (${report.unlinkedPullRequestCount} unlinked) ` +
    `and ${report.branchesWithoutOpenPr.length} branch(es) without an open PR, for ${repo}.`,
  );
  console.log(`Reports written to ${reportJsonPath} and ${reportMdPath}`);
}

/**
 * --stage sprint-status: current-sprint snapshot (points grouped by status right now, per
 * assignee) for every board in this tenant's scrum.json boardIds - not env vars, since board
 * IDs/story-points-field are per-tenant ceremony config, not connection identifiers (contrast
 * GITHUB_REPO/JIRA_PROJECT_KEY, which are connection identifiers and live in env.ts). A board can
 * have more than one currently-active sprint (AgileClient.getActiveSprints's own doc comment) -
 * every one of them gets its own section in the report, never just the first found, same
 * "surface it, don't guess or drop it" reasoning as devStatus.ts's unlinked-activity handling.
 * storyPointsField is optional in scrum.json (ScrumConfigSchema's own doc comment: no guessed
 * default, since a wrong one would silently misreport point totals) - when it's unset, every
 * issue's storyPoints simply comes back null and the report says so explicitly via its own
 * storyPointsField field, rather than failing the whole stage over a ceremony config gap that
 * doesn't block reporting sprint/issue status itself.
 */
async function stageSprintStatus(): Promise<void> {
  const scrumConfig = loadScrumConfig();
  const boardIds = scrumConfig.boardIds;
  const storyPointsField = scrumConfig.storyPointsField ?? null;
  const agile = await getAgileClient();

  const boardSprints: SprintStatusBoardSprint[] = [];
  for (const boardId of boardIds) {
    const activeSprints = await agile.getActiveSprints(boardId);
    for (const sprint of activeSprints) {
      const issues = await agile.getSprintIssues(sprint.id, storyPointsField ?? '');
      boardSprints.push({ boardId, sprint, issues });
    }
  }

  const report = buildSprintStatusReport(boardIds, boardSprints, storyPointsField);
  const { reportJsonPath, reportMdPath } = writeSprintStatusReports(report);

  console.log(
    `Found ${report.sprints.length} active sprint(s) across ${boardIds.length} board(s) ` +
    `(${boardIds.join(', ') || 'none configured'}).`,
  );
  console.log(`Reports written to ${reportJsonPath} and ${reportMdPath}`);
}

/**
 * --stage burndown-report: Phase 3's first duty (see burndownReport.ts's own header comment for
 * the full "this is a point-in-time completed/remaining snapshot, not a historical burndown
 * chart or a real committed-vs-actual trend line" reasoning, and for why it reuses
 * buildSprintStatusReport()'s own per-sprint categorization instead of re-deriving it).
 *
 * Fetch loop is its own copy, same "each stage function owns its own fetch calls" convention as
 * every other stage in this file (contrast stageDevStatus's separate Promise.all) - not shared
 * with stageSprintStatus(), even though both call the identical AgileClient methods.
 *
 * One JSON+Markdown pair PER (board, active sprint) pair, not one combined report - see
 * burndownReport.ts's writeBurndownReports()/BURNDOWN_JSON_PATH() for the per-sprint-file
 * reasoning. A board with zero currently-active sprints simply contributes no file, same as it
 * contributes no section to sprint-status's own report.
 */
async function stageBurndownReport(): Promise<void> {
  const scrumConfig = loadScrumConfig();
  const boardIds = scrumConfig.boardIds;
  const storyPointsField = scrumConfig.storyPointsField ?? null;
  const agile = await getAgileClient();

  const boardSprints: SprintStatusBoardSprint[] = [];
  for (const boardId of boardIds) {
    const activeSprints = await agile.getActiveSprints(boardId);
    for (const sprint of activeSprints) {
      const issues = await agile.getSprintIssues(sprint.id, storyPointsField ?? '');
      boardSprints.push({ boardId, sprint, issues });
    }
  }

  const statusReport = buildSprintStatusReport(boardIds, boardSprints, storyPointsField);

  if (statusReport.sprints.length === 0) {
    console.log(
      `No active sprints found across ${boardIds.length} board(s) ` +
      `(${boardIds.join(', ') || 'none configured'}) - no burndown report(s) written.`,
    );
    return;
  }

  for (const section of statusReport.sprints) {
    const burndown = buildBurndownSprintReport(section, storyPointsField);
    const { reportJsonPath, reportMdPath } = writeBurndownReports(burndown);
    const percentText =
      burndown.percentComplete === null ? 'n/a' : `${Math.round(burndown.percentComplete * 100)}%`;
    console.log(
      `Burndown for board ${section.boardId} / ${section.sprint.name}: ` +
      `${burndown.completedStoryPoints}/${burndown.totalStoryPoints} pts complete (${percentText}).`,
    );
    console.log(`Reports written to ${reportJsonPath} and ${reportMdPath}`);
  }
}

/**
 * --stage standup-digest: build + DM-ONLY delivery (see standupDigest.ts's own header comment for
 * the full reasoning). Groups every active-sprint issue across this tenant's configured boardIds
 * by assignee - reusing the exact same fetch loop as stageSprintStatus() (same boardIds/
 * storyPointsField sourcing, same SprintStatusBoardSprint[] shape passed to the pure mapper) - and
 * writes a JSON+Markdown digest, the same dual-report convention as every other stage.
 *
 * Delivery: the Jira account migration (personal -> company account) is now
 * confirmed live, so this stage attempts a real Slack DM per assignee via sendTicketSummaryDm(),
 * gated by scrum.json's standupDigest.dm flag (read via loadScrumConfig(), same as boardIds/
 * storyPointsField above). Channel-mode delivery (posting to a Slack channel rather than DMing
 * each assignee) is a genuinely different Slack call and is explicitly deferred to a future PR -
 * planStandupDigestDelivery() always returns 'skipped-not-configured' when dm is false, even if
 * scrum.json's standupDigest.channel is also set. The per-assignee decision of whether to
 * attempt a send at all is made by the pure planStandupDigestDelivery() (standupDigest.ts) - this
 * function only calls sendTicketSummaryDm() when that pure check returns null, and is the only
 * place that can observe/record the real sent/failed outcome, since that can't be known in
 * advance. An issue whose assignee has no assigneeEmail (still a real possibility per
 * agileClient.ts's own doc comment) is skipped with a clear log line, never thrown - same
 * "surface the gap, don't crash" convention used everywhere else in this stage.
 *
 * The fetch loop below is intentionally its own copy, not shared with stageSprintStatus() - each
 * stage function in this pipeline owns its own fetch calls (contrast, e.g., stageDevStatus's
 * separate Promise.all), so the two stages stay independently reasoned-about rather than coupled
 * through a shared helper before there's a real need for one.
 */
async function stageStandupDigest(): Promise<void> {
  const scrumConfig = loadScrumConfig();
  const boardIds = scrumConfig.boardIds;
  const storyPointsField = scrumConfig.storyPointsField ?? null;
  const configuredDelivery: StandupDigestDeliveryConfig = {
    dm: scrumConfig.standupDigest.dm,
    channel: scrumConfig.standupDigest.channel ?? null,
  };
  const agile = await getAgileClient();

  const boardSprints: SprintStatusBoardSprint[] = [];
  for (const boardId of boardIds) {
    const activeSprints = await agile.getActiveSprints(boardId);
    for (const sprint of activeSprints) {
      const issues = await agile.getSprintIssues(sprint.id, storyPointsField ?? '');
      boardSprints.push({ boardId, sprint, issues });
    }
  }

  const report = buildStandupDigestReport(boardIds, boardSprints, storyPointsField, configuredDelivery);

  // Delivery loop: attaches a `delivery` outcome to every assignee summary in-place before the
  // report is written to disk, so the persisted JSON/Markdown always reflects what actually
  // happened (or was decided not to happen), not just what was planned.
  const emailByAssignee = buildAssigneeEmailMap(boardSprints);
  const botToken = await resolveTenantEnv('SLACK_BOT_TOKEN');
  let sentCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  for (const assigneeSummary of report.assignees) {
    const email = assigneeSummary.assignee ? emailByAssignee.get(assigneeSummary.assignee) : undefined;
    const planned = planStandupDigestDelivery(assigneeSummary.assignee, configuredDelivery, email);

    if (planned) {
      assigneeSummary.delivery = planned;
      skippedCount++;
      console.log(
        `Standup digest delivery for ${assigneeSummary.assignee ?? 'Unassigned'}: ${planned.outcome}` +
        `${planned.detail ? ` - ${planned.detail}` : ''}`,
      );
      continue;
    }

    const message = buildStandupDigestSlackMessage(assigneeSummary);
    const result = await sendTicketSummaryDm(botToken, email, message);
    if (result.ok) {
      assigneeSummary.delivery = { outcome: 'sent' };
      sentCount++;
      console.log(`Standup digest DM sent to ${assigneeSummary.assignee} (${email}).`);
    } else {
      assigneeSummary.delivery = { outcome: 'failed', detail: result.error };
      failedCount++;
      console.warn(`Standup digest DM failed for ${assigneeSummary.assignee} (${email}): ${result.error}`);
    }
  }

  const { reportJsonPath, reportMdPath } = writeStandupDigestReports(report);

  console.log(
    `Built a standup digest for ${report.assignees.length} assignee(s) across ${boardIds.length} board(s) ` +
    `(${boardIds.join(', ') || 'none configured'}). Delivery: ${sentCount} sent, ${skippedCount} skipped, ${failedCount} failed.`,
  );
  console.log(`Reports written to ${reportJsonPath} and ${reportMdPath}`);
}

/**
 * --stage blocker-scan: Phase 2's first WRITE stage (see blockerScan.ts's own header comment for
 * the full design reasoning - idle-days=calendar-days, "blocked"=pure idle time regardless of
 * status name, one-tenant-wide-webhook for channel delivery, no cross-run dedup yet).
 *
 * Manually-triggered CLI stage only for this PR - deliberately NOT wired into
 * scrum-ceremony-report.yml's cron, same gating discipline standup-digest's DM delivery followed
 * in Phase 1 (build without delivery in one PR, only enable delivery once proven against real
 * data in a later PR) - here the whole stage (build + delivery together) waits for a manual
 * trigger before it's trusted to run unattended.
 *
 * Fetch loop is its own copy (same reasoning as stageStandupDigest's own comment on this) - not
 * shared with stageSprintStatus/stageStandupDigest, so each stage stays independently
 * reasoned-about.
 *
 * Escalation channels are validated up front, before any fetch or delivery attempt, via
 * assertSupportedChannel() - a typo'd or unimplemented channel (e.g. 'teams', 'email') should
 * fail loudly at startup, not silently mid-run after some tickets have already been escalated.
 *
 * Delivery per flagged issue:
 *  - Jira comment to the assignee: always attempted (this is the assignee's only escalation
 *    channel - see ScrumEscalationRecipientSchema's own comment on why the assignee itself is
 *    never a configurable recipient). Skipped with a clear log line (not a comment) when there's
 *    no assignee at all.
 *  - Each configured relatedRecipient's own channels: 'slack-dm' via sendTicketSummaryDm (targets
 *    an email address), 'slack-channel' via a direct webhook POST to
 *    BLOCKER_SCAN_SLACK_WEBHOOK_URL, gated by allowSlackNotify() the same CI-only-by-default way
 *    every other shared-channel Slack post in this file is gated, or 'email' via a real SMTP send
 *    through emailClient.ts's getEmailClient(), gated by allowEmailNotify()/SMTP_NOTIFY_LOCAL the
 *    same CI-only-by-default way. The 'slack-channel' webhook POST is inlined here with axios
 *    directly (fire-and-log, mirroring postToSlack's/postCostReportToSlack's own semantics)
 *    rather than routed through either of those functions, since both are tightly coupled to
 *    their own report types (PipelineReport/CostReport) and not generic enough to reuse for a
 *    per-issue blocker message - same "own the network call in the stage function" convention as
 *    stageStandupDigest calling sendTicketSummaryDm directly. The 'email' send is likewise
 *    attempted directly here (getEmailClient().sendMail(), wrapped in this stage's own
 *    try/catch) - see emailClient.ts's own header comment for why EmailClient.sendMail() itself
 *    throws on failure instead of returning a {ok, error} result like sendTicketSummaryDm does.
 *
 * Every attempt (sent/skipped/failed) is recorded onto the issue's `escalations` array before the
 * report is written, so the persisted JSON/Markdown always reflects what actually happened - same
 * "surface it, don't guess or drop it" convention as standup-digest's `delivery` field.
 */
async function stageBlockerScan(): Promise<void> {
  const scrumConfig = loadScrumConfig();
  const boardIds = scrumConfig.boardIds;
  const storyPointsField = scrumConfig.storyPointsField ?? null;
  const { idleDaysThreshold, relatedRecipients } = scrumConfig.blockerEscalation;

  // Validate every configured recipient channel up front - fail fast before any fetch or
  // delivery, not partway through after some tickets are already escalated.
  for (const recipient of relatedRecipients) {
    for (const ch of recipient.channels) {
      assertSupportedChannel(ch.channel);
    }
  }

  const agile = await getAgileClient();
  const boardSprints: SprintStatusBoardSprint[] = [];
  for (const boardId of boardIds) {
    const activeSprints = await agile.getActiveSprints(boardId);
    for (const sprint of activeSprints) {
      const issues = await agile.getSprintIssues(sprint.id, storyPointsField ?? '');
      boardSprints.push({ boardId, sprint, issues });
    }
  }

  const report = buildBlockerScanReport(boardIds, boardSprints, idleDaysThreshold);

  const jira = await getJiraClient();
  const botToken = await resolveTenantEnv('SLACK_BOT_TOKEN');
  const slackChannelWebhook = allowSlackNotify(!!process.env.CI, env.SLACK_NOTIFY_LOCAL)
    ? await resolveTenantEnv('BLOCKER_SCAN_SLACK_WEBHOOK_URL')
    : undefined;
  // 'email' delivery's own config-presence gate, same shape as slackChannelWebhook above - see
  // this stage's header comment. Only SMTP_HOST is checked here (not all five SMTP_* vars) to
  // decide whether email delivery is configured at all; a tenant that sets SMTP_HOST but leaves
  // another required var unset will still hit getEmailClient()'s own requireTenantEnv() checks
  // inside the try/catch below and surface as a 'failed' outcome with a clear error, not a silent
  // 'skipped-not-configured'.
  const smtpHost = allowEmailNotify(!!process.env.CI, env.SMTP_NOTIFY_LOCAL)
    ? await resolveTenantEnv('SMTP_HOST')
    : undefined;

  let sentCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  const recordOutcome = (attempts: BlockerEscalationAttempt[], attempt: BlockerEscalationAttempt) => {
    attempts.push(attempt);
    if (attempt.outcome === 'sent') sentCount++;
    else if (attempt.outcome === 'failed') failedCount++;
    else skippedCount++;
  };

  for (const flagged of report.issues) {
    const attempts: BlockerEscalationAttempt[] = [];

    // Assignee escalation: always a Jira comment, never Slack - the assignee is not a
    // configurable recipient (see ScrumEscalationRecipientSchema's comment).
    if (flagged.assignee) {
      try {
        await jira.addComment(flagged.key, buildBlockerEscalationComment(flagged, idleDaysThreshold));
        recordOutcome(attempts, { recipient: flagged.assignee, channel: 'jira-comment', outcome: 'sent' });
        console.log(`Blocker escalation comment posted on ${flagged.key} for ${flagged.assignee}.`);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        recordOutcome(attempts, { recipient: flagged.assignee, channel: 'jira-comment', outcome: 'failed', detail });
        console.warn(`Blocker escalation comment failed on ${flagged.key} for ${flagged.assignee}: ${detail}`);
      }
    } else {
      recordOutcome(attempts, {
        recipient: 'assignee',
        channel: 'jira-comment',
        outcome: 'skipped-not-configured',
        detail: 'issue has no assignee',
      });
      console.log(`${flagged.key} is unassigned - skipping assignee escalation.`);
    }

    // Related-recipient escalation: each recipient's own configured channels.
    for (const recipient of relatedRecipients) {
      const slackMessage = buildBlockerEscalationSlackMessage(flagged, idleDaysThreshold);
      for (const ch of recipient.channels) {
        if (ch.channel === 'slack-dm') {
          const result = await sendTicketSummaryDm(botToken, ch.target, slackMessage);
          if (result.ok) {
            recordOutcome(attempts, { recipient: recipient.identifier, channel: 'slack-dm', outcome: 'sent' });
            console.log(`Blocker escalation DM sent to ${recipient.identifier} for ${flagged.key}.`);
          } else {
            recordOutcome(attempts, {
              recipient: recipient.identifier,
              channel: 'slack-dm',
              outcome: 'failed',
              detail: result.error,
            });
            console.warn(`Blocker escalation DM failed for ${recipient.identifier} on ${flagged.key}: ${result.error}`);
          }
        } else if (ch.channel === 'slack-channel') {
          if (!slackChannelWebhook) {
            recordOutcome(attempts, {
              recipient: recipient.identifier,
              channel: 'slack-channel',
              outcome: 'skipped-not-configured',
              detail: 'BLOCKER_SCAN_SLACK_WEBHOOK_URL not set (or local runs not opted into shared-channel notify)',
            });
            continue;
          }
          try {
            await axios.post(slackChannelWebhook, slackMessage);
            recordOutcome(attempts, { recipient: recipient.identifier, channel: 'slack-channel', outcome: 'sent' });
            console.log(`Blocker escalation posted to Slack channel webhook for ${recipient.identifier} on ${flagged.key}.`);
          } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            recordOutcome(attempts, { recipient: recipient.identifier, channel: 'slack-channel', outcome: 'failed', detail });
            console.warn(`Blocker escalation Slack channel post failed for ${recipient.identifier} on ${flagged.key}: ${detail}`);
          }
        } else if (ch.channel === 'email') {
          if (!smtpHost) {
            recordOutcome(attempts, {
              recipient: recipient.identifier,
              channel: 'email',
              outcome: 'skipped-not-configured',
              detail: 'SMTP_HOST not set (or local runs not opted into email notify)',
            });
            continue;
          }
          try {
            const { subject, text } = buildBlockerEscalationEmail(flagged, idleDaysThreshold);
            await (await getEmailClient()).sendMail(ch.target, subject, text);
            recordOutcome(attempts, { recipient: recipient.identifier, channel: 'email', outcome: 'sent' });
            console.log(`Blocker escalation email sent to ${recipient.identifier} (${ch.target}) for ${flagged.key}.`);
          } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            recordOutcome(attempts, { recipient: recipient.identifier, channel: 'email', outcome: 'failed', detail });
            console.warn(`Blocker escalation email failed for ${recipient.identifier} on ${flagged.key}: ${detail}`);
          }
        }
      }
    }

    flagged.escalations = attempts;
  }

  const { reportJsonPath, reportMdPath } = writeBlockerScanReports(report);

  console.log(
    `Blocker scan flagged ${report.flaggedCount} issue(s) across ${boardIds.length} board(s) ` +
    `(${boardIds.join(', ') || 'none configured'}), idle threshold ${idleDaysThreshold} day(s). ` +
    `Escalations: ${sentCount} sent, ${skippedCount} skipped, ${failedCount} failed.`,
  );
  console.log(`Reports written to ${reportJsonPath} and ${reportMdPath}`);
}

/**
 * --stage groom-check-fetch: the deterministic fetch half of backlog-groom-check (Phase 2's
 * second and final duty - see groomCheck.ts's own header comment for the full Option-B reasoning
 * and why there is deliberately no deterministic judgment function here). Dumps every current-
 * sprint ticket (same agileClient.ts getActiveSprints/getSprintIssues fetch loop as sprint-status/
 * standup-digest/blocker-scan) plus each ticket's full description, issue type, and status (via
 * jiraClient.ts's existing getIssue()/extractDescription() - no client changes needed, both
 * already exist and are already used by the Jira Agent) into one clean report, so the live
 * judgment step (scrum-master-agent.md's new instructions) has a single data source to read
 * instead of looping raw API calls inline itself.
 *
 * Deliberately makes one getIssue() call per sprint ticket rather than trying to batch - this is a
 * manually-triggered, on-demand stage (never cron), so the extra round-trips are an acceptable
 * cost for getting each ticket's real description without inventing a bulk-fetch endpoint
 * agileClient.ts's own sprint-issue search doesn't expose.
 */
async function stageGroomCheckFetch(): Promise<void> {
  const scrumConfig = loadScrumConfig();
  const boardIds = scrumConfig.boardIds;
  const storyPointsField = scrumConfig.storyPointsField ?? null;
  const agile = await getAgileClient();
  const jira = await getJiraClient();

  const tickets: GroomCheckTicket[] = [];
  for (const boardId of boardIds) {
    // Active AND future (not-yet-started) sprints - grooming needs to happen before a ticket is
    // committed to a started sprint, not after. See AgileClient.getActiveAndFutureSprints's own
    // doc comment for why getActiveSprints alone can't support that.
    const sprints = await agile.getActiveAndFutureSprints(boardId);
    for (const sprint of sprints) {
      const issues = await agile.getSprintIssues(sprint.id, storyPointsField ?? '');
      for (const issue of issues) {
        const raw = await jira.getIssue(issue.key);
        const rawIssueType = raw.fields.issuetype as { name?: string } | undefined;
        const { description } = jira.extractDescription(raw);
        tickets.push({
          key: issue.key,
          summary: issue.summary,
          description,
          issueType: rawIssueType?.name ?? 'Unknown',
          status: issue.status,
          boardId,
          sprintName: sprint.name,
        });
      }
    }
  }

  const report = buildGroomCheckFetchReport(boardIds, tickets);
  const { reportJsonPath, reportMdPath } = writeGroomCheckFetchReports(report);

  console.log(
    `Fetched ${tickets.length} ticket(s) from current + upcoming sprint(s) across ${boardIds.length} ` +
    `board(s) (${boardIds.join(', ') || 'none configured'}) for backlog grooming.`,
  );
  console.log(`Reports written to ${reportJsonPath} and ${reportMdPath}`);
}

/**
 * --stage groom-check-flag: the posting half of backlog-groom-check. Deliberately dumb - the
 * actual "is this ticket clear enough" judgment (reframed per ticket type - "can scenarios be
 * generated from this" vs "can a developer start building from this") is made live, by whoever is
 * running scrum-master-agent.md's new instructions after reading --stage groom-check-fetch's
 * report, never by this function. This stage just takes the gap strings that live judgment step
 * already decided on and posts them - mirroring flag-requirement-gaps' own file-based mechanism
 * (same BOM-strip handling, same JSON-array-of-strings shape) but with no manifest-recorded gate:
 * there is no downstream stage this blocks, so an empty/missing gaps file is just "nothing to
 * flag," not "gate cleared" - fire-and-log, the same posture blocker-scan's own escalation
 * comment already uses, not a three-gate workflow record like Gate 0's.
 */
async function stageGroomCheckFlag(issue: string, gapsFilePath?: string): Promise<void> {
  if (!gapsFilePath) {
    console.log(`No --gaps-file provided for ${issue} - nothing to flag.`);
    return;
  }
  // Same leading-UTF-8-BOM strip as stageFlagRequirementGaps - see that function's own comment
  // for why (Windows PowerShell's Set-Content -Encoding utf8 writes one by default).
  const gaps: string[] = JSON.parse(fs.readFileSync(gapsFilePath, 'utf-8').replace(/^﻿/, ''));
  if (gaps.length === 0) {
    console.log(`No gaps to flag for ${issue} - nothing posted.`);
    return;
  }

  const jira = await getJiraClient();
  await jira.addComment(issue, buildGroomCheckComment(gaps));
  console.log(`Posted backlog-grooming comment to ${issue} (${gaps.length} gap(s)).`);
}

/**
 * --stage retro-notes-fetch: Phase 3's second and final duty's deterministic fetch half (see
 * retroNotes.ts's own header comment for the full Option-B reasoning and for why QA telemetry is
 * deliberately not wired in yet - confirmed with the user, not guessed). Fetch loop is its own
 * copy, same "each stage function owns its own fetch calls" convention as every other stage in
 * this file: the sprint/ticket half mirrors stageBurndownReport()'s own agileClient.ts loop
 * (boardIds/storyPointsField from scrum.json, buildSprintStatusReport() for per-sprint
 * categorization - not re-derived here a third time), and the VCS half mirrors stageDevStatus()'s
 * own vcsClient Promise.all fetch (GITHUB_REPO/JIRA_PROJECT_KEY from env, buildDevStatusReport()
 * for PR/branch-to-ticket correlation - not re-derived here either). findVcsActivityForTicket()
 * then correlates the two per ticket, a pure function with no fetch of its own.
 */
async function stageRetroNotesFetch(): Promise<void> {
  const scrumConfig = loadScrumConfig();
  const boardIds = scrumConfig.boardIds;
  const storyPointsField = scrumConfig.storyPointsField ?? null;
  const agile = await getAgileClient();

  const boardSprints: SprintStatusBoardSprint[] = [];
  for (const boardId of boardIds) {
    const activeSprints = await agile.getActiveSprints(boardId);
    for (const sprint of activeSprints) {
      const issues = await agile.getSprintIssues(sprint.id, storyPointsField ?? '');
      boardSprints.push({ boardId, sprint, issues });
    }
  }
  const statusReport = buildSprintStatusReport(boardIds, boardSprints, storyPointsField);

  // VCS is optional enrichment for this duty (unlike --stage dev-status, whose entire job is VCS
  // reporting) - a multi-tenant SaaS product will have tenants who never connect a GitHub repo at
  // all, and this stage should still report the sprint's tickets for them rather than hard-fail.
  // See vcsClient/index.ts's hasVcsConfigured() for why this checks the real env var rather than
  // scrum.json's vcs.provider (which defaults to "github" even when unconfigured).
  const vcsConfigured = await hasVcsConfigured();
  let devStatusReport: DevStatusReport | null = null;
  if (vcsConfigured) {
    const repo = await requireTenantEnv('GITHUB_REPO', 'Retro Notes Fetch Stage');
    const projectKey = await requireTenantEnv('JIRA_PROJECT_KEY', 'Retro Notes Fetch Stage');
    const vcs = await getVcsClient();
    const [pullRequests, branches] = await Promise.all([vcs.listOpenPullRequests(repo), vcs.listBranches(repo)]);
    devStatusReport = buildDevStatusReport(pullRequests, branches, repo, projectKey);
  } else {
    console.log(
      'GITHUB_REPO not configured for this tenant - VCS is optional enrichment for retro-notes-fetch, ' +
      'so every ticket below will simply have no linked PRs/branches (surfaced in the report as ' +
      'vcsConfigured: false, not left to look like zero activity).',
    );
  }

  const tickets: RetroNotesTicket[] = [];
  for (const section of statusReport.sprints) {
    for (const sprintIssue of section.issues) {
      const { pullRequests: linkedPrs, branchesWithoutOpenPr } = devStatusReport
        ? findVcsActivityForTicket(sprintIssue.key, devStatusReport)
        : { pullRequests: [], branchesWithoutOpenPr: [] };
      tickets.push({
        key: sprintIssue.key,
        summary: sprintIssue.summary,
        status: sprintIssue.status,
        statusCategory: sprintIssue.statusCategory,
        boardId: section.boardId,
        sprintName: section.sprint.name,
        pullRequests: linkedPrs,
        branchesWithoutOpenPr,
      });
    }
  }

  const report = buildRetroNotesFetchReport(boardIds, tickets, vcsConfigured);
  const { reportJsonPath, reportMdPath } = writeRetroNotesFetchReports(report);

  const vcsSummary = vcsConfigured
    ? `${report.ticketsWithVcsActivityCount} with linked VCS activity`
    : 'VCS not configured for this tenant';
  console.log(
    `Fetched ${tickets.length} current-sprint ticket(s) across ${boardIds.length} board(s) ` +
    `(${boardIds.join(', ') || 'none configured'}) for the retro (${vcsSummary}).`,
  );
  console.log(`Reports written to ${reportJsonPath} and ${reportMdPath}`);
}

/**
 * --stage retro-notes-post: the posting half of retro-notes - deliberately dumb, same posture as
 * stageGroomCheckFlag(). The actual retrospective synthesis (what went well, what didn't, action
 * items) is made live, by whoever is running scrum-master-agent.md's own new instructions after
 * reading --stage retro-notes-fetch's report; this stage just reads the notes text that live step
 * already wrote to --notes-file and posts it - confirmed with the user (AskUserQuestion, "retro
 * notes destination"): file only, data/<tenantId>/scrum/retro-<sprintId>.md, no Jira comment, no
 * Slack post, unlike backlog-groom-check's Jira-comment posting (a sprint retro has no single
 * ticket to attach to).
 */
async function stageRetroNotesPost(sprintId: number, notesFilePath?: string): Promise<void> {
  if (!notesFilePath) {
    console.log(`No --notes-file provided for sprint ${sprintId} - nothing to post.`);
    return;
  }
  // Same leading-UTF-8-BOM strip as stageFlagRequirementGaps/stageGroomCheckFlag - see
  // stageFlagRequirementGaps's own comment for why (Windows PowerShell's Set-Content -Encoding
  // utf8 writes one by default). Read as raw text, not JSON.parse'd - retro-notes-post has no
  // structured shape here, just the live-synthesized notes prose.
  const notes = fs.readFileSync(notesFilePath, 'utf-8').replace(/^﻿/, '');
  if (notes.trim().length === 0) {
    console.log(`Notes file for sprint ${sprintId} is empty - nothing posted.`);
    return;
  }

  const content = buildRetroNotesFile(sprintId, notes);
  const mdPath = writeRetroNotesFile(sprintId, content);
  console.log(`Posted retro notes for sprint ${sprintId} to ${mdPath}.`);
}

/**
 * --stage scrum-dashboard: Dashboard v1, PR 1 - read-only static HTML views over this program's
 * five scrum reports (sprint-status, standup-digest, blocker-scan, burndown-report, retro-notes).
 * See scrumDashboard.ts's own header comment for the full reasoning. Deliberately does no
 * fetching of its own - unlike every stage above, this one only reads reports those stages already
 * wrote to disk, exactly mirroring stagePipelineReport()'s own split between reading each
 * sub-report and building/writing the combined dashboard. No Slack post either (unlike
 * stagePipelineReport()) - this PR is explicitly read-only/no-write-action, and posting a link to
 * a local file path would not be useful the way a public pipeline-report URL is.
 */
async function stageScrumDashboard(): Promise<void> {
  const report = readScrumDashboardData();
  const { reportJsonPath, reportHtmlPath } = writeScrumDashboardReports(report);

  const available = [
    report.sprintStatus.available && 'sprint-status',
    report.standupDigest.available && 'standup-digest',
    report.blockerScan.available && 'blocker-scan',
    report.burndown.length > 0 && `burndown (${report.burndown.length} sprint(s))`,
    report.retroNotes.length > 0 && `retro-notes (${report.retroNotes.length} sprint(s))`,
  ].filter((v): v is string => typeof v === 'string');

  console.log(
    available.length > 0
      ? `Scrum dashboard generated - available: ${available.join(', ')}.`
      : 'Scrum dashboard generated - nothing available yet for this tenant.',
  );
  console.log(`Reports written to ${reportJsonPath} and ${reportHtmlPath}`);
}

/**
 * --stage coverage-report: user-stories/test coverage (from the traceability manifest) and
 * development coverage (from dev-status/retro-notes' VCS correlation) for every currently active
 * sprint. See coverageReport.ts's own header comment for the full reasoning, including why
 * "user stories coverage" and "test coverage" are treated as one metric here. Same fetch shape as
 * --stage burndown-report (agile client's current-sprint snapshot, reused via
 * buildSprintStatusReport - no new client method), plus the same optional-VCS pattern
 * --stage retro-notes-fetch already established (hasVcsConfigured(), not scrum.json's
 * vcs.provider, which defaults to "github" even when unconfigured).
 */
async function stageCoverageReport(): Promise<void> {
  const scrumConfig = loadScrumConfig();
  const boardIds = scrumConfig.boardIds;
  const storyPointsField = scrumConfig.storyPointsField ?? null;
  const agile = await getAgileClient();

  const boardSprints: SprintStatusBoardSprint[] = [];
  for (const boardId of boardIds) {
    const activeSprints = await agile.getActiveSprints(boardId);
    for (const sprint of activeSprints) {
      const issues = await agile.getSprintIssues(sprint.id, storyPointsField ?? '');
      boardSprints.push({ boardId, sprint, issues });
    }
  }
  const statusReport = buildSprintStatusReport(boardIds, boardSprints, storyPointsField);

  if (statusReport.sprints.length === 0) {
    console.log(
      `No active sprints found across ${boardIds.length} board(s) ` +
      `(${boardIds.join(', ') || 'none configured'}) - no coverage report written.`,
    );
    return;
  }

  const vcsConfigured = await hasVcsConfigured();
  let devStatusReport: DevStatusReport | null = null;
  if (vcsConfigured) {
    const repo = await requireTenantEnv('GITHUB_REPO', 'Coverage Report Stage');
    const projectKey = await requireTenantEnv('JIRA_PROJECT_KEY', 'Coverage Report Stage');
    const vcs = await getVcsClient();
    const [pullRequests, branches] = await Promise.all([vcs.listOpenPullRequests(repo), vcs.listBranches(repo)]);
    devStatusReport = buildDevStatusReport(pullRequests, branches, repo, projectKey);
  } else {
    console.log(
      'GITHUB_REPO not configured for this tenant - development coverage will be reported as ' +
      'n/a, not guessed as zero.',
    );
  }

  const manifest = loadManifest();
  const report = buildCoverageReport(boardIds, statusReport.sprints, manifest.entries, devStatusReport);
  const { reportJsonPath, reportMdPath } = writeCoverageReports(report);

  for (const section of report.sprints) {
    const devText =
      section.devCoveredStoryCount === null
        ? 'n/a'
        : `${section.devCoveredStoryCount}/${section.totalStoryCount}`;
    console.log(
      `Coverage for board ${section.boardId} / ${section.sprintName}: ` +
      `${section.coveredStoryCount}/${section.totalStoryCount} stories covered ` +
      `(${section.healthyCoverageCount} fully in sync), dev coverage ${devText}.`,
    );
  }
  console.log(`Reports written to ${reportJsonPath} and ${reportMdPath}`);
}

/**
 * --stage settings-update: Dashboard v1, PR 2's Settings panel. Invoked by
 * .github/workflows/settings-update.yml's workflow_dispatch form, never expected to be run ad hoc
 * against production by a human - see that workflow's own header comment for the full design
 * (GitHub Actions form as the provisional, lowest-commitment choice; GitHub's repo-permission
 * model as the v1 access gate).
 *
 * Loads the tenant's current scrum.json, applies the one requested edit, and re-validates the
 * WHOLE resulting config against the exact same ScrumConfigSchema every pipeline stage that reads
 * scrum.json already trusts - only writing to disk if that succeeds. applyScrumSettingUpdate()
 * (scrumConfigStore.ts) throws before this function ever calls saveScrumConfig() on an unknown
 * setting name or an invalid value, so there is no partial-write case to handle here: either the
 * whole update lands, or nothing does. An uncaught throw propagates to main().catch() (bottom of
 * this file), which prints the error and exits non-zero - the workflow's commit step only runs
 * on this step's success, so a rejected value is never committed.
 */
async function stageSettingsUpdate(setting: string, rawValue: string): Promise<void> {
  const current = loadScrumConfig();
  const updated = applyScrumSettingUpdate(current, setting, rawValue);
  saveScrumConfig(updated);
  console.log(`Updated ${setting} for tenant "${getTenantId()}" in ${SCRUM_CONFIG_PATH()}.`);
}

async function stageCostReport(issueFilter?: string): Promise<void> {
  const allEvents = readCostEvents();
  const events = issueFilter ? filterEventsByIssue(allEvents, issueFilter) : allEvents;
  const report = buildCostReport(events, new Date(), issueFilter);
  const { reportJsonPath, reportMdPath } = writeCostReports(
    report,
    issueFilter ? buildIssueReportPaths(issueFilter) : undefined,
  );

  if (issueFilter) {
    console.log(`Aggregated ${report.totalEvents} cost event(s) for ${issueFilter}.`);
  } else {
    console.log(`Aggregated ${report.totalEvents} cost events.`);
  }
  console.log(`  Total cost: $${report.overall.totalCostUsd.toFixed(6)}`);
  if (report.runawayFlags.length > 0) {
    console.log(`  ${report.runawayFlags.length} runaway invocation(s) flagged.`);
  }
  console.log(`Reports written to ${reportJsonPath} and ${reportMdPath}`);

  const slackWebhook = allowSlackNotify(!!process.env.CI, env.SLACK_NOTIFY_LOCAL)
    ? await resolveTenantEnv('COST_REPORT_SLACK_WEBHOOK_URL')
    : undefined;
  await postCostReportToSlack(report, slackWebhook);
}

/**
 * One aggregated view across cost, healing, flaky, prompt-versioning, and traceability, instead
 * of running four separate --stage <x>-report commands and a drift-check to get a sense of
 * overall pipeline health. Cost/healing/flaky/prompt-versions are recomputed fresh here (all pure
 * local-data aggregations, no side effects); traceability is read from its own last-written
 * report.json rather than re-run, since drift-checking makes live TMS/Jira calls and posts
 * comments on newly-drifted entries - not something a report-viewing command should trigger as a
 * side effect. See readTraceabilitySummary's own comment for more.
 */
async function stagePipelineReport(): Promise<void> {
  const cost = buildCostReport(readCostEvents());
  const healing = buildHealingReport(readHealingEvents());
  const flaky = buildFlakyReport(readFlakyEvents(), loadQuarantine());
  const promptVersions = buildPromptVersionReport();
  const traceability = readTraceabilitySummary();

  const report = buildPipelineReport(cost, healing, flaky, promptVersions, traceability);
  const { reportJsonPath, reportHtmlPath } = writePipelineReports(report, env.PIPELINE_REPORT_PUBLIC_URL);

  if (report.attentionFlags.length > 0) {
    console.log(`${report.attentionFlags.length} item(s) need attention:`);
    for (const flag of report.attentionFlags) console.log(`  - ${flag}`);
  } else {
    console.log('Pipeline health report generated - nothing flagged, all green.');
  }
  console.log(`Reports written to ${reportJsonPath} and ${reportHtmlPath}`);

  // Fires every run, not just when something's flagged - see slackNotify.ts for why this never
  // throws (a Slack outage shouldn't fail the run that's reporting on the pipeline's health).
  // CI-only by default (see teamConfig.ts's allowSlackNotify) - with more than one person running
  // this locally, unconditional posting would spam the shared channel every time someone
  // sanity-checks before pushing.
  const slackWebhook = allowSlackNotify(!!process.env.CI, env.SLACK_NOTIFY_LOCAL)
    ? await resolveTenantEnv('SLACK_WEBHOOK_URL')
    : undefined;
  await postToSlack(report, slackWebhook, env.PIPELINE_REPORT_PUBLIC_URL);
}

/**
 * Manual, on-demand ticket status - distinct from --stage pipeline-report (which is about this
 * pipeline's own health across every ticket) and from the automatic merge-notify GitHub Actions
 * workflow (which just pings a channel that *something* merged, with no per-ticket detail). This
 * gathers one specific jiraKey's Gate 0/1/2 status, TMS run/case data, and run/heal telemetry, then
 * DMs it via Slack to whoever ran the command - see slackDm.ts for why a DM (Bot API) rather than
 * the SLACK_WEBHOOK_URL-style incoming webhook used elsewhere: a webhook can't address a specific
 * person. The summary is always printed to the console first, so a missing/misconfigured
 * SLACK_BOT_TOKEN never leaves the person running this with nothing.
 */
async function stageTicketSummary(issue: string): Promise<void> {
  const data = await gatherTicketSummary(issue);
  const message = buildTicketSummaryText(data);
  console.log(message.text);

  const recipientEmail = (await resolveTenantEnv('SLACK_USER_EMAIL')) || (await resolveTenantEnv('JIRA_EMAIL'));
  const result = await sendTicketSummaryDm(await resolveTenantEnv('SLACK_BOT_TOKEN'), recipientEmail, message);
  if (result.ok) {
    console.log(`\nSent to your Slack DM (${recipientEmail}).`);
  } else {
    console.warn(`\nDid not send Slack DM: ${result.error}`);
  }
}

/**
 * Qase's real result vocabulary also has 'invalid' (the case itself is broken, not the app under
 * test) - dropped from the canonical TmsResultStatus (see src/pipeline/testmgmt/types.ts). This is the one
 * place it's still accepted, for the deprecated --stage qase-submit-result path: mapped to
 * 'blocked' with a note appended to the comment before it reaches the generic client.
 */
function normalizeDeprecatedQaseStatus(status: string, comment?: string): { status: TmsResultStatus; comment?: string } {
  if (status === 'invalid') {
    const note = 'originally submitted as Qase status "invalid" (no canonical equivalent - mapped to "blocked")';
    return { status: 'blocked', comment: comment ? `${comment} [${note}]` : `[${note}]` };
  }
  if (!TMS_RESULT_STATUSES.includes(status as TmsResultStatus)) {
    throw new Error(`--status must be one of ${[...TMS_RESULT_STATUSES, 'invalid'].join(', ')}`);
  }
  return { status: status as TmsResultStatus, comment };
}

// ---------------------------------------------------------------------------
// Manual-Tester Agent (persona exploration + ticket-driven verification). The
// deterministic IO around each mode's live agent step lives here; the judgement
// logic is in ../manualTester/*, the personas in personas.json, and every Jira
// write is human-gated (assertApproved). See docs/dogfood-exploratory-agent.spec.md.
// ---------------------------------------------------------------------------

async function stageTicketVerify(ticketKey: string): Promise<void> {
  const jira = await getJiraClient();
  const raw = await jira.getIssue(ticketKey);
  const { summary, description } = jira.extractDescription(raw);
  const ticket = parseTicket(ticketKey, summary, description);
  const proposals = ticket.acceptanceCriteria
    .filter((c) => classifyAmbiguity(c).ambiguous)
    .map((c) => suggestClarification(c));
  const session: TicketVerifySession = {
    kind: 'ticket-verify',
    createdAt: new Date().toISOString(),
    ticket,
    observations: [],
    proposals,
  };
  const sessionPath = writeTicketVerifySession(session);
  console.log(`Ticket ${ticketKey} - ${ticket.acceptanceCriteria.length} acceptance criterion/criteria parsed:`);
  for (const c of ticket.acceptanceCriteria) {
    const suffix = classifyAmbiguity(c).ambiguous
      ? '  [AMBIGUOUS -> will be flagged for clarification, not judged pass/fail]'
      : '';
    console.log(`  ${c.id}: ${c.text}${suffix}`);
  }
  console.log(`Verification session written to ${sessionPath}.`);
  console.log('Next: run the live verification, record observations into that file, then approve + comment:');
  console.log(`  npm run pipeline -- --stage ticket-verify-approve --ticket ${ticketKey}`);
  console.log(`  npm run pipeline -- --stage ticket-verify-comment --ticket ${ticketKey}`);
}

async function stageTicketVerifyApprove(ticketKey: string): Promise<void> {
  const sessionPath = ticketVerifySessionPath(ticketKey);
  const session = readTicketVerifySession(sessionPath);
  session.approval = stampApproval(resolveOperator(env.PIPELINE_OPERATOR, env.JIRA_EMAIL) ?? 'unknown');
  writeTicketVerifySession(session, sessionPath);
  console.log(`Approved verification write-back for ${ticketKey} (by ${session.approval.approvedBy}).`);
}

async function stageTicketVerifyComment(ticketKey: string): Promise<void> {
  const sessionPath = ticketVerifySessionPath(ticketKey);
  const session = readTicketVerifySession(sessionPath);
  assertApproved(session, `npm run pipeline -- --stage ticket-verify-approve --ticket ${ticketKey}`);
  const verdicts = mapVerdicts(session.ticket.acceptanceCriteria, session.observations);
  const outcome = summarizeOutcome(verdicts);
  const comment = composeVerificationComment({ key: ticketKey }, verdicts, session.proposals);

  const jira = await getJiraClient();
  await jira.addComment(ticketKey, comment);
  console.log(`Posted verification comment to ${ticketKey} - outcome: ${outcome.overall}.`);

  for (const v of verdicts.filter((x) => x.status === 'fail')) {
    const bug = await jira.createBug({
      summary: `[${ticketKey}] ${v.acId} failed: ${v.criterionText}`.slice(0, 255),
      description:
        `Verifying ${ticketKey}. ${v.acId} failed.\n` +
        `Expected (from AC): ${v.then ?? v.criterionText}\n` +
        `Observed: ${v.observed}`,
      labels: ['manual-tester', 'ticket-verify', ticketKey],
    });
    console.log(`  Filed bug ${bug.key} for ${v.acId}.`);
  }
  if (outcome.promotable) {
    console.log(`  All criteria passed - ${ticketKey} is promotable to a scripted regression test (spec section 6).`);
  }
}

async function stageDogfoodRun(personaId: string): Promise<void> {
  const persona = getPersona(loadPersonasConfig(), personaId);
  const createdAt = new Date().toISOString();
  const session: DogfoodSession = {
    kind: 'dogfood',
    createdAt,
    persona,
    startUrl: persona.startUrl,
    stepsUsed: 0,
    routesVisited: [],
    goalsCompleted: [],
    goalsAbandoned: [],
    events: [],
    critiques: [],
  };
  const sessionPath = dogfoodSessionPath(personaId, createdAt.replace(/[:.]/g, '-'));
  writeDogfoodSession(session, sessionPath);
  console.log(`Persona "${persona.id}" - ${persona.displayName}`);
  console.log(`  goals: ${persona.goals.join(' | ')}`);
  console.log(
    `  budget: ${persona.stepBudget} interactions / ${persona.timeBoxMinutes} min; ` +
      `out of bounds: ${persona.outOfBounds.join(', ') || 'none'}`,
  );
  console.log(`Exploration session scaffold written to ${sessionPath}.`);
  console.log('Next: run the live exploration, record friction events + self-critiques into that file, then approve + file:');
  console.log(`  npm run pipeline -- --stage dogfood-approve --session ${sessionPath}`);
  console.log(`  npm run pipeline -- --stage dogfood-file --session ${sessionPath}`);
}

async function stageDogfoodApprove(sessionPath: string): Promise<void> {
  const session = readDogfoodSession(sessionPath);
  session.approval = stampApproval(resolveOperator(env.PIPELINE_OPERATOR, env.JIRA_EMAIL) ?? 'unknown');
  writeDogfoodSession(session, sessionPath);
  console.log(`Approved filing for persona "${session.persona.id}" (by ${session.approval.approvedBy}).`);
}

async function stageDogfoodFile(sessionPath: string): Promise<void> {
  const session = readDogfoodSession(sessionPath);
  assertApproved(session, `npm run pipeline -- --stage dogfood-approve --session ${sessionPath}`);
  const fileable = selectFileable(session.events, session.critiques);
  if (fileable.length === 0) {
    console.log('No fileable findings survived the self-critique gate - nothing filed.');
    return;
  }
  const jira = await getJiraClient();
  for (const event of fileable) {
    const draft = toBugDraft(event, session.persona.id, session.persona.displayName);
    const bug = await jira.createBug(draft);
    console.log(`  Filed bug ${bug.key}: ${draft.summary}`);
  }
  console.log(`Filed ${fileable.length} finding(s) from persona "${session.persona.id}".`);
}

async function stagePromote(
  ticketKey: string,
  specPath: string,
  testFilePath: string,
  groupName: string | undefined,
): Promise<void> {
  const session = readTicketVerifySession(ticketVerifySessionPath(ticketKey));
  const verdicts = mapVerdicts(session.ticket.acceptanceCriteria, session.observations);
  const outcome = summarizeOutcome(verdicts);
  if (!outcome.promotable) {
    throw new Error(
      `${ticketKey} is not promotable (outcome: ${outcome.overall}). Only an all-pass verification ` +
        'is recorded as a scripted regression test - fix the failing/ambiguous criteria first.',
    );
  }
  const input = promoteInputFromSession(session, verdicts, {
    groupName: groupName ?? session.ticket.summary,
    testFilePath,
  });

  if (fs.existsSync(specPath)) {
    const existing = fs.readFileSync(specPath, 'utf-8').replace(/\s*$/, '');
    const groupIndex = nextGroupIndex(existing);
    fs.writeFileSync(specPath, `${existing}\n\n${buildPlanScenario(input, groupIndex)}\n`, 'utf-8');
    console.log(`Appended the verified scenario to ${specPath} as group ${groupIndex}.`);
  } else {
    fs.mkdirSync(path.dirname(specPath), { recursive: true });
    fs.writeFileSync(
      specPath,
      buildNewSpecFile(`${input.groupName} Test Plan`, ticketKey, buildPlanScenario(input, 1)),
      'utf-8',
    );
    console.log(`Created ${specPath} with the verified scenario.`);
  }
  console.log('Steps came from the verified run; the Generator only hardens locators + pins data.');
  console.log(`Gate 1 (scenario approval) is now pending - review ${specPath}, then run:`);
  console.log(`  npm run pipeline -- --stage approve-scenarios --issue ${ticketKey}`);
}


async function main(): Promise<void> {
  const {
    stage,
    tenant,
    issue,
    file,
    spec,
    scenarioId,
    status,
    comment,
    runFile,
    transitionId,
    testFile,
    testTitle,
    attempt,
    outcome,
    category,
    externalCaseId,
    durationMs,
    baseSha,
    agent,
    event,
    log,
    markers,
    results,
    gapsFile,
    force,
    newPath,
    sprintId,
    notesFile,
    model,
    setting,
    value,
    question,
    fixVersion,
    persona,
    ticket,
    session,
    suite,
    group,
  } = parseArgs(process.argv.slice(2));

  setTenantId(resolveTenantId(tenant, env.TENANT_ID));
  assertStageAllowed(stage);

  // Record which stage ran so the prepare-commit-msg hook can auto-stamp the required
  // Traceability-Stage trailer on the resulting manifest commit (see manifestStageMarker.ts).
  recordManifestStageMarker(stage);

  switch (stage) {
    case 'jira': {
      if (!issue) throw new Error('--issue PROJ-123 is required');
      console.log(JSON.stringify(await stageJira(issue), null, 2));
      break;
    }
    case 'excel-write': {
      if (!spec) throw new Error('--spec specs/<feature>.plan.md is required');
      await stageExcelWrite(spec);
      break;
    }
    case 'excel-read': {
      if (!file) throw new Error('--file <path.xlsx> is required');
      console.log(JSON.stringify(await readScenarios(file), null, 2));
      break;
    }
    case 'tms-upload':
    case 'qase-upload': {
      if (stage === 'qase-upload') {
        console.warn('DEPRECATED: --stage qase-upload is now --stage tms-upload. Still working, but update your call sites.');
      }
      if (!file && !spec) {
        throw new Error(
          '--file <reviewed.xlsx> (preferred, reflects human edits) or --spec specs/<feature>.plan.md is required',
        );
      }
      const jiraKeyForGate = spec ? parseJiraKeyFromSpec(spec) : issue;
      if (!jiraKeyForGate) {
        throw new Error(
          'Cannot verify Gate 2 (test-case approval) without a Jira key - pass --spec (parsed for ' +
          'its "<!-- Jira: KEY -->" marker) or --issue PROJ-123 explicitly when calling with --file alone.',
        );
      }
      assertGateApproved(
        loadManifest(),
        jiraKeyForGate,
        'testCasesApprovedAt',
        'Gate 2 (test-case approval)',
        `npm run pipeline -- --stage approve-test-cases --issue ${jiraKeyForGate}`,
      );

      const specDeclaredSuite = spec ? parseSuiteFromSpec(spec) ?? undefined : undefined;
      const suiteTitle = resolveSuiteTitle(suite, specDeclaredSuite, jiraKeyForGate);
      const scenarios = file ? await readScenarios(file) : parseScenariosFromSpec(spec!);
      await stageTmsUpload(scenarios, file ?? spec!, jiraKeyForGate, suiteTitle);
      break;
    }
    case 'flag-requirement-gaps': {
      if (!issue) throw new Error('--issue PROJ-123 is required');
      await stageFlagRequirementGaps(issue, gapsFile);
      break;
    }
    case 'flag-requirement-gaps-headless': {
      if (!issue) throw new Error('--issue PROJ-123 is required');
      await stageFlagRequirementGapsHeadless(issue, model);
      break;
    }
    case 'ask': {
      if (!question) throw new Error('--question "plain-language question" is required');
      await stageAsk(question, model);
      break;
    }
    case 'draft-story': {
      // Reuses --issue for the epic key (not a new --epic flag) - same "reuse an existing generic
      // flag rather than a redundant new one" convention --question's own comment documents for
      // --model. An Epic key is passed exactly like every other ticket key this CLI already
      // accepts via --issue.
      if (!issue) throw new Error('--issue EPIC-123 is required');
      await stageDraftStory(issue, model);
      break;
    }
    case 'draft-sprint-plan': {
      // No --board-id flag - reuses scrum.json's own boardIds, same convention
      // stageSprintStatus()/stageBurndownReport() already follow (board scoping is per-tenant
      // ceremony config, not a per-invocation CLI argument). --model is reused for the narration
      // call, same as draft-story.
      await stageDraftSprintPlan(model);
      break;
    }
    case 'release-summary': {
      if (!fixVersion) throw new Error('--fix-version "2026.09" is required');
      await stageReleaseSummary(fixVersion);
      break;
    }
    case 'approve-requirements': {
      if (!issue) throw new Error('--issue PROJ-123 is required');
      await stageApproveRequirements(issue);
      break;
    }
    case 'approve-scenarios': {
      if (!issue) throw new Error('--issue PROJ-123 is required');
      await stageApproveScenarios(issue);
      break;
    }
    case 'approve-test-cases': {
      if (!issue) throw new Error('--issue PROJ-123 is required');
      await stageApproveTestCases(issue);
      break;
    }
    case 'tms-submit-result':
    case 'qase-submit-result': {
      const deprecated = stage === 'qase-submit-result';
      if (deprecated) {
        console.warn('DEPRECATED: --stage qase-submit-result is now --stage tms-submit-result. Still working, but update your call sites.');
      }
      if (!scenarioId || !status) {
        throw new Error(
          `--scenario-id <id> and --status ${TMS_RESULT_STATUSES.join('|')}${deprecated ? '|invalid' : ''} are required`,
        );
      }
      const normalized = deprecated
        ? normalizeDeprecatedQaseStatus(status, comment)
        : (() => {
          if (!TMS_RESULT_STATUSES.includes(status as TmsResultStatus)) {
            throw new Error(`--status must be one of ${TMS_RESULT_STATUSES.join(', ')}`);
          }
          return { status: status as TmsResultStatus, comment };
        })();
      const resolvedSubmitRunFile = runFile ?? (issue ? buildRunFilePath(issue) : undefined);
      if (!resolvedSubmitRunFile) {
        throw new Error(
          'Cannot resolve which run/case mapping to submit against - pass --issue PROJ-123 ' +
          '(matches the file --stage tms-upload wrote for that ticket) or --run-file <path> ' +
          'explicitly. output/tms-run.json is no longer a single shared file - each ticket gets ' +
          'its own output/tms-run-<key>.json.',
        );
      }
      await stageTmsSubmitResult(resolvedSubmitRunFile, scenarioId, normalized.status, normalized.comment);
      break;
    }
    case 'traceability-record': {
      if (!spec) throw new Error('--spec specs/<feature>.plan.md is required');
      const jiraKeyForRun = parseJiraKeyFromSpec(spec);
      const resolvedTraceabilityRunFile = runFile ?? (jiraKeyForRun ? buildRunFilePath(jiraKeyForRun) : undefined);
      if (!resolvedTraceabilityRunFile) {
        throw new Error(
          `${spec} has no "<!-- Jira: KEY -->" marker, and no --run-file was given - cannot ` +
          'resolve which run/case mapping to record traceability against.',
        );
      }
      await stageTraceabilityRecord(spec, resolvedTraceabilityRunFile);
      break;
    }
    case 'traceability-update-baseline': {
      if (!testFile) throw new Error('--test-file tests/<group>/<scenario>.spec.ts is required');
      await stageTraceabilityUpdateBaseline(testFile, testTitle);
      break;
    }
    case 'traceability-link': {
      if (!issue || !externalCaseId || !testFile) {
        throw new Error(
          '--issue PROJ-123, --external-case-id <id>, and --test-file <path> are all required',
        );
      }
      await stageTraceabilityLink(issue, externalCaseId, testFile, testTitle);
      break;
    }
    // Same underlying operation as traceability-link, exposed under a second, intent-revealing
    // name: re-running it on a triple that already exists in the manifest doesn't create a
    // duplicate (upsertEntry replaces in place), it re-fetches the case and re-hashes the test
    // file from their current live state and records that as the new IN_SYNC baseline. That's
    // exactly "a human reviewed this drift and accepts the current state as correct" - the
    // explicit accept-a-legitimate-change path that was missing (see README's Traceability
    // section). Kept as two stage names rather than one, since "link a never-before-seen test" and
    // "accept a known entry's drift" read as different intents even though the code is identical.
    case 'traceability-accept-baseline': {
      if (!issue || !externalCaseId || !testFile) {
        throw new Error(
          '--issue PROJ-123, --external-case-id <id>, and --test-file <path> are all required',
        );
      }
      await stageTraceabilityLink(issue, externalCaseId, testFile, testTitle);
      break;
    }
    case 'traceability-unlink': {
      if (!issue || !externalCaseId || !testFile) {
        throw new Error(
          '--issue PROJ-123, --external-case-id <id>, and --test-file <path> are all required ' +
          '(plus --test-title if the file holds more than one test)',
        );
      }
      await stageTraceabilityUnlink(issue, externalCaseId, testFile, testTitle, force === 'true');
      break;
    }
    case 'rename-spec-file': {
      if (!testFile || !newPath) {
        throw new Error('--test-file <old-path> and --new-path <new-path> are both required');
      }
      await stageRenameSpecFile(testFile, newPath);
      break;
    }
    case 'drift-check': {
      await stageDriftCheck();
      break;
    }
    case 'healing-report': {
      await stageHealingReport();
      break;
    }
    case 'assertion-check': {
      const { exitCode, report } = checkAssertionIntegrity(baseSha);
      console.log(report);
      process.exitCode = exitCode;
      break;
    }
    case 'locator-check': {
      const { exitCode, report } = checkLocatorPriority();
      console.log(report);
      process.exitCode = exitCode;
      break;
    }
    case 'traceability-coverage-check': {
      const { exitCode, report } = checkTraceabilityCoverage(baseSha);
      console.log(report);
      process.exitCode = exitCode;
      break;
    }
    case 'manifest-provenance-check': {
      const { exitCode, report } = checkManifestProvenance(baseSha);
      console.log(report);
      process.exitCode = exitCode;
      break;
    }
    case 'spec-file-consolidation-check': {
      const { exitCode, report } = checkSpecFileConsolidation(baseSha);
      console.log(report);
      process.exitCode = exitCode;
      break;
    }
    case 'secrets-check': {
      const { exitCode, report } = checkSecretsCommitted(baseSha);
      console.log(report);
      process.exitCode = exitCode;
      break;
    }
    case 'forbidden-playwright-patterns-check': {
      const { exitCode, report } = checkForbiddenPlaywrightPatterns(baseSha);
      console.log(report);
      process.exitCode = exitCode;
      break;
    }
    case 'required-tags-check': {
      const { exitCode, report } = checkRequiredTags(baseSha);
      console.log(report);
      process.exitCode = exitCode;
      break;
    }
    case 'verify-guardrails-locally': {
      // Local convenience aggregator, not a CI workflow of its own - runs the same 8 checks this
      // repo's branch protection requires (see .github/workflows/*.yml, one workflow per check)
      // in-process against one --base-sha, so a PR whose required checks are stuck at "Expected -
      // Waiting for status to be reported" (a recurring GitHub-side issue, not a bug in these
      // checks or this repo's workflow config - confirmed via repeated identical reproduction
      // across multiple PRs, see docs/planning's Continuity Log) can still be verified before
      // merging via GitHub's "bypass rules" option, instead of re-running each --stage by hand.
      // Reuses the exact same check functions every individual --stage-check case above calls -
      // this is not a separate reimplementation, so it can never silently drift from what CI
      // itself actually checks.
      const checks: { name: string; run: () => { exitCode: number; report: string } }[] = [
        { name: 'Assertion Integrity Check', run: () => checkAssertionIntegrity(baseSha) },
        { name: 'Forbidden Playwright Patterns Check', run: () => checkForbiddenPlaywrightPatterns(baseSha) },
        { name: 'Locator Priority Check', run: () => checkLocatorPriority() },
        { name: 'Manifest Provenance Check', run: () => checkManifestProvenance(baseSha) },
        { name: 'Required Test Tags Check', run: () => checkRequiredTags(baseSha) },
        { name: 'Traceability Coverage Check', run: () => checkTraceabilityCoverage(baseSha) },
        { name: 'Spec File Consolidation Check', run: () => checkSpecFileConsolidation(baseSha) },
        { name: 'Secrets Guardrail', run: () => checkSecretsCommitted(baseSha) },
      ];

      const results: { name: string; exitCode: number }[] = [];
      for (const check of checks) {
        // A thrown error (e.g. an invalid --base-sha git can't resolve) must not take down the
        // whole aggregator - the entire point of this stage is a full picture across all 8, so
        // one check's crash still gets reported as that one FAIL rather than hiding the other 7's
        // real results behind an uncaught exception.
        try {
          const { exitCode, report } = check.run();
          results.push({ name: check.name, exitCode });
          console.log(`\n===== ${check.name} =====`);
          console.log(report);
        } catch (err) {
          results.push({ name: check.name, exitCode: 1 });
          console.log(`\n===== ${check.name} =====`);
          console.log(`THREW: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      console.log('\n===== Summary =====');
      for (const result of results) {
        console.log(`${result.exitCode === 0 ? 'PASS' : 'FAIL'}  ${result.name}`);
      }
      const failed = results.filter((result) => result.exitCode !== 0);
      if (failed.length > 0) {
        console.log(`\n${failed.length} of ${results.length} required check(s) failed.`);
        process.exitCode = 1;
      } else {
        console.log(`\nAll ${results.length} required checks passed.`);
        process.exitCode = 0;
      }
      break;
    }
    case 'scenario-quality-check': {
      if (!spec) throw new Error('--spec specs/<feature>.plan.md is required');
      const { exitCode, report } = await checkScenarioQuality(spec);
      console.log(report);
      process.exitCode = exitCode;
      break;
    }
    case 'cost-marker': {
      if (!agent || (event !== 'start' && event !== 'end')) {
        throw new Error('--agent <name> and --event start|end are required');
      }
      await stageCostMarker(agent, event, issue);
      break;
    }
    case 'cost-record': {
      if (!log) throw new Error('--log <path to raw telemetry log> is required');
      await stageCostRecord(log, markers);
      break;
    }
    case 'cost-report': {
      await stageCostReport(issue);
      break;
    }
    case 'dev-status': {
      await stageDevStatus();
      break;
    }
    case 'sprint-status': {
      await stageSprintStatus();
      break;
    }
    case 'burndown-report': {
      await stageBurndownReport();
      break;
    }
    case 'standup-digest': {
      await stageStandupDigest();
      break;
    }
    case 'blocker-scan': {
      await stageBlockerScan();
      break;
    }
    case 'groom-check-fetch': {
      await stageGroomCheckFetch();
      break;
    }
    case 'groom-check-flag': {
      if (!issue) throw new Error('--issue PROJ-123 is required');
      await stageGroomCheckFlag(issue, gapsFile);
      break;
    }
    case 'retro-notes-fetch': {
      await stageRetroNotesFetch();
      break;
    }
    case 'retro-notes-post': {
      if (!sprintId) throw new Error('--sprint-id <numeric sprint id> is required');
      const parsedSprintId = Number.parseInt(sprintId, 10);
      if (!Number.isInteger(parsedSprintId)) {
        throw new Error(`--sprint-id must be a whole number, got "${sprintId}"`);
      }
      await stageRetroNotesPost(parsedSprintId, notesFile);
      break;
    }
    case 'scrum-dashboard': {
      await stageScrumDashboard();
      break;
    }
    case 'coverage-report': {
      await stageCoverageReport();
      break;
    }
    case 'settings-update': {
      if (!setting || value === undefined) {
        throw new Error('--setting <key> and --value <value> are required');
      }
      await stageSettingsUpdate(setting, value);
      break;
    }
    case 'pipeline-report': {
      await stagePipelineReport();
      break;
    }
    case 'healing-record': {
      if (!testFile || attempt === undefined || !outcome) {
        throw new Error(
          '--test-file <path>, --attempt <n>, and --outcome healed|escalated|passed_no_heal_needed are required',
        );
      }
      await stageHealingRecord({
        testFile,
        attempt,
        outcome,
        category,
        jiraKey: issue,
        externalCaseId,
        durationMs,
        testTitle,
      });
      break;
    }
    case 'flaky-record': {
      if (!testFile || !results) {
        throw new Error('--test-file <path> and --results fail,pass,fail (ordered pass/fail outcomes) are required');
      }
      await stageFlakyRecord({ testFile, results, jiraKey: issue, externalCaseId, testTitle });
      break;
    }
    case 'flaky-clear': {
      if (!testFile) throw new Error('--test-file <path> is required');
      await stageFlakyClear(testFile, testTitle);
      break;
    }
    case 'flaky-report': {
      await stageFlakyReport();
      break;
    }
    case 'prompt-version-report': {
      await stagePromptVersionReport();
      break;
    }
    case 'ticket-summary': {
      if (!issue) throw new Error('--issue PROJ-123 is required');
      await stageTicketSummary(issue);
      break;
    }
    case 'jira-transitions': {
      if (!issue) throw new Error('--issue PROJ-123 is required');
      const jira = await getJiraClient();
      console.log(JSON.stringify(await jira.getTransitions(issue), null, 2));
      break;
    }
    case 'jira-transition': {
      if (!issue || !transitionId) {
        throw new Error('--issue PROJ-123 and --transition-id <id> are required (see --stage jira-transitions)');
      }
      const jira = await getJiraClient();
      await jira.transitionIssue(issue, transitionId);
      console.log(`Transitioned ${issue} using transition ${transitionId}`);
      break;
    }
    case 'suite-health': {
      await stageSuiteHealth();
      break;
    }
    case 'ticket-verify': {
      if (!ticket) throw new Error('--ticket <KEY> is required (e.g. --ticket SCRUM-76)');
      await stageTicketVerify(ticket);
      break;
    }
    case 'ticket-verify-approve': {
      if (!ticket) throw new Error('--ticket <KEY> is required');
      await stageTicketVerifyApprove(ticket);
      break;
    }
    case 'ticket-verify-comment': {
      if (!ticket) throw new Error('--ticket <KEY> is required');
      await stageTicketVerifyComment(ticket);
      break;
    }
    case 'dogfood-run': {
      if (!persona) throw new Error('--persona <id> is required (e.g. --persona browsing-student)');
      await stageDogfoodRun(persona);
      break;
    }
    case 'dogfood-approve': {
      if (!session) throw new Error('--session <path to session json> is required');
      await stageDogfoodApprove(session);
      break;
    }
    case 'dogfood-file': {
      if (!session) throw new Error('--session <path to session json> is required');
      await stageDogfoodFile(session);
      break;
    }
    case 'promote': {
      if (!ticket) throw new Error('--ticket <KEY> is required (the verified session to promote)');
      if (!spec) throw new Error('--spec specs/<feature>.plan.md is required (target spec; appended if it exists)');
      if (!testFile) throw new Error('--test-file tests/.../<name>.spec.ts is required (the generated test file path)');
      await stagePromote(ticket, spec, testFile, group);
      break;
    }
    default:
      throw new Error(`Unknown stage "${stage}". See README.md for available stages.`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  // Axios errors' own .message is just "Request failed with status code N" - useless on its own.
  // The real diagnostic (e.g. Testiny's {"type":"ApiError","code":"...","message":"..."} body) is
  // in .response.data, which this repo's error paths didn't surface anywhere before - every real
  // API-error debugging session this far required a throwaway script just to see it once. Print it
  // unconditionally here instead, at the one true top-level catch every stage funnels through, so
  // no future failure needs its own script. Redact anything under a header literally named
  // 'X-Api-Key' before printing, even though axios error objects don't normally echo request
  // headers back - defense in depth, not a workaround for a bug (see the same caution that led to
  // deleting scripts/diagnose-testiny-folder-shape.ts, whose own unguarded crash dump did leak one).
  const withResponse = err as { response?: { status?: number; data?: unknown } };
  if (withResponse?.response) {
    const safeData =
      typeof withResponse.response.data === 'string' && /api[-_]?key/i.test(withResponse.response.data)
        ? '[redacted - looked like it might contain a header/credential]'
        : withResponse.response.data;
    console.error(`HTTP ${withResponse.response.status}:`, JSON.stringify(safeData));
  }
  process.exitCode = 1;
});
