import fs from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { requireTenantEnv } from '../config/env';
import { tenantDataPath } from '../config/tenantContext';
import { MODEL_PRICING, DEFAULT_MODEL } from '../requirementGate/headlessJudge';

/**
 * --stage ask (Continuity Log, Aug 22 "Standing future direction" resolution). The real trigger
 * behind this wasn't an internal-architecture complaint - it's that this pipeline's existing
 * report stages (dev-status, sprint-status, standup-digest, ...) already do real work and already
 * write real structured JSON, but a cron job plus a CLI --stage flag plus a raw JSON/Markdown file
 * doesn't read as "AI" in a live demo, even though generator-agent and healer-agent elsewhere in
 * this system already do genuine multi-step LLM reasoning. The fix isn't a new architecture - it's
 * a conversational layer on top of what already exists: ask a plain-language question, map it to
 * the report(s) it's actually about, and have an LLM narrate the real data instead of the person
 * reading raw JSON/Markdown themselves.
 *
 * Deliberately NOT a tool-calling agent loop (contrast the Healer spike's Claude Agent SDK
 * approach) - two plain one-shot Messages API calls, same "smallest surface first" shape as Gate
 * 0's headlessJudge.ts, which this module reuses MODEL_PRICING/DEFAULT_MODEL from directly rather
 * than duplicating the pricing table.
 *
 * Deliberately READS EXISTING REPORT FILES FROM DISK, never re-fetches or re-runs a stage itself:
 * - No side effects. blocker-scan's stage function posts real Jira comments and sends real Slack/
 *   email escalations as part of building its report - triggering that as a side effect of someone
 *   asking a question would be a real, surprising harm. Reading blockerScan's already-written
 *   report.json has none of that risk.
 * - No extra API load / rate-limit risk piled on top of whatever's already configured to run these
 *   stages on a schedule.
 * - Matches how these reports are already consumed today (scrumDashboard.ts's read-only views over
 *   the same JSON files) - "ask" is a new way to consume already-produced data, not a new producer.
 * The tradeoff is staleness: an answer is only as fresh as the last time someone ran that stage.
 * Acceptable for this use case (a demo/conversational layer, not a new source of truth) - if this
 * needs to force a fresh run first, that's a deliberate follow-up, not assumed here.
 */

export interface ReportRegistryEntry {
  /** Short, stable key an LLM classification call picks from - never surfaced to the end user. */
  key: string;
  /** What this report covers, in plain language - this is the only context the classifier gets to
   * decide relevance, so it needs to actually distinguish this report from its neighbors. */
  description: string;
  /** Real path to the report JSON already written by the corresponding --stage run (tenantDataPath
   * scoped, so this is automatically per-tenant correct with no extra wiring here). */
  jsonPath: () => string;
}

