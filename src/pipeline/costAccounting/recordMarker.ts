import fs from 'node:fs';
import path from 'node:path';
import { tenantDataPath } from '../config/tenantContext';

export function MARKERS_LOG_PATH(): string { return tenantDataPath('cost', 'raw', 'markers.jsonl'); }

export interface AgentMarker {
  agent: string;
  event: 'start' | 'end';
  timestamp: string;
  // Which Jira ticket this dispatch is working on - from --stage cost-marker's optional --issue
  // flag. Optional since not every dispatch is ticket-scoped (pipeline-report, drift-check, ...).
  // Only the start marker's jiraKey is actually used (see parseAgentLog.ts's pairMarkers) - it's
  // accepted on the end marker too only so callers can pass --issue on both calls symmetrically
  // without it being an error.
  jiraKey?: string;
}

/**
 * Appends one start/end marker for a subagent dispatch. This is the actual "wrapper" for cost
 * attribution in this project: agents run as nested subagent calls within one Claude Code session
 * (confirmed - see README), not as separate processes, so there's no OS-level process boundary to
 * wrap. Instead, the orchestrator (planning-agent.md) calls this immediately before and after each
 * subagent dispatch, and the parser correlates these timestamps against the telemetry log.
 */
export function appendMarker(
  agent: string,
  event: 'start' | 'end',
  markersPath: string = MARKERS_LOG_PATH(),
  jiraKey?: string,
): AgentMarker {
  const marker: AgentMarker = { agent, event, timestamp: new Date().toISOString(), ...(jiraKey ? { jiraKey } : {}) };
  fs.mkdirSync(path.dirname(markersPath), { recursive: true });
  fs.appendFileSync(markersPath, `${JSON.stringify(marker)}\n`, 'utf-8');
  return marker;
}

export function readMarkers(markersPath: string = MARKERS_LOG_PATH()): AgentMarker[] {
  if (!fs.existsSync(markersPath)) return [];
  return fs
    .readFileSync(markersPath, 'utf-8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as AgentMarker);
}
