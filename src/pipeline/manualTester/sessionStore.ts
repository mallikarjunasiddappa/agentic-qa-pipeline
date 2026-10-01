import fs from 'node:fs';
import path from 'node:path';
import { tenantDataPath } from '../config/tenantContext';
import { ParsedTicket, AcObservation, ProposedClarification } from './acVerification';
import { FrictionEvent, EventCritique } from './frictionLog';
import { Persona } from '../types/schemas';

/**
 * On-disk session records for the Manual-Tester Agent, and the human-gate they carry. A session is
 * the handoff between the deterministic fetch stage (writes the scaffold), the live agent step
 * (fills observations / friction events), the approve stage (stamps `approval`), and the post/file
 * stage (reads it back and writes to Jira) - the exact fetch -> live -> post shape the scrum
 * groom-check / retro-notes duties already use. Sessions live under data/<tenantId>/manualTester/,
 * same "pipeline-generated state" category as every other data/<tenantId>/ output.
 */

export interface Approval {
  approvedBy: string;
  approvedAt: string;
}

/**
 * One recorded interaction from a live run - the raw material for "record from the trace, don't
 * re-explore" (spec section 6). `action` is the human-readable step (becomes a plan.md step);
 * targetRole/targetName are the element hints the Generator hardens into a stable locator later.
 */
export interface TraceStep {
  action: string;
  targetRole?: string;
  targetName?: string;
}

/** Mode B: one ticket-driven verification session. Observations are filled by the live agent. */
export interface TicketVerifySession {
  kind: 'ticket-verify';
  createdAt: string;
  ticket: ParsedTicket;
  observations: AcObservation[];
  proposals: ProposedClarification[];
  // Recorded during the live verification - the proven path, for promotion to a scripted test.
  trace?: TraceStep[];
  approval?: Approval;
}

/** Mode A: one persona exploration session. Events + critiques are filled by the live agent. */
export interface DogfoodSession {
  kind: 'dogfood';
  createdAt: string;
  persona: Persona;
  startUrl?: string;
  stepsUsed: number;
  routesVisited: string[];
  goalsCompleted: string[];
  goalsAbandoned: string[];
  events: FrictionEvent[];
  critiques: EventCritique[];
  trace?: TraceStep[];
  approval?: Approval;
}

function writeJsonFile(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
}

export function ticketVerifySessionPath(ticketKey: string): string {
  return tenantDataPath('manualTester', 'ticket-verify', `${ticketKey}.json`);
}

export function writeTicketVerifySession(
  session: TicketVerifySession,
  filePath: string = ticketVerifySessionPath(session.ticket.key),
): string {
  writeJsonFile(filePath, session);
  return filePath;
}

export function readTicketVerifySession(filePath: string): TicketVerifySession {
  return readJsonFile<TicketVerifySession>(filePath);
}

export function dogfoodSessionPath(personaId: string, timestamp: string): string {
  return tenantDataPath('manualTester', 'dogfood', `${personaId}-${timestamp}.json`);
}

export function writeDogfoodSession(session: DogfoodSession, filePath: string): string {
  writeJsonFile(filePath, session);
  return filePath;
}

export function readDogfoodSession(filePath: string): DogfoodSession {
  return readJsonFile<DogfoodSession>(filePath);
}

export function stampApproval(operator: string): Approval {
  return { approvedBy: operator, approvedAt: new Date().toISOString() };
}

/**
 * The filing gate: throws unless a human has run the corresponding -approve stage, which stamps
 * `approval` onto the session on disk. Same posture as assertGateApproved() in the orchestrator - a
 * caller cannot talk past it, because the check is against a stamp that only exists if that stage
 * actually ran.
 */
export function assertApproved(session: { approval?: Approval }, approveCommand: string): void {
  if (!session.approval) {
    throw new Error(
      'This write to Jira is human-gated and has not been approved yet. Run ' +
        `"${approveCommand}" first - a human must approve before anything is posted.`,
    );
  }
}
