import fs from 'node:fs';
import path from 'node:path';
import { CostReport } from '../costAccounting/costReport';
import { HealingReport } from '../telemetry/healingReport';
import { FlakyReport } from '../flaky/flakyReport';
import { PromptVersionReport } from '../promptVersions/buildChangelog';
import { REPORT_JSON_PATH as TRACEABILITY_REPORT_JSON_PATH } from '../traceability/report';
import { SyncState } from '../types/schemas';
import { renderMarkdownToHtml, wrapReportPage } from '../shared/markdownToHtml';
import { REPORT_PAGE_BASE_CSS } from '../shared/reportPageStyle';
import { tenantDataPath } from '../config/tenantContext';

export function REPORT_JSON_PATH(): string { return tenantDataPath('pipelineReport', 'report.json'); }
export function REPORT_HTML_PATH(): string { return tenantDataPath('pipelineReport', 'report.html'); }

// Roughly the daily drift-check cron (.github/workflows/drift-check.yml) plus slack for a run
// landing late or being skipped once - not a hard technical constraint, just the point past which
// a "last checked" traceability snapshot is old enough to be worth calling out rather than trusting.
const TRACEABILITY_STALE_THRESHOLD_MS = 36 * 60 * 60 * 1000;

export interface TraceabilitySummary {
  available: boolean;
  generatedAt: string | null;
  stale: boolean;
  counts: Record<SyncState, number> | null;
}

export interface PromptVersionsSummary {
  totalCommits: number;
  byAgent: { agentFile: string; commitCount: number }[];
}

export interface PipelineReport {
  generatedAt: string;
  cost: Pick<CostReport, 'totalEvents' | 'overall' | 'runawayFlags'>;
  healing: HealingReport['overall'] & { totalEvents: number };
  flaky: Pick<FlakyReport, 'currentlyActive' | 'totalQuarantinedAllTime'>;
  traceability: TraceabilitySummary;
  promptVersions: PromptVersionsSummary;
  attentionFlags: string[];
}

const NON_SYNCED_STATES: SyncState[] = [
  'CASE_DRIFTED',
  'TEST_DRIFTED',
  'BOTH_DRIFTED',
  'ORPHANED_CASE',
  'ORPHANED_TEST',
];

/**
 * Reads the traceability domain's own already-written report.json rather than re-running
 * checkDrift() itself - drift-checking makes live TMS/Jira calls and posts comments on newly
 * drifted entries, which would be a surprising side effect of someone just asking "what's the
 * pipeline's current health," not something a report-viewing command should trigger. This is a
 * snapshot of the last real check (via `npm run drift:check`), not a live one - see `stale` below.
 */
export function readTraceabilitySummary(
  reportJsonPath: string = TRACEABILITY_REPORT_JSON_PATH(),
  now: Date = new Date(),
): TraceabilitySummary {
  if (!fs.existsSync(reportJsonPath)) {
    return { available: false, generatedAt: null, stale: false, counts: null };
  }
  const raw = JSON.parse(fs.readFileSync(reportJsonPath, 'utf-8')) as {
    generatedAt: string;
    counts: Record<SyncState, number>;
  };
  const stale = now.getTime() - new Date(raw.generatedAt).getTime() > TRACEABILITY_STALE_THRESHOLD_MS;
  return { available: true, generatedAt: raw.generatedAt, stale, counts: raw.counts };
}

/**
 * Pure aggregation over each domain's own already-built report - no I/O here, matching every
 * other buildXReport() in this project. Callers (see stagePipelineReport in orchestrator/
 * pipeline.ts) do the actual reading/building of the four sub-reports first, same as they already
 * do for each report's own --stage <x>-report.
 */
