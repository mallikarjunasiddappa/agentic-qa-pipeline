import fs from 'node:fs';
import path from 'node:path';
import { FlakyEvent, FlakyEventSchema } from '../types/schemas';
import { tenantDataPath } from '../config/tenantContext';

export function TELEMETRY_LOG_PATH(): string { return tenantDataPath('flaky', 'telemetry.jsonl'); }

/**
 * Appends one event to the JSONL log - never rewrites it. This is the history of every flakiness
 * observation over time, unlike flaky/quarantine.json which tracks current state per entry.
 */
export function appendFlakyEvent(event: FlakyEvent, logPath: string = TELEMETRY_LOG_PATH()): void {
  const validated = FlakyEventSchema.parse(event);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `${JSON.stringify(validated)}\n`, 'utf-8');
}

/** Reads and validates every event in the log, in append order. Empty array if the log doesn't exist yet. */
export function readFlakyEvents(logPath: string = TELEMETRY_LOG_PATH()): FlakyEvent[] {
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, 'utf-8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => FlakyEventSchema.parse(JSON.parse(line)));
}
