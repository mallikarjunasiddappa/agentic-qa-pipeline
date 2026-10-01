import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCostEvents, pairMarkers, parseMetricBlocks } from './parseAgentLog';
import type { AgentMarker } from './recordMarker';

const BASE_TS = 1785931769;

function costBlock(subagentValue: number | null, tickOffsetSec: number, model = 'claude-sonnet-5'): string {
  const endTime = `[ ${BASE_TS + tickOffsetSec}, 0 ]`;
  const subagentPoint =
    subagentValue === null
      ? ''
      : `, {
      attributes: { model: "${model}", query_source: "subagent", "agent.name": "custom" },
      startTime: [ ${BASE_TS}, 0 ],
      endTime: ${endTime},
      value: ${subagentValue},
    }`;
  return `{
  descriptor: { name: "claude_code.cost.usage", type: "COUNTER", description: "Cost", unit: "USD", valueType: 1, advice: {} },
  dataPointType: 3,
  dataPoints: [
    {
      attributes: { model: "${model}", query_source: "main", effort: "high" },
      startTime: [ ${BASE_TS}, 0 ],
      endTime: ${endTime},
      value: 0.01,
    }${subagentPoint}
  ],
}`;
}

function tokenBlock(
  subagentValue: number | null,
  tickOffsetSec: number,
  type: 'input' | 'output' | 'cacheRead' | 'cacheCreation',
  model = 'claude-sonnet-5',
): string {
  const endTime = `[ ${BASE_TS + tickOffsetSec}, 0 ]`;
  if (subagentValue === null) {
    return `{
  descriptor: { name: "claude_code.token.usage", type: "COUNTER", description: "Tokens", unit: "tokens", valueType: 1, advice: {} },
  dataPointType: 3,
  dataPoints: [],
}`;
  }
  return `{
  descriptor: { name: "claude_code.token.usage", type: "COUNTER", description: "Tokens", unit: "tokens", valueType: 1, advice: {} },
  dataPointType: 3,
  dataPoints: [
    {
      attributes: { model: "${model}", query_source: "subagent", "agent.name": "custom", type: "${type}" },
      startTime: [ ${BASE_TS}, 0 ],
      endTime: ${endTime},
      value: ${subagentValue},
    }
  ],
}`;
}

function isoAt(offsetSec: number): string {
  return new Date((BASE_TS + offsetSec) * 1000).toISOString();
}

test('parseMetricBlocks extracts blocks from util.inspect-style text, ignoring braces inside strings', () => {
  const text = `${costBlock(0.01, 5)}\n${costBlock(0.02, 6)}`;
  const blocks = parseMetricBlocks(text);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].descriptor.name, 'claude_code.cost.usage');
});

test('pairMarkers pairs sequential start/end markers per agent', () => {
  const markers: AgentMarker[] = [
    { agent: 'jira-agent', event: 'start', timestamp: isoAt(0) },
    { agent: 'jira-agent', event: 'end', timestamp: isoAt(5) },
    { agent: 'excel-agent', event: 'start', timestamp: isoAt(10) },
    { agent: 'excel-agent', event: 'end', timestamp: isoAt(15) },
  ];
  const intervals = pairMarkers(markers);
  assert.equal(intervals.length, 2);
  assert.equal(intervals[0].agent, 'jira-agent');
  assert.equal(intervals[1].agent, 'excel-agent');
});

test('buildCostEvents: single agent, cumulative counter delta from zero baseline', () => {
  const markers: AgentMarker[] = [
    { agent: 'jira-agent', event: 'start', timestamp: isoAt(0) },
    { agent: 'jira-agent', event: 'end', timestamp: isoAt(5) },
  ];
  // Ticks before start: no subagent activity. Tick at/after end: subagent cost appears.
  const log = [
    costBlock(null, 1),
    tokenBlock(null, 1, 'input'),
    costBlock(0.05, 6), // first tick after end (offset 5)
    tokenBlock(100, 6, 'input'),
    tokenBlock(50, 6, 'output'),
    tokenBlock(10, 6, 'cacheRead'),
    tokenBlock(2, 6, 'cacheCreation'),
  ].join('\n');

  const events = buildCostEvents(log, markers);
  assert.equal(events.length, 1);
  const [e] = events;
  assert.equal(e.agent, 'jira-agent');
  assert.equal(e.model, 'claude-sonnet-5');
  assert.equal(e.costUsd, 0.05);
  assert.equal(e.inputTokens, 100);
  assert.equal(e.outputTokens, 50);
  assert.equal(e.cacheReadTokens, 10);
  assert.equal(e.cacheCreationTokens, 2);
  assert.equal(e.wallClockMs, 5000);
});

