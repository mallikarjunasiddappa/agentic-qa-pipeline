import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  TicketVerifySession,
  DogfoodSession,
  writeTicketVerifySession,
  readTicketVerifySession,
  writeDogfoodSession,
  readDogfoodSession,
  stampApproval,
  assertApproved,
} from './sessionStore';

let tmpDir: string;
before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-session-'));
});
after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('ticket-verify session round-trips through disk', () => {
  const session: TicketVerifySession = {
    kind: 'ticket-verify',
    createdAt: '2026-09-30T00:00:00.000Z',
    ticket: { key: 'SCRUM-76', summary: 'Answer types', actionSteps: [], acceptanceCriteria: [{ id: 'AC-1', text: 't' }] },
    observations: [{ acId: 'AC-1', status: 'pass', observed: 'ok' }],
    proposals: [],
  };
  const p = path.join(tmpDir, 'tv.json');
  const written = writeTicketVerifySession(session, p);
  assert.equal(written, p);
  const back = readTicketVerifySession(p);
  assert.equal(back.ticket.key, 'SCRUM-76');
  assert.equal(back.observations[0].acId, 'AC-1');
  assert.equal(back.approval, undefined);
});

test('dogfood session round-trips through disk', () => {
  const session: DogfoodSession = {
    kind: 'dogfood',
    createdAt: '2026-09-30T00:00:00.000Z',
    persona: {
      id: 'browsing-student',
      displayName: 'Browsing student',
      goals: ['look around'],
      context: 'desktop',
      habits: [],
      blindSpots: [],
      outOfBounds: [],
      stepBudget: 40,
      timeBoxMinutes: 10,
    },
    stepsUsed: 0,
    routesVisited: [],
    goalsCompleted: [],
    goalsAbandoned: [],
    events: [],
    critiques: [],
  };
  const p = path.join(tmpDir, 'df.json');
  writeDogfoodSession(session, p);
  const back = readDogfoodSession(p);
  assert.equal(back.persona.id, 'browsing-student');
  assert.equal(back.kind, 'dogfood');
});

test('assertApproved gates on the approval stamp', () => {
  const session: { approval?: ReturnType<typeof stampApproval> } = {};
  assert.throws(() => assertApproved(session, '--stage dogfood-approve --session x'), /human-gated/);
  session.approval = stampApproval('alice@example.com');
  assert.equal(session.approval.approvedBy, 'alice@example.com');
  assert.doesNotThrow(() => assertApproved(session, '--stage dogfood-approve --session x'));
});