export const REPORT_REGISTRY: ReportRegistryEntry[] = [
  {
    key: 'dev-status',
    description:
      'Open pull requests and branches without an open PR, for this tenant\'s GitHub repo. Answers ' +
      'questions about PR review state, stale branches, or unlinked development activity.',
    jsonPath: () => tenantDataPath('devStatus', 'report.json'),
  },
  {
    key: 'sprint-status',
    description:
      'Current-sprint snapshot: issues grouped by status and assignee, with story points, for ' +
      'every board this tenant tracks. Answers questions about sprint progress, who has what ' +
      'assigned, how many points are done/remaining right now, or roughly how far along the ' +
      'sprint is.',
    jsonPath: () => tenantDataPath('sprintStatus', 'report.json'),
  },
  {
    key: 'standup-digest',
    description:
      'Latest built standup digest: active-sprint issues grouped by assignee, the same content DM' +
      "'d to each assignee. Answers \"what is <person> working on\" or \"what's today's standup " +
      'look like" questions.',
    jsonPath: () => tenantDataPath('standupDigest', 'report.json'),
  },
  {
    key: 'blocker-scan',
    description:
      'Issues flagged as idle past this tenant\'s configured threshold, and what escalation ' +
      'happened for each (Jira comment, Slack, email). Answers "what\'s blocked" or "what\'s been ' +
      'idle too long" questions. Read-only here - this never re-runs the scan or sends new ' +
      'escalations, only reads what the last real scan already found and did.',
    jsonPath: () => tenantDataPath('blockerScan', 'report.json'),
  },
  {
    key: 'groom-check',
    description:
      'Backlog items missing required grooming fields (estimate, acceptance criteria, etc.) per ' +
      'this tenant\'s config. Answers "what\'s not ready to pull into a sprint" questions.',
    jsonPath: () => tenantDataPath('groomCheck', 'report.json'),
  },
  {
    key: 'retro-notes',
    description:
      'Retro talking points fetched/posted for the most recent sprint. Answers "what came up in ' +
      'the last retro" questions.',
    jsonPath: () => tenantDataPath('retroNotes', 'report.json'),
  },
  {
    key: 'coverage',
    description:
      'User-story/test coverage and development coverage per sprint - which stories have zero real ' +
      'test coverage. Answers "what\'s not tested" or "how much of this sprint has real coverage" ' +
      'questions - this is the product\'s own governance-layer positioning claim, not a generic ' +
      'metric.',
    jsonPath: () => tenantDataPath('coverageReport', 'report.json'),
  },
  {
    key: 'healing',
    description:
      'Self-healing outcomes over time - healed/escalated/passed-no-heal-needed rates, by suite and ' +
      'week. Answers "how well is self-healing working" or "what got auto-fixed recently" ' +
      'questions.',
    jsonPath: () => tenantDataPath('healing', 'report.json'),
  },
  {
    key: 'flaky',
    description:
      'Flaky-test quarantine state - which tests are currently quarantined and why. Answers ' +
      '"what tests are flaky right now" questions.',
    jsonPath: () => tenantDataPath('flaky', 'report.json'),
  },
  {
    key: 'cost',
    description:
      'LLM API cost/latency across every real agent dispatch this pipeline has made. Answers ' +
      '"how much is this costing us" or "what\'s the most expensive stage" questions.',
    jsonPath: () => tenantDataPath('cost', 'report.json'),
  },
];

export interface AskLlmCallResult {
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  wallClockMs: number;
}

export interface AskResult {
  question: string;
  reportsUsed: string[];
  reportsRequestedButMissing: string[];
  answer: string;
  classify: AskLlmCallResult;
  narrate: AskLlmCallResult;
}

let client: Anthropic | null = null;

async function getAnthropicClient(): Promise<Anthropic> {
  if (!client) {
    client = new Anthropic({ apiKey: await requireTenantEnv('ANTHROPIC_API_KEY', '--stage ask') });
  }
  return client;
}

function costOf(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = MODEL_PRICING[model];
  if (!pricing) {
    throw new Error(`No pricing entry for model "${model}" - add one to headlessJudge.ts's MODEL_PRICING before using it here.`);
  }
  return (inputTokens / 1_000_000) * pricing.inputPerMTok + (outputTokens / 1_000_000) * pricing.outputPerMTok;
}

/**
 * Call 1 of 2: which registered report(s) is this question actually about. A bounded
 * classification task over a short, fixed menu - same shape as Gate 0's clarity judgment, so
 * Haiku-tier is the right default to measure against before assuming a pricier model is needed.
 * Returns report keys only (validated against REPORT_REGISTRY) - never invents a topic outside the
 * registry, so there's no way for this call to point at a report file that doesn't exist.
 */
