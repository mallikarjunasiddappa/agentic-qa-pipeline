import fs from 'node:fs';
import path from 'node:path';
import { CostEvent } from '../types/schemas';
import { isoWeekKey } from '../shared/isoWeek';
import { tenantDataPath } from '../config/tenantContext';

export function REPORT_JSON_PATH(): string { return tenantDataPath('cost', 'report.json'); }
export function REPORT_MD_PATH(): string { return tenantDataPath('cost', 'report.md'); }

// Kebab-cases and strips anything that isn't safe in a filename, so an arbitrary --issue value
// (Jira keys are normally PROJ-123, but this stays defensive) can't escape the cost/ directory or
// collide with REPORT_JSON_PATH/REPORT_MD_PATH above.
function slugifyIssue(jiraKey: string): string {
  return jiraKey.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Per-ticket report file paths for --stage cost-report --issue <KEY>, e.g. cost/report-proj-123.json. */
export function buildIssueReportPaths(jiraKey: string): { reportJsonPath: string; reportMdPath: string } {
  const slug = slugifyIssue(jiraKey);
  return {
    reportJsonPath: tenantDataPath('cost', `report-${slug}.json`),
    reportMdPath: tenantDataPath('cost', `report-${slug}.md`),
  };
}

/**
 * Pure filter for --stage cost-report --issue <KEY> - keeps only events recorded against that
 * ticket (see CostEventSchema.jiraKey). An event with no jiraKey at all (recorded before this
 * field existed, or from a non-ticket-scoped dispatch like pipeline-report) never matches any
 * --issue filter, which is the correct behavior: it was never attributed to this ticket in the
 * first place, so it shouldn't silently show up in one ticket's scoped report.
 */
export function filterEventsByIssue(events: CostEvent[], jiraKey: string): CostEvent[] {
  return events.filter((e) => e.jiraKey === jiraKey);
}

// "Roughly 2x+" per the spec - a single agent's own historical median is the baseline, not a
// cross-agent comparison, since different agents legitimately cost different amounts.
export const RUNAWAY_THRESHOLD_MULTIPLIER = 2;

export interface AgentWeekStats {
  week: string;
  agent: string;
  invocations: number;
  totalCostUsd: number;
  totalWallClockMs: number;
  avgCostUsd: number;
  medianCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
}

export interface AgentTrend {
  agent: string;
  currentWeek: string;
  currentWeekTotalCostUsd: number | null;
  previousWeek: string;
  previousWeekTotalCostUsd: number | null;
  deltaPct: number | null; // percentage change in total cost, current vs previous week
}

export interface RunawayFlag {
  event: CostEvent;
  agentMedianCostUsd: number;
  ratio: number;
}

export interface CostReport {
  generatedAt: string;
  totalEvents: number;
  overall: {
    totalCostUsd: number;
    totalWallClockMs: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCacheReadTokens: number;
    totalCacheCreationTokens: number;
  };
  byWeekAndAgent: AgentWeekStats[];
  trendByAgent: AgentTrend[];
  runawayFlags: RunawayFlag[];
  // Set when this report was built from filterEventsByIssue(events, jiraKey) - i.e. a
  // --stage cost-report --issue <KEY> run - so the JSON/Markdown/Slack output can say what it's
  // scoped to instead of looking like (and being mistaken for) the full aggregate report.
  scopedToIssue?: string;
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Computes total cost/time per agent per week, week-over-week trend, and flags any single
 * invocation costing >= RUNAWAY_THRESHOLD_MULTIPLIER times that same agent's own median cost
 * across its full history (not a cross-agent comparison - different agents legitimately cost
 * different amounts, so each agent is only judged against itself).
 */
export function buildCostReport(events: CostEvent[], now: Date = new Date(), scopedToIssue?: string): CostReport {
  const costsByAgent = new Map<string, number[]>();
  for (const e of events) {
    const list = costsByAgent.get(e.agent) ?? [];
    list.push(e.costUsd);
    costsByAgent.set(e.agent, list);
  }
  const medianByAgent = new Map<string, number>();
  for (const [agent, costs] of costsByAgent) medianByAgent.set(agent, median(costs));

  const runawayFlags: RunawayFlag[] = [];
  for (const e of events) {
    const agentMedianCostUsd = medianByAgent.get(e.agent) ?? 0;
    if (agentMedianCostUsd <= 0) continue;
    const ratio = e.costUsd / agentMedianCostUsd;
    if (ratio >= RUNAWAY_THRESHOLD_MULTIPLIER) {
      runawayFlags.push({ event: e, agentMedianCostUsd, ratio });
    }
  }

  const byWeekAgentKey = new Map<string, CostEvent[]>();
  for (const e of events) {
    const key = `${isoWeekKey(new Date(e.timestamp))}::${e.agent}`;
    const list = byWeekAgentKey.get(key) ?? [];
    list.push(e);
    byWeekAgentKey.set(key, list);
  }

  const byWeekAndAgent: AgentWeekStats[] = [];
  for (const [key, groupEvents] of byWeekAgentKey) {
    const [week, agent] = key.split('::');
    const costs = groupEvents.map((e) => e.costUsd);
    const totalCostUsd = costs.reduce((sum, c) => sum + c, 0);
    const totalWallClockMs = groupEvents.reduce((sum, e) => sum + e.wallClockMs, 0);
    byWeekAndAgent.push({
      week,
      agent,
      invocations: groupEvents.length,
      totalCostUsd,
      totalWallClockMs,
      avgCostUsd: totalCostUsd / groupEvents.length,
      medianCostUsd: median(costs),
      totalInputTokens: groupEvents.reduce((sum, e) => sum + e.inputTokens, 0),
      totalOutputTokens: groupEvents.reduce((sum, e) => sum + e.outputTokens, 0),
      totalCacheReadTokens: groupEvents.reduce((sum, e) => sum + e.cacheReadTokens, 0),
      totalCacheCreationTokens: groupEvents.reduce((sum, e) => sum + e.cacheCreationTokens, 0),
    });
  }
  byWeekAndAgent.sort((a, b) =>
    a.week === b.week ? a.agent.localeCompare(b.agent) : a.week.localeCompare(b.week),
  );

  const agents = [...new Set(events.map((e) => e.agent))].sort();
  const currentWeek = isoWeekKey(now);
  const previousWeek = isoWeekKey(new Date(now.getTime() - 7 * 24 * 3600 * 1000));

  const trendByAgent: AgentTrend[] = agents.map((agent) => {
    const current = byWeekAndAgent.find((s) => s.week === currentWeek && s.agent === agent);
    const previous = byWeekAndAgent.find((s) => s.week === previousWeek && s.agent === agent);
    const currentWeekTotalCostUsd = current?.totalCostUsd ?? null;
    const previousWeekTotalCostUsd = previous?.totalCostUsd ?? null;
    const deltaPct =
      currentWeekTotalCostUsd !== null && previousWeekTotalCostUsd !== null && previousWeekTotalCostUsd > 0
        ? ((currentWeekTotalCostUsd - previousWeekTotalCostUsd) / previousWeekTotalCostUsd) * 100
        : null;
    return { agent, currentWeek, currentWeekTotalCostUsd, previousWeek, previousWeekTotalCostUsd, deltaPct };
  });

  return {
    generatedAt: now.toISOString(),
    totalEvents: events.length,
    overall: {
      totalCostUsd: events.reduce((sum, e) => sum + e.costUsd, 0),
      totalWallClockMs: events.reduce((sum, e) => sum + e.wallClockMs, 0),
      totalInputTokens: events.reduce((sum, e) => sum + e.inputTokens, 0),
      totalOutputTokens: events.reduce((sum, e) => sum + e.outputTokens, 0),
      totalCacheReadTokens: events.reduce((sum, e) => sum + e.cacheReadTokens, 0),
      totalCacheCreationTokens: events.reduce((sum, e) => sum + e.cacheCreationTokens, 0),
    },
    byWeekAndAgent,
    trendByAgent,
    runawayFlags,
    ...(scopedToIssue ? { scopedToIssue } : {}),
  };
}

/**
 * `paths` defaults to the shared aggregate report (REPORT_JSON_PATH/REPORT_MD_PATH). --stage
 * cost-report --issue <KEY> passes buildIssueReportPaths(jiraKey) instead, so a ticket-scoped run
 * writes its own cost/report-<key>.json/.md rather than overwriting the aggregate report everyone
 * else relies on.
 */
export function writeCostReports(
  report: CostReport,
  paths: { reportJsonPath: string; reportMdPath: string } = {
    reportJsonPath: REPORT_JSON_PATH(),
    reportMdPath: REPORT_MD_PATH(),
  },
): { reportJsonPath: string; reportMdPath: string } {
  const { reportJsonPath, reportMdPath } = paths;
  fs.mkdirSync(path.dirname(reportJsonPath), { recursive: true });
  fs.writeFileSync(reportJsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
  fs.writeFileSync(reportMdPath, buildReportMarkdown(report), 'utf-8');
  return { reportJsonPath, reportMdPath };
}

function usd(n: number): string {
  return `$${n.toFixed(6)}`;
}

function fmtTokens(n: number): string {
  return n.toLocaleString('en-US');
}

function buildReportMarkdown(report: CostReport): string {
  const title = report.scopedToIssue
    ? `# Cost & Latency Report — ${report.scopedToIssue}`
    : '# Cost & Latency Report';
  const lines: string[] = [title, '', `Generated: ${report.generatedAt}`, ''];

  lines.push('## Overall', '');
  lines.push(`- Total events: ${report.totalEvents}`);
  lines.push(`- Total cost: ${usd(report.overall.totalCostUsd)}`);
  lines.push(`- Total wall-clock time: ${(report.overall.totalWallClockMs / 1000).toFixed(1)}s`);
  lines.push(
    `- Total tokens: ${fmtTokens(report.overall.totalInputTokens)} in / ` +
      `${fmtTokens(report.overall.totalOutputTokens)} out / ` +
      `${fmtTokens(report.overall.totalCacheReadTokens)} cache-read / ` +
      `${fmtTokens(report.overall.totalCacheCreationTokens)} cache-creation`,
  );
  lines.push('');

  if (report.runawayFlags.length > 0) {
    lines.push(`## Runaway invocations (>= ${RUNAWAY_THRESHOLD_MULTIPLIER}x that agent's own median)`, '');
    for (const flag of report.runawayFlags) {
      lines.push(
        `- **${flag.event.agent}** at ${flag.event.timestamp}: ${usd(flag.event.costUsd)} ` +
          `(${flag.ratio.toFixed(1)}x median of ${usd(flag.agentMedianCostUsd)})`,
      );
    }
    lines.push('');
  }

  lines.push(
    '## Week-over-week trend by agent',
    '',
    '| Agent | Previous week | This week | Δ |',
    '|---|---|---|---|',
  );
  for (const trend of report.trendByAgent) {
    const prev = trend.previousWeekTotalCostUsd === null ? 'n/a' : usd(trend.previousWeekTotalCostUsd);
    const curr = trend.currentWeekTotalCostUsd === null ? 'n/a' : usd(trend.currentWeekTotalCostUsd);
    const delta =
      trend.deltaPct === null ? 'n/a' : `${trend.deltaPct >= 0 ? '+' : ''}${trend.deltaPct.toFixed(1)}%`;
    lines.push(
      `| ${trend.agent} | ${prev} (${trend.previousWeek}) | ${curr} (${trend.currentWeek}) | ${delta} |`,
    );
  }
  lines.push('');

  lines.push('## By week and agent', '');
  for (const stats of report.byWeekAndAgent) {
    lines.push(`### ${stats.week} — ${stats.agent}`, '');
    lines.push(`- Invocations: ${stats.invocations}`);
    lines.push(
      `- Total cost: ${usd(stats.totalCostUsd)}, avg: ${usd(stats.avgCostUsd)}, median: ${usd(stats.medianCostUsd)}`,
    );
    lines.push(`- Total wall-clock: ${(stats.totalWallClockMs / 1000).toFixed(1)}s`);
    lines.push(
      `- Total tokens: ${fmtTokens(stats.totalInputTokens)} in / ${fmtTokens(stats.totalOutputTokens)} out ` +
        `/ ${fmtTokens(stats.totalCacheReadTokens)} cache-read / ${fmtTokens(stats.totalCacheCreationTokens)} cache-creation`,
    );
    lines.push('');
  }

  return lines.join('\n');
}
