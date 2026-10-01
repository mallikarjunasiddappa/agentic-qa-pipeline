import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assessEvent,
  assessEvents,
  selectFileable,
  toBugDraft,
  summarizeSession,
  FrictionEvent,
  EventCritique,
  ExplorationSession,
} from './frictionLog';

function ev(overrides: Partial<FrictionEvent> = {}): FrictionEvent {
  return {
    id: 'e1',
    kind: 'confusion',
    route: '/student/dashboard',
    step: 3,
    description: 'no visible way to continue after selecting a plan',
    reproSteps: ['open dashboard', 'select a plan', 'look for a continue action'],
    ...overrides,
  };
}

test('assessEvent: a reproducible defect with repro steps is fileable', () => {
  const a = assessEvent(ev(), { eventId: 'e1', verdict: 'defect', reproducible: true });
  assert.equal(a.fileable, true);
});

test('assessEvent: a persona misunderstanding is never fileable', () => {
  const a = assessEvent(ev(), { eventId: 'e1', verdict: 'persona-misunderstanding', reproducible: true });
  assert.equal(a.fileable, false);
  assert.match(a.reason, /persona-misunderstanding/);
});

test('assessEvent: a misread is never fileable', () => {
  const a = assessEvent(ev(), { eventId: 'e1', verdict: 'misread', reproducible: true });
  assert.equal(a.fileable, false);
});

test('assessEvent: a non-reproducible defect is not fileable', () => {
  const a = assessEvent(ev(), { eventId: 'e1', verdict: 'defect', reproducible: false });
  assert.equal(a.fileable, false);
  assert.match(a.reason, /not reproducible/);
});

test('assessEvent: a defect with no repro steps is not fileable', () => {
  const a = assessEvent(ev({ reproSteps: [] }), { eventId: 'e1', verdict: 'defect', reproducible: true });
  assert.equal(a.fileable, false);
  assert.match(a.reason, /no repro steps/);
});

test('assessEvent: a console-error defect without evidence is not fileable, but is once evidence is attached', () => {
  const noEvidence = assessEvent(ev({ kind: 'console-error' }), { eventId: 'e1', verdict: 'defect', reproducible: true });
  assert.equal(noEvidence.fileable, false);
  assert.match(noEvidence.reason, /needs evidence/);

  const withEvidence = assessEvent(
    ev({ kind: 'console-error', evidence: { consoleErrors: ['TypeError: x is undefined'] } }),
    { eventId: 'e1', verdict: 'defect', reproducible: true },
  );
  assert.equal(withEvidence.fileable, true);
});

test('assessEvent: an event with no self-critique is not fileable', () => {
  const a = assessEvent(ev(), undefined);
  assert.equal(a.fileable, false);
  assert.match(a.reason, /no self-critique/);
});

test('selectFileable returns only the events that pass the gate', () => {
  const events: FrictionEvent[] = [
    ev({ id: 'a' }),
    ev({ id: 'b' }),
    ev({ id: 'c', kind: 'error' }),
  ];
  const critiques: EventCritique[] = [
    { eventId: 'a', verdict: 'defect', reproducible: true },
    { eventId: 'b', verdict: 'persona-misunderstanding', reproducible: true },
    { eventId: 'c', verdict: 'defect', reproducible: true }, // error kind, no evidence -> filtered out
  ];
  const fileable = selectFileable(events, critiques);
  assert.deepEqual(fileable.map((e) => e.id), ['a']);
  assert.equal(assessEvents(events, critiques).length, 3);
});

test('toBugDraft embeds persona, route, expected/actual, numbered repro and evidence', () => {
  const draft = toBugDraft(
    ev({
      expected: 'a clear Continue button',
      evidence: { screenshotPath: 'data/default/manualTester/dogfood/shot-1.png', consoleErrors: ['Boom'] },
    }),
    'hurried-parent-renewal',
    'Hurried parent renewing a test-prep package',
  );
  assert.match(draft.summary, /^\[hurried-parent-renewal\]/);
  assert.match(draft.description, /Hurried parent renewing/);
  assert.match(draft.description, /Expected: a clear Continue button/);
  assert.match(draft.description, /1\. open dashboard/);
  assert.match(draft.description, /Console errors:/);
  assert.match(draft.description, /Screenshot: /);
  assert.deepEqual(draft.labels, ['manual-tester', 'persona-exploration', 'hurried-parent-renewal']);
});

test('summarizeSession counts events by kind, coverage and budget usage', () => {
  const session: ExplorationSession = {
    personaId: 'browsing-student',
    startedAt: '2026-09-30T00:00:00.000Z',
    stepsUsed: 20,
    stepBudget: 40,
    routesVisited: ['/a', '/b', '/c'],
    goalsCompleted: ['g1'],
    goalsAbandoned: ['g2'],
    events: [ev({ id: 'x', kind: 'confusion' }), ev({ id: 'y', kind: 'dead-end' }), ev({ id: 'z', kind: 'confusion' })],
  };
  const s = summarizeSession(session);
  assert.equal(s.eventsLogged, 3);
  assert.equal(s.byKind.confusion, 2);
  assert.equal(s.byKind['dead-end'], 1);
  assert.equal(s.byKind.error, 0);
  assert.equal(s.routesVisited, 3);
  assert.equal(s.goalsCompleted, 1);
  assert.equal(s.goalsAbandoned, 1);
  assert.equal(s.budgetUsedPct, 50);
});