async function classifyQuestion(question: string, model: string): Promise<{ keys: string[] } & AskLlmCallResult> {
  const menu = REPORT_REGISTRY.map((r) => `- "${r.key}": ${r.description}`).join('\n');
  const systemPrompt = [
    'You route a plain-language question to the report(s) that can answer it, for a test-' +
      'automation/scrum pipeline. Here is the full menu of available reports - this is the ONLY ' +
      'set of valid keys, never invent one outside this list:',
    '',
    menu,
    '',
    'Respond with ONLY a JSON array of key strings from the menu above, nothing else - no prose, no ' +
      'markdown fences. Pick every report genuinely relevant to answering the question, not just ' +
      'the single closest match - a question like "what\'s blocking us and how\'s the sprint going" ' +
      'needs both "blocker-scan" and "sprint-status". If nothing in the menu is relevant, respond ' +
      'with exactly: []',
  ].join('\n');

  const anthropic = await getAnthropicClient();
  const start = Date.now();
  const response = await anthropic.messages.create({
    model,
    max_tokens: 256,
    system: systemPrompt,
    messages: [{ role: 'user', content: question }],
  });
  const wallClockMs = Date.now() - start;

  const textBlock = response.content.find((b) => b.type === 'text');
  const raw = textBlock && textBlock.type === 'text' ? textBlock.text : '[]';
  const jsonMatch = raw.trim().match(/\[[\s\S]*\]/);
  const parsed: unknown = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
  const validKeys = new Set(REPORT_REGISTRY.map((r) => r.key));
  const keys = Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string' && validKeys.has(k)) : [];

  const inputTokens = response.usage.input_tokens;
  const outputTokens = response.usage.output_tokens;
  return { keys, model, inputTokens, outputTokens, costUsd: costOf(model, inputTokens, outputTokens), wallClockMs };
}

// Matches an ISO 8601 date or date-time string (e.g. "2026-08-21" or
// "2026-08-21T10:11:32.981Z") anywhere it appears as a JSON string value - deliberately generic
// across every report shape, not hand-picked per report (sprintStatus's sprint.startDate/endDate,
// devStatus's PR timestamps, healing's telemetry timestamps, ...) - new report types get this for
// free with no registry-specific date-field wiring.
const ISO_DATE_PATTERN = /"(\d{4}-\d{2}-\d{2})(T[\d:.]+Z)?"/g;

/**
 * Real bug found via a live run: asked twice with the fix from the previous commit in place, and
 * the model still said "started yesterday" for a sprint that actually started 3 days ago, even
 * though it *did* correctly compute "11 days left" in the same answer using the same real-current-
 * date value. Telling an LLM to do date arithmetic correctly is not reliable enough on its own,
 * even with the real reference date supplied - it computed one delta right and the other wrong in
 * the same response. The robust fix is to never ask it to do the arithmetic at all: this function
 * finds every ISO date/date-time string in the real report JSON and appends a real, code-computed
 * relative-time annotation directly next to it (e.g. "2026-08-21" (3 days ago)), so the narration
 * call only ever has to read a ready-made answer, never compute one.
 */
export function annotateDatesWithRelativeTime(jsonText: string, now: Date = new Date()): string {
  return jsonText.replace(ISO_DATE_PATTERN, (match, dateOnly: string, timePart?: string) => {
    const then = new Date(timePart ? `${dateOnly}${timePart}` : `${dateOnly}T00:00:00Z`);
    if (Number.isNaN(then.getTime())) return match; // not actually a real date - leave untouched
    const diffDays = Math.round((then.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
    const relative =
      diffDays === 0
        ? 'today'
        : diffDays === 1
          ? 'tomorrow'
          : diffDays === -1
            ? 'yesterday'
            : diffDays > 0
              ? `in ${diffDays} days`
              : `${Math.abs(diffDays)} days ago`;
    return `${match} (${relative})`;
  });
}

interface AssigneeIssueLike {
  assignee: unknown;
  statusCategory: unknown;
  storyPoints: unknown;
}

function looksLikeAssigneeIssue(value: unknown): value is AssigneeIssueLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    'assignee' in value &&
    'statusCategory' in value &&
    'storyPoints' in value
  );
}

