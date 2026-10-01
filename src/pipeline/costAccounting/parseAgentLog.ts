import { CostEvent } from '../types/schemas';
import { AgentMarker } from './recordMarker';

interface RawDataPoint {
  attributes: Record<string, unknown>;
  startTime: [number, number];
  endTime: [number, number];
  value: number;
}

interface RawMetricBlock {
  descriptor: { name: string };
  dataPointType: number;
  dataPoints: RawDataPoint[];
}

/**
 * Extracts top-level `{...}` blocks from Claude Code's console OTel exporter output, respecting
 * string literals so braces inside strings don't confuse the brace counter. The exporter's format
 * is `util.inspect`-style JS object-literal text, not JSON (unquoted keys, trailing commas,
 * `[seconds, nanoseconds]` hrtime tuples) - confirmed empirically against a real spike, not
 * assumed from docs.
 */
function extractTopLevelBlocks(text: string): string[] {
  const blocks: string[] = [];
  let depth = 0;
  let start = -1;
  let inString: string | null = null;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === inString && text[i - 1] !== '\\') inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        blocks.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return blocks;
}

/**
 * Parses one block as a JS object-literal expression - valid because util.inspect's default
 * output format IS valid JS object/array literal syntax. Using `new Function` (not `eval`) so it
 * can't see or touch the surrounding closure; this only ever runs on our own captured telemetry
 * output, not untrusted input.
 */
function parseBlock(blockText: string): RawMetricBlock | null {
  try {
    // eslint-disable-next-line no-new-func
    const value = new Function(`"use strict"; return (${blockText});`)() as unknown;
    if (
      value &&
      typeof value === 'object' &&
      'descriptor' in value &&
      'dataPoints' in value &&
      Array.isArray((value as RawMetricBlock).dataPoints)
    ) {
      return value as RawMetricBlock;
    }
  } catch {
    // Truncated/malformed block (e.g. log captured mid-write) - skip it rather than fail the run.
  }
  return null;
}

export function parseMetricBlocks(logText: string): RawMetricBlock[] {
  return extractTopLevelBlocks(logText)
    .map(parseBlock)
    .filter((b): b is RawMetricBlock => b !== null);
}

function hrtimeToSeconds(t: [number, number] | undefined): number {
  if (!t) return 0;
  return t[0] + t[1] / 1e9;
}

interface SeriesPoint {
  tickTime: number;
  value: number;
}

/**
 * Builds one cumulative-counter time series for a given metric + model, scoped to
 * query_source === "subagent" (excludes the top-level session's own "main" reasoning and
 * "auxiliary" background calls - only nested subagent dispatches count as agent cost).
 */
function buildSeries(
  blocks: RawMetricBlock[],
  metricName: string,
  model: string,
  matchAttrs: (attrs: Record<string, unknown>) => boolean,
): SeriesPoint[] {
  const points: SeriesPoint[] = [];
  for (const block of blocks) {
    if (block.descriptor.name !== metricName) continue;
    for (const dp of block.dataPoints) {
      if (dp.attributes.query_source !== 'subagent') continue;
      if (dp.attributes.model !== model) continue;
      if (!matchAttrs(dp.attributes)) continue;
      points.push({ tickTime: hrtimeToSeconds(dp.endTime), value: dp.value });
    }
  }
  points.sort((a, b) => a.tickTime - b.tickTime);
  return points;
}

/**
 * Delta between the last tick at/before `startTs` (baseline - "already accumulated when this
 * agent started") and the first tick at/after `endTs` (final - "fully includes this agent's
 * activity"). This is required, not optional: confirmed empirically that these are CUMULATIVE
 * counters that never reset, and that two different subagents sharing the same
 * (model, effort, query_source=subagent) attributes land in the SAME series - agent.name is
 * always "custom" and can't tell them apart. A single end-of-session read would give the combined
 * total of every subagent call sharing that series, not just one. See README's Cost/Latency
 * Accounting section for the spike that proved this.
 */
function deltaForInterval(series: SeriesPoint[], startTs: number, endTs: number): number {
  let baselineValue = 0;
  for (const p of series) {
    if (p.tickTime <= startTs) baselineValue = p.value;
    else break;
  }

  let finalValue = baselineValue;
  let foundAfterEnd = false;
  for (const p of series) {
    if (p.tickTime >= endTs) {
      finalValue = p.value;
      foundAfterEnd = true;
      break;
    }
  }
  if (!foundAfterEnd && series.length > 0) {
    finalValue = series[series.length - 1].value;
  }

  return Math.max(0, finalValue - baselineValue);
}

