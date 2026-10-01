import Anthropic from '@anthropic-ai/sdk';
import { requireTenantEnv } from '../config/env';
import { JiraIssueSummary } from '../types/schemas';
import { ProxyAgent, setGlobalDispatcher } from 'undici';

// Node's built-in fetch (which @anthropic-ai/sdk uses under the hood) does not honor
// HTTP_PROXY/HTTPS_PROXY env vars the way axios (JiraClient's transport) and curl do - a real gap
// for any deployment that egresses through a corporate HTTP CONNECT proxy, not just this spike's
// sandbox. Wiring it once, globally, guarded by the env var actually being set, so this is a
// no-op in the common case (no proxy in the path, e.g. a normal CI runner or laptop).
const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;
if (proxyUrl) {
  setGlobalDispatcher(new ProxyAgent(proxyUrl));
}

/**
 * Gate 0 headless-agent-cost spike (Production Roadmap section 1 / saas-productization-
 * milestone.md's "headless-agent-cost workstream"). This is the smallest surface of the six-agent
 * core pipeline's live reasoning steps - a single LLM call per requirementGate.ts's own doc
 * comment - deliberately prototyped first, before the harder cases (Generator's scenario writing,
 * Healer's healing), same "prove genericity before rebuilding" instinct as
 * enterprise-productization-plan.md's Phase 0.
 *
 * Real per-million-token USD pricing for the four models actually offered on this account's
 * Anthropic Console as of Aug 2026 (Fable 5 / Opus 5 / Sonnet 5 / Haiku 4.5 - confirmed against
 * this account's own Console model picker, not assumed from general web search, which also
 * surfaced pricing for differently-named "Sonnet 4.6"/"Opus 4.8" models this account does not
 * have and that should not be conflated with these). Pricing changes over time and this table has
 * no expiry check - re-verify at console.anthropic.com before trusting it beyond this spike.
 */
export const MODEL_PRICING: Record<string, { inputPerMTok: number; outputPerMTok: number }> = {
  'claude-haiku-4-5-20251001': { inputPerMTok: 1, outputPerMTok: 5 },
  'claude-sonnet-5': { inputPerMTok: 2, outputPerMTok: 10 },
  'claude-opus-5': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-fable-5': { inputPerMTok: 10, outputPerMTok: 50 },
};

// Cheapest model first for the spike's default - Gate 0's judgment ("is this ticket clear enough
// to generate scenarios from") is a bounded classification task, not open-ended reasoning, so
// Haiku 4.5 is the right first thing to measure accuracy against before assuming a pricier model
// is needed. --model on the CLI stage overrides this per-run for exactly that comparison.
export const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

export interface HeadlessJudgeResult {
  gaps: string[];
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  wallClockMs: number;
}

let client: Anthropic | null = null;

/**
 * Mirrors JiraClient's own lazy-singleton constructor pattern (jiraClient.ts's getJiraClient) and
 * its use of requireTenantEnv for credentials - same per-tenant override mechanism
 * (ANTHROPIC_API_KEY__<TENANT>) every other credential in this project already gets, for free,
 * with no tenant-specific code here. requireTenantEnv is async as of the secrets-manager fix
 * (credentials can now come from a real secrets provider, not just process.env), so this and its
 * one call site both need to be async too - same reason JiraClient.create() became a static async
 * factory instead of a plain constructor.
 */
async function getAnthropicClient(): Promise<Anthropic> {
  if (!client) {
    client = new Anthropic({ apiKey: await requireTenantEnv('ANTHROPIC_API_KEY', 'Gate 0 Headless Judge') });
  }
  return client;
}

const SYSTEM_PROMPT = [
  'You are Gate 0 of a test-automation pipeline. Given a Jira ticket\'s summary and description, ' +
    'decide whether it is clear enough that a test engineer could write concrete test scenarios ' +
    'from it without having to guess at intent - the same judgment requirementGate.ts already ' +
    'assumes a human or a live Planning Agent session made before Gate 0 clears.',
  '',
  'Respond with ONLY a JSON array of strings, nothing else - no prose, no markdown fences, no ' +
    'explanation outside the array. Each string is one concrete, specific missing detail that ' +
    'blocks writing scenarios (e.g. "No acceptance criteria for what happens on invalid input", ' +
    'not vague statements like "needs more detail"). If the ticket is clear enough to proceed as-' +
    'is, respond with exactly: []',
  '',
  'Be conservative - only flag a gap if it would genuinely force a test engineer to guess. Do not ' +
    'flag stylistic issues, missing story points, or anything that does not block writing test ' +
    'scenarios.',
].join('\n');

function parseGapsResponse(raw: string): string[] {
  const trimmed = raw.trim();
  const jsonMatch = trimmed.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    throw new Error(
      `Gate 0 headless judge returned non-JSON-array content, could not extract gaps: ${trimmed.slice(0, 200)}`,
    );
  }
  const parsed: unknown = JSON.parse(jsonMatch[0]);
  if (!Array.isArray(parsed) || !parsed.every((g) => typeof g === 'string')) {
    throw new Error(
      `Gate 0 headless judge returned malformed JSON (expected string[]): ${jsonMatch[0].slice(0, 200)}`,
    );
  }
  return parsed;
}

/**
 * The one real API call this spike exists to measure. Returns the same string[] shape
 * stageFlagRequirementGaps() already expects from a hand-written --gaps-file, plus real token
 * usage/cost/latency read directly off the API response (never estimated) - see MODEL_PRICING's
 * doc comment for the pricing source.
 */
export async function judgeRequirementClarity(
  ticket: JiraIssueSummary,
  model: string = DEFAULT_MODEL,
): Promise<HeadlessJudgeResult> {
  const pricing = MODEL_PRICING[model];
  if (!pricing) {
    throw new Error(`No pricing entry for model "${model}" - add one to MODEL_PRICING before using it for cost tracking.`);
  }

  const anthropic = await getAnthropicClient();
  const start = Date.now();
  const response = await anthropic.messages.create({
    model,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Ticket ${ticket.key}: ${ticket.summary}\n\n${ticket.description || '(no description)'}`,
      },
    ],
  });
  const wallClockMs = Date.now() - start;

  const textBlock = response.content.find((block) => block.type === 'text');
  const raw = textBlock && textBlock.type === 'text' ? textBlock.text : '[]';
  const gaps = parseGapsResponse(raw);

  const inputTokens = response.usage.input_tokens;
  const outputTokens = response.usage.output_tokens;
  const costUsd =
    (inputTokens / 1_000_000) * pricing.inputPerMTok + (outputTokens / 1_000_000) * pricing.outputPerMTok;

  return { gaps, model, inputTokens, outputTokens, costUsd, wallClockMs };
}
