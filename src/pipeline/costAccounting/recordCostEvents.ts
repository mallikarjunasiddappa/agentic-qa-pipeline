import fs from 'node:fs';
import path from 'node:path';
import { CostEvent, CostEventSchema } from '../types/schemas';
import { getTenantId, tenantDataPath } from '../config/tenantContext';

export function COST_TELEMETRY_LOG_PATH(): string { return tenantDataPath('cost', 'telemetry.jsonl'); }

/** Appends events - never rewrites. Same append-only convention as healing/telemetry.jsonl. */
export function appendCostEvents(events: CostEvent[], logPath: string = COST_TELEMETRY_LOG_PATH()): void {
  if (events.length === 0) return;
  const validated = events.map((e) => CostEventSchema.parse({ ...e, tenantId: e.tenantId ?? getTenantId() }));
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const lines = `${validated.map((e) => JSON.stringify(e)).join('\n')}\n`;
  fs.appendFileSync(logPath, lines, 'utf-8');
}

export function readCostEvents(logPath: string = COST_TELEMETRY_LOG_PATH()): CostEvent[] {
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, 'utf-8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => CostEventSchema.parse(JSON.parse(line)));
}