/**
 * Finds every array of assignee-issue-shaped objects anywhere in a report's data (structural
 * detection - "has assignee/statusCategory/storyPoints fields", not a hardcoded report key - so
 * this works for sprintStatus's and standupDigest's issues[] alike, and any future report with the
 * same shape, with no per-report wiring) and returns a precomputed, human-readable not-done-only
 * workload summary per assignee.
 *
 * Real bug found via a live run: even with the "count only not-done items" instruction from an
 * earlier fix in place and the right number (12 points) coming out, the model narrated it as "12
 * points total including the completed work" - which is false (Mallikarjuna's completed items have
 * null story points, so nothing from completed work is actually included). The number was right,
 * the model's own explanation of where the number came from wasn't. Same lesson as the date-
 * arithmetic bug: don't ask the LLM to compute-and-then-describe an aggregate itself - compute it
 * in code and hand over both the number and its correct description together.
 */
export function computeAssigneeWorkloadSummaries(data: unknown): string[] {
  const issueArrays: AssigneeIssueLike[][] = [];
  const seen = new Set<unknown>();
  function walk(value: unknown): void {
    if (value === null || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      if (value.length > 0 && value.every(looksLikeAssigneeIssue)) {
        issueArrays.push(value as AssigneeIssueLike[]);
        return; // don't also walk into each issue object below - already captured as a whole
      }
      for (const item of value) walk(item);
    } else {
      for (const v of Object.values(value)) walk(v);
    }
  }
  walk(data);

  const summaries: string[] = [];
  for (const issues of issueArrays) {
    const byAssignee = new Map<string, { notDoneCount: number; notDonePoints: number }>();
    for (const issue of issues) {
      const name = typeof issue.assignee === 'string' && issue.assignee ? issue.assignee : '(unassigned)';
      const entry = byAssignee.get(name) ?? { notDoneCount: 0, notDonePoints: 0 };
      if (issue.statusCategory !== 'done') {
        entry.notDoneCount += 1;
        entry.notDonePoints += typeof issue.storyPoints === 'number' ? issue.storyPoints : 0;
      }
      byAssignee.set(name, entry);
    }
    const lines = Array.from(byAssignee.entries())
      .filter(([, v]) => v.notDoneCount > 0)
      .map(([name, v]) => `${name}: ${v.notDoneCount} not-done item(s), ${v.notDonePoints} not-done story point(s)`);
    if (lines.length > 0) summaries.push(lines.join('; '));
  }
  return summaries;
}

/**
 * Call 2 of 2: narrate the real report data conversationally. Gets the actual JSON content of
 * every report classifyQuestion() selected - real numbers, not a paraphrase of them - and is
 * explicitly told not to invent anything the data doesn't support.
 */