export interface AgentInterval {
  agent: string;
  startTs: number;
  endTs: number;
  startIso: string;
  endIso: string;
  // Carried from the *start* marker only (see AgentMarker.jiraKey's comment) - the end marker's
  // jiraKey, if present, is never consulted.
  jiraKey?: string;
}

/** Pairs start/end markers per agent, in order. Assumes non-overlapping (sequential) dispatches. */
export function pairMarkers(markers: AgentMarker[]): AgentInterval[] {
  const intervals: AgentInterval[] = [];
  const open = new Map<string, { ts: number; iso: string; jiraKey?: string }>();

  for (const m of markers) {
    const ts = Date.parse(m.timestamp) / 1000;
    if (m.event === 'start') {
      open.set(m.agent, { ts, iso: m.timestamp, jiraKey: m.jiraKey });
    } else {
      const startEntry = open.get(m.agent);
      if (startEntry) {
        intervals.push({
          agent: m.agent,
          startTs: startEntry.ts,
          endTs: ts,
          startIso: startEntry.iso,
          endIso: m.timestamp,
          ...(startEntry.jiraKey ? { jiraKey: startEntry.jiraKey } : {}),
        });
        open.delete(m.agent);
      }
    }
  }

  return intervals;
}

function discoverSubagentModels(blocks: RawMetricBlock[]): string[] {
  const models = new Set<string>();
  for (const block of blocks) {
    if (block.descriptor.name !== 'claude_code.cost.usage') continue;
    for (const dp of block.dataPoints) {
      if (dp.attributes.query_source === 'subagent' && typeof dp.attributes.model === 'string') {
        models.add(dp.attributes.model);
      }
    }
  }
  return [...models];
}

/**
 * Builds one CostEvent per (agent interval, model) pair that had any nonzero cost/token activity.
 * Pure: no filesystem access, directly unit-testable against synthetic multi-tick log text.
 */
export function buildCostEvents(logText: string, markers: AgentMarker[]): CostEvent[] {
  const blocks = parseMetricBlocks(logText);
  const intervals = pairMarkers(markers);
  const models = discoverSubagentModels(blocks);
  const events: CostEvent[] = [];

  for (const interval of intervals) {
    for (const model of models) {
      const costSeries = buildSeries(blocks, 'claude_code.cost.usage', model, () => true);
      const inputSeries = buildSeries(blocks, 'claude_code.token.usage', model, (a) => a.type === 'input');
      const outputSeries = buildSeries(blocks, 'claude_code.token.usage', model, (a) => a.type === 'output');
      const cacheReadSeries = buildSeries(
        blocks,
        'claude_code.token.usage',
        model,
        (a) => a.type === 'cacheRead',
      );
      const cacheCreationSeries = buildSeries(
        blocks,
        'claude_code.token.usage',
        model,
        (a) => a.type === 'cacheCreation',
      );

      const costUsd = deltaForInterval(costSeries, interval.startTs, interval.endTs);
      const inputTokens = deltaForInterval(inputSeries, interval.startTs, interval.endTs);
      const outputTokens = deltaForInterval(outputSeries, interval.startTs, interval.endTs);
      const cacheReadTokens = deltaForInterval(cacheReadSeries, interval.startTs, interval.endTs);
      const cacheCreationTokens = deltaForInterval(cacheCreationSeries, interval.startTs, interval.endTs);

      const hadAnyActivity =
        costUsd > 0 || inputTokens > 0 || outputTokens > 0 || cacheReadTokens > 0 || cacheCreationTokens > 0;
      if (!hadAnyActivity) continue;

      events.push({
        timestamp: interval.endIso,
        agent: interval.agent,
        model,
        inputTokens: Math.round(inputTokens),
        outputTokens: Math.round(outputTokens),
        cacheReadTokens: Math.round(cacheReadTokens),
        cacheCreationTokens: Math.round(cacheCreationTokens),
        costUsd,
        wallClockMs: Math.round((interval.endTs - interval.startTs) * 1000),
        ...(interval.jiraKey ? { jiraKey: interval.jiraKey } : {}),
      });
    }
  }

  return events;
}
