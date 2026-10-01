import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTicketSummaryText } from './buildTicketSummary';
import { TicketSummaryData } from './gatherTicketSummary';

function baseData(overrides: Partial<TicketSummaryData> = {}): TicketSummaryData {
  return {
    jiraKey: 'KAN-3',
    externalCaseIds: [],
    testFilePaths: [],
    healing: { total: 0, passedNoHealNeeded: 0, healed: 0, escalated: 0 },
    ...overrides,
  };
}

function blockTexts(blocks: unknown[]): string[] {
  return blocks.map((b: any) => b.text?.text ?? b.elements?.[0]?.text ?? '');
}

test('buildTicketSummaryText includes the Jira summary in the headline when available', () => {
  const message = buildTicketSummaryText(baseData({ jiraSummary: 'Navigate to and Display Student Profile' }));
  assert.match(message.text, /KAN-3 - Navigate to and Display Student Profile/);
});

test('buildTicketSummaryText falls back to just the key when Jira summary is unavailable', () => {
  const message = buildTicketSummaryText(baseData());
  const header = message.blocks[0] as any;
  assert.match(header.text.text, /Ticket summary - KAN-3$/);
});

test('buildTicketSummaryText reports each gate as "not recorded" when unset', () => {
  const message = buildTicketSummaryText(baseData());
  assert.match(message.text, /Gate 0 \(requirements cleared\): not recorded/);
  assert.match(message.text, /Gate 1 \(scenarios approved\): not recorded/);
  assert.match(message.text, /Gate 2 \(test cases approved\): not recorded/);
});

test('buildTicketSummaryText includes gate timestamps and attribution when recorded', () => {
  const message = buildTicketSummaryText(
    baseData({
      gate0ClearedAt: '2026-08-01T00:00:00.000Z',
      gate1ApprovedAt: '2026-08-02T00:00:00.000Z',
      gate1ApprovedBy: 'qa-lead@example.com',
    }),
  );
  assert.match(message.text, /Gate 0 \(requirements cleared\): 2026-08-01T00:00:00.000Z/);
  assert.match(message.text, /Gate 1 \(scenarios approved\): 2026-08-02T00:00:00.000Z \(by qa-lead@example.com\)/);
});

test('buildTicketSummaryText reports no TMS run when none exists yet', () => {
  const message = buildTicketSummaryText(baseData());
  assert.match(message.text, /no run recorded yet for KAN-3/);
});

test('buildTicketSummaryText lists run/case details when a TMS run exists', () => {
  const message = buildTicketSummaryText(
    baseData({ tmsProvider: 'qase', runId: '3', externalCaseIds: ['8', '9', '10', '11'] }),
  );
  const texts = blockTexts(message.blocks);
  assert.ok(texts.some((t) => t.includes('qase, run 3, 4 cases (8, 9, 10, 11)')));
});

test('buildTicketSummaryText singularizes "1 case" and "1 event"', () => {
  const message = buildTicketSummaryText(
    baseData({
      runId: '1',
      externalCaseIds: ['5'],
      healing: { total: 1, passedNoHealNeeded: 1, healed: 0, escalated: 0 },
    }),
  );
  assert.match(message.text, /1 case \(5\)/);
  assert.match(message.text, /\(1 event\)/);
});

test('buildTicketSummaryText lists test files when traceability entries exist', () => {
  const message = buildTicketSummaryText(
    baseData({ testFilePaths: ['tests/ui/student/profile.spec.ts', 'tests/ui/student/layout.spec.ts'] }),
  );
  assert.match(message.text, /Tests \(2\):/);
  assert.match(message.text, /tests\/ui\/student\/profile\.spec\.ts/);
  assert.match(message.text, /tests\/ui\/student\/layout\.spec\.ts/);
});

test('buildTicketSummaryText reports no tests recorded when traceability has no entries', () => {
  const message = buildTicketSummaryText(baseData());
  assert.match(message.text, /Tests:\* none recorded in data[\\/]default[\\/]traceability[\\/]manifest\.json yet/);
});

test('buildTicketSummaryText summarizes healing outcomes when events exist', () => {
  const message = buildTicketSummaryText(
    baseData({ healing: { total: 4, passedNoHealNeeded: 3, healed: 1, escalated: 0 } }),
  );
  assert.match(message.text, /3 passed clean \/ 1 healed \/ 0 escalated \(4 events\)/);
});