export function buildPipelineReport(
  cost: CostReport,
  healing: HealingReport,
  flaky: FlakyReport,
  promptVersions: PromptVersionReport,
  traceability: TraceabilitySummary,
  now: Date = new Date(),
): PipelineReport {
  const attentionFlags: string[] = [];

  if (cost.runawayFlags.length > 0) {
    attentionFlags.push(
      `${cost.runawayFlags.length} runaway cost invocation(s) flagged - see ${tenantDataPath('cost', 'report.md')}.`,
    );
  }
  if (healing.overall.healingRate !== null && healing.overall.healingRate < 0.5) {
    attentionFlags.push(
      `Healing rate is below 50% (${(healing.overall.healingRate * 100).toFixed(1)}%).`,
    );
  }
  if (flaky.currentlyActive > 0) {
    attentionFlags.push(
      `${flaky.currentlyActive} test${flaky.currentlyActive === 1 ? '' : 's'} currently quarantined as flaky.`,
    );
  }
  if (!traceability.available) {
    attentionFlags.push('Traceability has never been checked - run `npm run drift:check`.');
  } else if (traceability.stale) {
    attentionFlags.push(
      `Traceability report is stale (last checked ${traceability.generatedAt}) - run \`npm run drift:check\`.`,
    );
  } else if (traceability.counts) {
    const outOfSync = NON_SYNCED_STATES.reduce((sum, state) => sum + (traceability.counts?.[state] ?? 0), 0);
    if (outOfSync > 0) {
      attentionFlags.push(`${outOfSync} traceability ${outOfSync === 1 ? 'entry is' : 'entries are'} out of sync.`);
    }
  }

  return {
    generatedAt: now.toISOString(),
    cost: { totalEvents: cost.totalEvents, overall: cost.overall, runawayFlags: cost.runawayFlags },
    healing: { ...healing.overall, totalEvents: healing.totalEvents },
    flaky: { currentlyActive: flaky.currentlyActive, totalQuarantinedAllTime: flaky.totalQuarantinedAllTime },
    traceability,
    promptVersions: {
      totalCommits: promptVersions.agents.reduce((sum, agent) => sum + agent.commits.length, 0),
      byAgent: promptVersions.agents.map((agent) => ({
        agentFile: agent.agentFile,
        commitCount: agent.commits.length,
      })),
    },
    attentionFlags,
  };
}

/**
 * The dashboard's "Full X report" links need to know where the *other* domains' report.html
 * pages will actually live once published - which, on GitHub Pages, is the same site root
 * PIPELINE_REPORT_PUBLIC_URL already points at (that env var is just "site root + /report.html").
 * Deriving it here means there's only one URL to configure (the existing repo variable/env var),
 * not a second one to keep in sync with it.
 */
export function deriveSiteRoot(publicReportUrl: string | undefined): string | undefined {
  return publicReportUrl?.replace(/\/report\.html$/, '');
}

const SUB_REPORT_DOMAINS: { dir: string; title: string }[] = [
  { dir: 'cost', title: 'Cost & Latency Report' },
  { dir: 'healing', title: 'Healing Telemetry Report' },
  { dir: 'flaky', title: 'Flaky Test Quarantine Report' },
  { dir: 'traceability', title: 'Traceability Report' },
  { dir: 'promptVersions', title: 'Prompt Versioning Report' },
];

/**
 * Generates a report.html sibling for each domain's already-written report.md (cost, healing,
 * flaky, traceability, promptVersions) via the shared markdown renderer, so pipeline-report.yml
 * can publish all of them to the same Pages site as pipelineReport/report.html itself - avoids
 * the dashboard's sub-links needing GitHub repo access (a login wall) when the dashboard itself
 * is meant to be link-accessible. Best-effort: silently skips any domain whose report.md doesn't
 * exist yet (e.g. cost:report/flaky:report have no scheduled CI job, only drift-check and
 * healing-report/prompt-versions-report do - see README) rather than failing the whole run over
 * a report nobody's generated locally yet.
 */
export function writeSubReportPages(): string[] {
  const written: string[] = [];
  for (const { dir, title } of SUB_REPORT_DOMAINS) {
    const mdPath = tenantDataPath(dir, 'report.md');
    if (!fs.existsSync(mdPath)) continue;
    const markdown = fs.readFileSync(mdPath, 'utf-8');
    const htmlPath = tenantDataPath(dir, 'report.html');
    fs.writeFileSync(htmlPath, wrapReportPage(title, renderMarkdownToHtml(markdown), '../report.html'), 'utf-8');
    written.push(htmlPath);
  }
  return written;
}

