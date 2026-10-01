/**
 * Mode A (persona exploration) pure core for the Manual-Tester Agent. No IO: types for a friction
 * event and an exploration session, the adversarial self-critique gate that decides which events
 * are fileable (the noise filter), the bug-draft composer, and the session/coverage summary. The
 * browser driving, evidence capture and the actual Jira filing live in the stage shell; the
 * judgement logic lives here so it is unit-testable.
 */

export type FrictionKind =
  | 'confusion'
  | 'dead-end'
  | 'label-mismatch'
  | 'error'
  | 'console-error'
  | 'broken-state'
  | 'slow';

export const FRICTION_KINDS: readonly FrictionKind[] = [
  'confusion',
  'dead-end',
  'label-mismatch',
  'error',
  'console-error',
  'broken-state',
  'slow',
];

// Kinds that assert a technical fault (not merely a UX friction) and therefore must carry evidence
// before they can be filed - a screenshot and/or captured console errors.
const EVIDENCE_REQUIRED_KINDS: readonly FrictionKind[] = ['error', 'console-error', 'broken-state'];

export interface FrictionEvidence {
  screenshotPath?: string;
  consoleErrors?: string[];
}

export interface FrictionEvent {
  id: string;
  kind: FrictionKind;
  goalId?: string;
  route: string;
  step: number;
  description: string; // what actually happened
  expected?: string; // what the persona expected instead
  reproSteps: string[];
  evidence?: FrictionEvidence;
}

/**
 * The agent's adversarial self-review of one event (trust calibration, spec section 4.2 step 4).
 * The gate below trusts these two agent judgements but enforces the fileability rules
 * deterministically - so no code path can file a persona-misunderstanding, a misread, or an
 * un-reproducible or un-evidenced event as a bug.
 */
export type CritiqueVerdict = 'defect' | 'persona-misunderstanding' | 'misread';

export interface EventCritique {
  eventId: string;
  verdict: CritiqueVerdict;
  reproducible: boolean;
}

export interface FrictionAssessment {
  eventId: string;
  fileable: boolean;
  reason: string;
}

function hasEvidence(evidence?: FrictionEvidence): boolean {
  if (!evidence) return false;
  return Boolean(evidence.screenshotPath) || (evidence.consoleErrors?.length ?? 0) > 0;
}

/**
 * The noise gate for one event. Fileable only when the agent's own critique calls it a real defect,
 * it is reproducible, it has repro steps, and (for fault-asserting kinds) it carries evidence.
 * Everything else is kept in the friction log but never filed.
 */
export function assessEvent(event: FrictionEvent, critique: EventCritique | undefined): FrictionAssessment {
  if (!critique) {
    return { eventId: event.id, fileable: false, reason: 'no self-critique recorded - not filed' };
  }
  if (critique.verdict !== 'defect') {
    return {
      eventId: event.id,
      fileable: false,
      reason: `self-critique: ${critique.verdict} - logged as friction only, not a product defect`,
    };
  }
  if (!critique.reproducible) {
    return { eventId: event.id, fileable: false, reason: 'not reproducible - needs a reliable repro before filing' };
  }
  if (event.reproSteps.length === 0) {
    return { eventId: event.id, fileable: false, reason: 'no repro steps captured - not filed' };
  }
  if (EVIDENCE_REQUIRED_KINDS.includes(event.kind) && !hasEvidence(event.evidence)) {
    return {
      eventId: event.id,
      fileable: false,
      reason: `a "${event.kind}" defect needs evidence (screenshot and/or console) before filing`,
    };
  }
  return { eventId: event.id, fileable: true, reason: 'reproducible product defect with repro steps' };
}

export function assessEvents(events: FrictionEvent[], critiques: EventCritique[]): FrictionAssessment[] {
  const byId = new Map(critiques.map((c) => [c.eventId, c]));
  return events.map((e) => assessEvent(e, byId.get(e.id)));
}

/** The subset of events that survive the gate - the only ones a human is asked to approve for filing. */
export function selectFileable(events: FrictionEvent[], critiques: EventCritique[]): FrictionEvent[] {
  const assessments = new Map(assessEvents(events, critiques).map((a) => [a.eventId, a]));
  return events.filter((e) => assessments.get(e.id)?.fileable);
}

export interface PersonaBugDraft {
  summary: string;
  description: string;
  labels: string[];
}

/**
 * Turns a fileable friction event into a bug draft in the BugReport shape (summary/description/
 * labels) that JiraAdapter.createBug consumes. The persona context is part of the report - a bug is
 * far more actionable when the reader knows which user it hit and what they expected.
 */
export function toBugDraft(event: FrictionEvent, personaId: string, personaDisplayName: string): PersonaBugDraft {
  const lines: string[] = [];
  lines.push(`Found by the Manual-Tester Agent (persona: ${personaDisplayName}).`);
  lines.push(`Route: ${event.route}`);
  if (event.expected) lines.push(`Expected: ${event.expected}`);
  lines.push(`Actual: ${event.description}`);
  lines.push('Steps to reproduce:');
  event.reproSteps.forEach((s, i) => lines.push(`  ${i + 1}. ${s}`));
  if (event.evidence?.consoleErrors?.length) {
    lines.push('Console errors:');
    for (const err of event.evidence.consoleErrors) lines.push(`  ${err}`);
  }
  if (event.evidence?.screenshotPath) lines.push(`Screenshot: ${event.evidence.screenshotPath}`);
  return {
    summary: `[${personaId}] ${event.description}`.slice(0, 255),
    description: lines.join('\n'),
    labels: ['manual-tester', 'persona-exploration', personaId],
  };
}

export interface ExplorationSession {
  personaId: string;
  startUrl?: string;
  startedAt: string;
  stepsUsed: number;
  stepBudget: number;
  routesVisited: string[];
  goalsCompleted: string[];
  goalsAbandoned: string[];
  events: FrictionEvent[];
}

export interface SessionSummary {
  personaId: string;
  eventsLogged: number;
  byKind: Record<FrictionKind, number>;
  routesVisited: number;
  goalsCompleted: number;
  goalsAbandoned: number;
  budgetUsedPct: number;
}

/** Rolls one exploration session into the coverage/summary numbers (spec section 8). */
export function summarizeSession(session: ExplorationSession): SessionSummary {
  const byKind = {} as Record<FrictionKind, number>;
  for (const k of FRICTION_KINDS) byKind[k] = 0;
  for (const e of session.events) byKind[e.kind] += 1;
  return {
    personaId: session.personaId,
    eventsLogged: session.events.length,
    byKind,
    routesVisited: session.routesVisited.length,
    goalsCompleted: session.goalsCompleted.length,
    goalsAbandoned: session.goalsAbandoned.length,
    budgetUsedPct: session.stepBudget > 0 ? Math.round((session.stepsUsed / session.stepBudget) * 100) : 0,
  };
}
