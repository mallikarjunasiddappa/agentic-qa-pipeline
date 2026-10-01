import fs from 'node:fs';
import { getJiraClient } from '../jira/jiraClient';
import { loadManifest, findWorkflowRecord } from '../traceability/manifestStore';
import { readHealingEvents } from '../telemetry/recordHealingEvent';
import { buildRunFilePath } from '../orchestrator/runFilePath';
import { TmsRunRecord } from '../testmgmt/types';
import { HealingEvent } from '../types/schemas';

export interface TicketSummaryHealing {
  total: number;
  passedNoHealNeeded: number;
  healed: number;
  escalated: number;
}

export interface TicketSummaryData {
  jiraKey: string;
  // Best-effort - undefined if the Jira call fails (e.g. ticket deleted, token expired). The rest
  // of the summary is still meaningful without it, so a Jira outage never blocks this stage.
  jiraSummary?: string;
  gate0ClearedAt?: string;
  gate1ApprovedAt?: string;
  gate1ApprovedBy?: string;
  gate2ApprovedAt?: string;
  gate2ApprovedBy?: string;
  tmsProvider?: string;
  runId?: string;
  externalCaseIds: string[];
  testFilePaths: string[];
  healing: TicketSummaryHealing;
}

function summarizeHealing(events: HealingEvent[]): TicketSummaryHealing {
  return {
    total: events.length,
    passedNoHealNeeded: events.filter((e) => e.outcome === 'passed_no_heal_needed').length,
    healed: events.filter((e) => e.outcome === 'healed').length,
    escalated: events.filter((e) => e.outcome === 'escalated').length,
  };
}

/**
 * Gathers everything --stage ticket-summary needs for one Jira ticket, entirely from local
 * pipeline state (traceability/manifest.json, output/tms-run-<key>.json, healing/telemetry.jsonl)
 * plus one best-effort Jira call for a human-readable title. Read-only - unlike almost every other
 * stage* function in this pipeline, this never writes anything, so it's safe to run as often as
 * anyone wants without side effects.
 *
 * Healing events are matched two ways - by event.jiraKey when present, and by testFilePath falling
 * inside this ticket's own traceability entries - because jiraKey is optional on HealingEvent (see
 * schemas.ts) while testFilePath is not, so the second match catches older/manually-recorded
 * events that never had jiraKey filled in.
 */
export async function gatherTicketSummary(jiraKey: string): Promise<TicketSummaryData> {
  const manifest = loadManifest();
  const workflow = findWorkflowRecord(manifest.workflow, jiraKey);
  const entries = manifest.entries.filter((e) => e.jiraKey === jiraKey);

  const runFilePath = buildRunFilePath(jiraKey);
  let runRecord: TmsRunRecord | undefined;
  if (fs.existsSync(runFilePath)) {
    runRecord = JSON.parse(fs.readFileSync(runFilePath, 'utf-8')) as TmsRunRecord;
  }

  const externalCaseIds = runRecord
    ? runRecord.cases.map((c) => c.externalCaseId)
    : [...new Set(entries.map((e) => e.externalCaseId))];
  const testFilePaths = [...new Set(entries.map((e) => e.testFilePath))];
  const testFilePathSet = new Set(testFilePaths);

  const healingEvents = readHealingEvents().filter(
    (event) => event.jiraKey === jiraKey || testFilePathSet.has(event.testFilePath),
  );

  let jiraSummary: string | undefined;
  try {
    const jira = await getJiraClient();
    const issue = await jira.getIssue(jiraKey);
    jiraSummary = jira.extractDescription(issue).summary;
  } catch (err) {
    console.warn(
      `Could not fetch ${jiraKey} from Jira for its title (${(err as Error).message}) - summary will omit it.`,
    );
  }

  return {
    jiraKey,
    jiraSummary,
    gate0ClearedAt: workflow?.requirementsClearedAt,
    gate1ApprovedAt: workflow?.scenariosApprovedAt,
    gate1ApprovedBy: workflow?.scenariosApprovedBy,
    gate2ApprovedAt: workflow?.testCasesApprovedAt,
    gate2ApprovedBy: workflow?.testCasesApprovedBy,
    tmsProvider: runRecord?.provider ?? entries[0]?.tmsProvider,
    runId: runRecord?.runId,
    externalCaseIds,
    testFilePaths,
    healing: summarizeHealing(healingEvents),
  };
}
