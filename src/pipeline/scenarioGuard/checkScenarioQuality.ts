import { parseScenariosFromSpec, parseJiraKeyFromSpec } from '../specs/specParser';
import { getJiraClient } from '../jira/jiraClient';
import { Scenario } from '../types/schemas';
import {
  ScenarioQualityFinding,
  checkIdFormatAndUniqueness,
  checkTitleQuality,
  checkPreconditionQuality,
  checkStepGranularity,
  checkExpectedResultQuality,
  checkPriorityVariance,
  checkObservability,
  checkNoImplementationDetails,
  checkTraceabilityToTicket,
  checkInventedBusinessRules,
  checkDuplicateCoverage,
} from './scenarioQualityRules';

export interface ScenarioQualityResult {
  findings: ScenarioQualityFinding[];
  blockingCount: number;
  warningCount: number;
}

/**
 * Pure: no filesystem/network access, so this is directly unit-testable against synthetic
 * scenarios. `ticketText` (Jira summary + description) is optional - the two checks that need it
 * (traceability-to-ticket, invented-business-rule) are skipped entirely when it's not supplied,
 * rather than failing the whole run. Every other check here runs offline against the scenario
 * content alone - no LLM, no network - by design, so this can catch structurally weak manual test
 * cases (missing/duplicate preconditions, compound steps, vague expected results, flat priority,
 * implementation details leaking into tester-facing text) before a human ever has to notice it at
 * Gate 1.
 */
export function runScenarioQualityCheck(scenarios: Scenario[], ticketText?: string): ScenarioQualityResult {
  const findings: ScenarioQualityFinding[] = [
    ...checkIdFormatAndUniqueness(scenarios),
    ...checkTitleQuality(scenarios),
    ...checkPreconditionQuality(scenarios),
    ...checkStepGranularity(scenarios),
    ...checkExpectedResultQuality(scenarios),
    ...checkPriorityVariance(scenarios),
    ...checkObservability(scenarios),
    ...checkNoImplementationDetails(scenarios),
    ...(ticketText ? checkTraceabilityToTicket(scenarios, ticketText) : []),
    ...(ticketText ? checkInventedBusinessRules(scenarios, ticketText) : []),
    ...checkDuplicateCoverage(scenarios),
  ];

  return {
    findings,
    blockingCount: findings.filter((f) => f.severity === 'block').length,
    warningCount: findings.filter((f) => f.severity === 'warn').length,
  };
}

export function buildReport(
  result: ScenarioQualityResult,
  scenarioCount: number,
  ticketTextAvailable: boolean,
): string {
  const lines: string[] = ['# Scenario Quality Check', '', `Checked ${scenarioCount} scenario(s).`];

  if (!ticketTextAvailable) {
    lines.push(
      '',
      '_Jira ticket text was not available for this run (no `<!-- Jira: KEY -->` marker, or the ' +
        'ticket could not be fetched) - the traceability-to-ticket and invented-business-rule ' +
        'checks were skipped rather than failing the run._',
    );
  }
  lines.push('');

  if (result.findings.length === 0) {
    lines.push('No findings - scenarios look structurally sound.');
    return lines.join('\n');
  }

  const blocking = result.findings.filter((f) => f.severity === 'block');
  const warnings = result.findings.filter((f) => f.severity === 'warn');

  if (blocking.length > 0) {
    lines.push('## Blocking', '');
    for (const f of blocking) {
      lines.push(`- [${f.rule}]${f.scenarioId ? ` (${f.scenarioId})` : ''} ${f.message}`);
    }
    lines.push('');
  }

  if (warnings.length > 0) {
    lines.push('## Warnings (non-blocking, heuristic - may be false positives)', '');
    for (const f of warnings) {
      lines.push(`- [${f.rule}]${f.scenarioId ? ` (${f.scenarioId})` : ''} ${f.message}`);
    }
    lines.push('');
  }

  lines.push(
    result.blockingCount === 0
      ? `Nothing blocking (${result.warningCount} warning(s) above worth a glance before Gate 1).`
      : `${result.blockingCount} blocking finding(s) above must be fixed directly in the spec file ` +
          'before this can proceed to Gate 1 approval.',
  );

  return lines.join('\n');
}

/**
 * CLI entry point: parses scenarios from the spec file, best-effort fetches the source Jira
 * ticket's summary/description for the two ticket-aware checks (never required for the check to
 * run - a failed/skipped fetch just drops those two checks, see buildReport's note), and runs the
 * pure check above.
 */
export async function checkScenarioQuality(specFilePath: string): Promise<{ exitCode: number; report: string }> {
  const scenarios = parseScenariosFromSpec(specFilePath);
  const jiraKey = parseJiraKeyFromSpec(specFilePath);

  let ticketText: string | undefined;
  if (jiraKey) {
    try {
      const jira = await getJiraClient();
      const issue = await jira.getIssue(jiraKey);
      const { summary, description } = jira.extractDescription(issue);
      ticketText = `${summary}\n${description}`;
    } catch {
      ticketText = undefined; // offline or Jira unreachable - degrade gracefully rather than fail the run
    }
  }

  const result = runScenarioQualityCheck(scenarios, ticketText);
  const report = buildReport(result, scenarios.length, ticketText !== undefined);
  return { exitCode: result.blockingCount > 0 ? 1 : 0, report };
}
