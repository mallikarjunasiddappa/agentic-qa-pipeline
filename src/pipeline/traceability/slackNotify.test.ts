import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDriftCheckSlackMessage, postDriftCheckToSlack } from './slackNotify';
import { DriftCheckResult } from './traceabilityAgent';

function result(overrides: Partial<DriftCheckResult['counts']> = {}): DriftCheckResult {
  return {
    entries: [],
    counts: {
      IN_SYNC: 6,
      CASE_DRIFTED: 0,
      TEST_DRIFTED: 0,
      BOTH_DRIFTED: 0,
      ORPHANED_CASE: 0,
      ORPHANED_TEST: 0,
      ...overrides,
    },
  };
}

function blockTexts(blocks: unknown[]): string[] {
  return blocks.map((b: any) => b.text?.text ?? b.elements?.[0]?.text ?? '');
}

test('buildDriftCheckSlackMessage headlines "all in sync" when nothing is drifted', () => {
  const message = buildDriftCheckSlackMessage(result(), []);
  assert.match(message.text, /all in sync/);
  const header = message.blocks[0] as any;
  assert.equal(header.type, 'header');
  assert.match(header.text.text, /all in sync/);
});

test('buildDriftCheckSlackMessage headlines the out-of-sync count when something is drifted', () => {
  const message = buildDriftCheckSlackMessage(result({ CASE_DRIFTED: 2, ORPHANED_TEST: 1 }), []);
  assert.match(message.text, /3 entries are out of sync/);
});

test('buildDriftCheckSlackMessage singularizes "1 entry is" for exactly one out-of-sync entry', () => {
  const message = buildDriftCheckSlackMessage(result({ CASE_DRIFTED: 1 }), []);
  assert.match(message.text, /1 entry is out of sync/);
});

test('buildDriftCheckSlackMessage includes every sync state count in the body', () => {
  const message = buildDriftCheckSlackMessage(result({ CASE_DRIFTED: 2 }), []);
  const texts = blockTexts([message.blocks[1]]);
  assert.match(texts[0], /IN_SYNC:\* 6/);
  assert.match(texts[0], /CASE_DRIFTED:\* 2/);
  assert.match(texts[0], /ORPHANED_TEST:\* 0/);
});

test('buildDriftCheckSlackMessage lists newly-posted Jira comments when present', () => {
  const message = buildDriftCheckSlackMessage(result({ CASE_DRIFTED: 3 }), [
    { jiraKey: 'KAN-1', entryCount: 2 },
    { jiraKey: 'KAN-2', entryCount: 1 },
  ]);
  const texts = blockTexts(message.blocks);
  assert.ok(texts.some((t) => t.includes('KAN-1') && t.includes('2 newly drifted entries')));
  assert.ok(texts.some((t) => t.includes('KAN-2') && t.includes('1 newly drifted entry')));
});

test('buildDriftCheckSlackMessage omits the Jira-comments block when nothing new was posted', () => {
  const message = buildDriftCheckSlackMessage(result(), []);
  // header + counts + context = 3 blocks; no separate "New drift flagged on Jira" section
  assert.equal(message.blocks.length, 3);
});

test('buildDriftCheckSlackMessage falls back to the local file path when no report URL is given', () => {
  const message = buildDriftCheckSlackMessage(result(), []);
  const context = message.blocks[message.blocks.length - 1] as any;
  assert.match(context.elements[0].text, /`data[\\/]default[\\/]traceability[\\/]report\.md`/);
});

test('buildDriftCheckSlackMessage links to the report URL as a real Slack link when one is provided', () => {
  const message = buildDriftCheckSlackMessage(result(), [], 'https://your-org.github.io/agentic-qa-pipeline/traceability/report.html');
  const context = message.blocks[message.blocks.length - 1] as any;
  assert.equal(
    context.elements[0].text,
    '<https://your-org.github.io/agentic-qa-pipeline/traceability/report.html|Full report>',
  );
});

test('postDriftCheckToSlack skips silently when no webhook URL is configured', async () => {
  await assert.doesNotReject(postDriftCheckToSlack(result(), [], undefined));
});