test('buildCostEvents: two different agents sharing the same series are correctly separated by marker deltas', () => {
  // Reproduces the real spike finding: jira-agent then excel-agent, both landing in the SAME
  // (model, query_source=subagent, agent.name=custom) series, cumulative across both calls.
  const markers: AgentMarker[] = [
    { agent: 'jira-agent', event: 'start', timestamp: isoAt(0) },
    { agent: 'jira-agent', event: 'end', timestamp: isoAt(5) },
    { agent: 'excel-agent', event: 'start', timestamp: isoAt(10) },
    { agent: 'excel-agent', event: 'end', timestamp: isoAt(15) },
  ];

  const log = [
    costBlock(null, -1), // before anything
    costBlock(0.03, 6), // after jira-agent ends (first tick >= 5)
    costBlock(0.03, 8), // steady state between the two intervals
    costBlock(0.08, 16), // after excel-agent ends (first tick >= 15) - cumulative total now 0.08
  ].join('\n');

  const events = buildCostEvents(log, markers);
  const byAgent = Object.fromEntries(events.map((e) => [e.agent, e]));

  assert.ok(Math.abs(byAgent['jira-agent'].costUsd - 0.03) < 1e-9);
  assert.ok(Math.abs(byAgent['excel-agent'].costUsd - 0.05) < 1e-9); // 0.08 - 0.03, not the full 0.08
});

test('buildCostEvents: an interval with zero activity produces no event', () => {
  const markers: AgentMarker[] = [
    { agent: 'jira-agent', event: 'start', timestamp: isoAt(0) },
    { agent: 'jira-agent', event: 'end', timestamp: isoAt(5) },
  ];
  const log = costBlock(null, 1);
  const events = buildCostEvents(log, markers);
  assert.deepEqual(events, []);
});

test('buildCostEvents: an unpaired start marker (no matching end) produces no interval/event', () => {
  const markers: AgentMarker[] = [{ agent: 'jira-agent', event: 'start', timestamp: isoAt(0) }];
  const log = costBlock(0.05, 6);
  const events = buildCostEvents(log, markers);
  assert.deepEqual(events, []);
});

test('pairMarkers carries jiraKey from the start marker onto the interval', () => {
  const markers: AgentMarker[] = [
    { agent: 'jira-agent', event: 'start', timestamp: isoAt(0), jiraKey: 'PROJ-123' },
    { agent: 'jira-agent', event: 'end', timestamp: isoAt(5) },
  ];
  const intervals = pairMarkers(markers);
  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].jiraKey, 'PROJ-123');
});

test('pairMarkers leaves jiraKey unset when the start marker had none', () => {
  const markers: AgentMarker[] = [
    { agent: 'jira-agent', event: 'start', timestamp: isoAt(0) },
    { agent: 'jira-agent', event: 'end', timestamp: isoAt(5) },
  ];
  const intervals = pairMarkers(markers);
  assert.equal(intervals[0].jiraKey, undefined);
});

test('buildCostEvents: jiraKey from the marker flows through to the resulting CostEvent', () => {
  const markers: AgentMarker[] = [
    { agent: 'jira-agent', event: 'start', timestamp: isoAt(0), jiraKey: 'PROJ-123' },
    { agent: 'jira-agent', event: 'end', timestamp: isoAt(5) },
  ];
  const log = [costBlock(null, 1), costBlock(0.05, 6)].join('\n');
  const events = buildCostEvents(log, markers);
  assert.equal(events.length, 1);
  assert.equal(events[0].jiraKey, 'PROJ-123');
});

test('buildCostEvents: no jiraKey on the marker means no jiraKey on the event (not an empty string)', () => {
  const markers: AgentMarker[] = [
    { agent: 'jira-agent', event: 'start', timestamp: isoAt(0) },
    { agent: 'jira-agent', event: 'end', timestamp: isoAt(5) },
  ];
  const log = [costBlock(null, 1), costBlock(0.05, 6)].join('\n');
  const events = buildCostEvents(log, markers);
  assert.equal(events[0].jiraKey, undefined);
});