async function narrateAnswer(
  question: string,
  reportsData: { key: string; data: unknown }[],
  model: string,
): Promise<{ answer: string } & AskLlmCallResult> {
  const systemPrompt = [
    'You answer a plain-language question about a software team\'s sprint/test-automation state, ' +
      'using ONLY the real report data provided below - never invent a number, name, or status the ' +
      'data does not actually contain, and never make a claim about a topic the data does not cover ' +
      'at all (e.g. do not say "no blockers" or "on track" unless the data actually includes ' +
      'blocker/risk information - silence on a topic in the data is not evidence of anything about ' +
      'that topic). If the data provided does not fully answer the question, say so plainly rather ' +
      'than guessing. Write a short, direct, conversational answer (a person asking this question in ' +
      'a demo or standup, not a report) - a sentence or two for a simple question, a short paragraph ' +
      'at most for a complex one. No markdown headers or bullet lists unless the question genuinely ' +
      'needs a list to answer clearly.',
    '',
    'When a "Precomputed not-done workload" block is present below, use those numbers and that ' +
      'wording directly for any question about what someone has left to do, their current workload, ' +
      'or what\'s "on their plate" - do not recount or re-sum the raw issue list yourself, and do not ' +
      'describe a not-done total as "including completed work" - it deliberately excludes it, that\'s ' +
      'the whole point of the precomputed block. If no such block is present for a report, that ' +
      'report has no assignee/points data shaped for this - say so rather than guessing from raw ' +
      'fields.',
    '',
    'Every date string in the report data below has already been annotated with its real, ' +
      'precomputed distance from today, e.g. "2026-08-21" (3 days ago) - use that annotation ' +
      'directly for any date-relative language ("started X days ago", "N days left", etc.). Do not ' +
      'do your own date arithmetic or guess a relative time from a report\'s generatedAt/timestamp ' +
      'field - the annotation is already correct, computed in real code, not estimated.',
  ].join('\n');

  const userContent = [
    `Today's real date: ${new Date().toISOString().slice(0, 10)}`,
    `Question: ${question}`,
    '',
    'Real report data (every date string is annotated with its real distance from today):',
    ...reportsData.map((r) => {
      const summaries = computeAssigneeWorkloadSummaries(r.data);
      const summaryBlock =
        summaries.length > 0
          ? `\nPrecomputed not-done workload (excludes completed items entirely - use as-is):\n${summaries.join('\n')}`
          : '';
      return `\n--- ${r.key} ---\n${annotateDatesWithRelativeTime(JSON.stringify(r.data))}${summaryBlock}`;
    }),
  ].join('\n');

  const anthropic = await getAnthropicClient();
  const start = Date.now();
  const response = await anthropic.messages.create({
    model,
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: 'user', content: userContent }],
  });
  const wallClockMs = Date.now() - start;

  const textBlock = response.content.find((b) => b.type === 'text');
  const answer = textBlock && textBlock.type === 'text' ? textBlock.text.trim() : '(no answer text returned)';

  const inputTokens = response.usage.input_tokens;
  const outputTokens = response.usage.output_tokens;
  return { answer, model, inputTokens, outputTokens, costUsd: costOf(model, inputTokens, outputTokens), wallClockMs };
}

export async function answerQuestion(question: string, model: string = DEFAULT_MODEL): Promise<AskResult> {
  const classify = await classifyQuestion(question, model);

  if (classify.keys.length === 0) {
    return {
      question,
      reportsUsed: [],
      reportsRequestedButMissing: [],
      answer:
        "That doesn't map to anything this pipeline currently tracks (dev status, sprint status, " +
        'burndown, standup digest, blocker scan, backlog grooming, retro notes, test coverage, ' +
        'self-healing, flaky tests, or LLM cost). Try asking about one of those.',
      classify,
      narrate: { model, inputTokens: 0, outputTokens: 0, costUsd: 0, wallClockMs: 0 },
    };
  }

  const reportsData: { key: string; data: unknown }[] = [];
  const reportsRequestedButMissing: string[] = [];
  for (const key of classify.keys) {
    const entry = REPORT_REGISTRY.find((r) => r.key === key);
    if (!entry) continue; // unreachable - classifyQuestion already filters against the registry
    const jsonPath = entry.jsonPath();
    if (!fs.existsSync(jsonPath)) {
      reportsRequestedButMissing.push(key);
      continue;
    }
    reportsData.push({ key, data: JSON.parse(fs.readFileSync(jsonPath, 'utf-8')) });
  }

  if (reportsData.length === 0) {
    return {
      question,
      reportsUsed: [],
      reportsRequestedButMissing,
      answer:
        `This looks like a "${classify.keys.join('", "')}" question, but that report hasn't been ` +
        `run yet for this tenant - no ${reportsRequestedButMissing.join('/')} report.json exists. ` +
        `Run the underlying stage first (e.g. npm run pipeline -- --stage ${classify.keys[0]}), ` +
        'then ask again.',
      classify,
      narrate: { model, inputTokens: 0, outputTokens: 0, costUsd: 0, wallClockMs: 0 },
    };
  }

  const narrate = await narrateAnswer(question, reportsData, model);

  return {
    question,
    reportsUsed: reportsData.map((r) => r.key),
    reportsRequestedButMissing,
    answer: narrate.answer,
    classify,
    narrate,
  };
}