export function writePipelineReports(
  report: PipelineReport,
  publicReportUrl?: string,
): { reportJsonPath: string; reportHtmlPath: string } {
  fs.mkdirSync(path.dirname(REPORT_JSON_PATH()), { recursive: true });
  fs.writeFileSync(REPORT_JSON_PATH(), `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
  fs.writeFileSync(REPORT_HTML_PATH(), buildReportHtml(report, deriveSiteRoot(publicReportUrl)), 'utf-8');
  writeSubReportPages();
  return { reportJsonPath: REPORT_JSON_PATH(), reportHtmlPath: REPORT_HTML_PATH() };
}

function usd(n: number): string {
  return `$${n.toFixed(6)}`;
}

function pct(rate: number | null): string {
  return rate === null ? 'n/a' : `${(rate * 100).toFixed(1)}%`;
}

// This report is meant to be opened directly in a browser (GitHub renders .md inline but not
// .html, so unlike every other report in this project, this one trades that off deliberately for
// something that reads better as an at-a-glance dashboard) - so unlike other user-controlled
// strings in this codebase, agent file names and sync-state labels here are interpolated into
// real HTML and need escaping, even though today's inputs are all internally-controlled and not
// attacker-supplied.
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function card(title: string, rows: string[], footerHref: string, footerLabel: string): string {
  return `
    <section class="card">
      <h2>${escapeHtml(title)}</h2>
      <dl>${rows.join('')}</dl>
      <a class="detail-link" href="${escapeHtml(footerHref)}">${escapeHtml(footerLabel)} &rarr;</a>
    </section>`;
}

function row(label: string, value: string): string {
  return `<div class="row"><dt>${escapeHtml(label)}</dt><dd>${value}</dd></div>`;
}

// Exported for testing - not part of the public report-generation flow, callers should go
// through writePipelineReports().
export function buildReportHtml(report: PipelineReport, publicSiteRoot?: string): string {
  // Each card's "Full ... report" link used to be a relative path (e.g. '../cost/report.md'),
  // which only resolves when report.html is opened from a real repo checkout sitting next to
  // those sibling directories - on GitHub Pages there is no such checkout, just whatever gets
  // explicitly published. When publicSiteRoot is given (derived from PIPELINE_REPORT_PUBLIC_URL -
  // see deriveSiteRoot above), link to that domain's own self-hosted report.html instead (written
  // by writeSubReportPages, published alongside this dashboard by pipeline-report.yml's "Stage
  // Pages content" step) - works without requiring GitHub repo access, unlike linking into the
  // (private) repo itself would. Local runs (no publicSiteRoot) keep the relative .md path.
  const linkTo = (domain: string): string =>
    publicSiteRoot ? `${publicSiteRoot}/${domain}/report.html` : `../${domain}/report.md`;

  const attentionHtml =
    report.attentionFlags.length === 0
      ? `<div class="attention attention-clear"><span class="badge">All clear</span> Nothing flagged.</div>`
      : `<div class="attention attention-alert">
          <span class="badge">${report.attentionFlags.length} item${report.attentionFlags.length === 1 ? '' : 's'} need attention</span>
          <ul>${report.attentionFlags.map((f) => `<li>${escapeHtml(f)}</li>`).join('')}</ul>
        </div>`;

  const costCard = card(
    'Cost & Latency',
    [
      row('Total events', String(report.cost.totalEvents)),
      row('Total cost', usd(report.cost.overall.totalCostUsd)),
      row('Total wall-clock', `${(report.cost.overall.totalWallClockMs / 1000).toFixed(1)}s`),
      row('Runaway invocations', String(report.cost.runawayFlags.length)),
    ],
    linkTo('cost'),
    'Full cost report',
  );

  const healingCard = card(
    'Healing',
    [
      row('Total events', String(report.healing.totalEvents)),
      row('Healed / Escalated / No heal needed', `${report.healing.healed} / ${report.healing.escalated} / ${report.healing.passedNoHealNeeded}`),
      row('Healing rate', pct(report.healing.healingRate)),
    ],
    linkTo('healing'),
    'Full healing report',
  );

  const flakyCard = card(
    'Flaky Quarantine',
    [
      row('Currently active', String(report.flaky.currentlyActive)),
      row('Total quarantined all-time', String(report.flaky.totalQuarantinedAllTime)),
    ],
    linkTo('flaky'),
    'Full flaky report',
  );

  const traceabilityRows = !report.traceability.available
    ? [row('Status', 'Never checked - run <code>npm run drift:check</code>')]
    : [
        row(
          'Last checked',
          `${escapeHtml(report.traceability.generatedAt ?? '')}${report.traceability.stale ? ' <span class="tag tag-stale">STALE</span>' : ''}`,
        ),
        ...Object.entries(report.traceability.counts ?? {}).map(([state, count]) => row(state, String(count))),
      ];
  const traceabilityCard = card('Traceability', traceabilityRows, linkTo('traceability'), 'Full traceability report');

  const promptVersionsCard = card(
    'Prompt Versioning',
    [
      row('Total commits (all agents)', String(report.promptVersions.totalCommits)),
      ...report.promptVersions.byAgent.map((agent) => row(agent.agentFile, String(agent.commitCount))),
    ],
    linkTo('promptVersions'),
    'Full prompt version report',
  );

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pipeline Health Report</title>
<style>
${REPORT_PAGE_BASE_CSS}
</style>
</head>
<body>
<div class="wrap">
  <h1>Pipeline Health Report</h1>
  <p class="generated">Generated ${escapeHtml(report.generatedAt)}</p>
  ${attentionHtml}
  <div class="grid">
    ${costCard}
    ${healingCard}
    ${flakyCard}
    ${traceabilityCard}
    ${promptVersionsCard}
  </div>
</div>
</body>
</html>
`;
}
