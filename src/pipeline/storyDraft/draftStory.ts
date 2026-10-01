import Anthropic from '@anthropic-ai/sdk';
import { requireTenantEnv } from '../config/env';
import { JiraIssueSummary } from '../types/schemas';
import { MODEL_PRICING, DEFAULT_MODEL } from '../requirementGate/headlessJudge';

/**
 * Phase C ("AI-Assisted Scrum and SDLC Console - Development Plan," docs/planning/) - the
 * "genuinely new AI judgment work" that plan's Section 5 describes: draft a user story + real
 * acceptance criteria from a Jira Epic, real-verified but no prior art in this codebase for a
 * *drafting* call the way headlessJudge.ts's Gate 0 spike is a *judging* call. Same shape as that
 * spike anyway, deliberately - one real Anthropic Messages API call, real token usage/cost/latency
 * read off the response (never estimated), reusing its MODEL_PRICING/DEFAULT_MODEL rather than a
 * second pricing table. --stage draft-story (pipeline.ts) is this module's only caller: it reads
 * the epic via the existing JiraClient (an Epic is just another Jira issue - getIssue()/
 * extractDescription() already work for one, no new read adapter needed despite the dev plan's own
 * estimate that one would be), calls draftStoryFromEpic() below, then hands the result to
 * queueClient.ts's createQueueItem() so a Product Owner reviews it via the AI Queue before
 * anything is registered as a real Jira ticket - this module never writes to Jira itself.
 */

export interface StoryDraft {
  title: string;
  description: string;
  acceptanceCriteria: string[];
}

export interface DraftStoryResult extends StoryDraft {
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  wallClockMs: number;
}

let client: Anthropic | null = null;

/** Same lazy-singleton-via-requireTenantEnv pattern as headlessJudge.ts/askEngine.ts. */
async function getAnthropicClient(): Promise<Anthropic> {
  if (!client) {
    client = new Anthropic({ apiKey: await requireTenantEnv('ANTHROPIC_API_KEY', '--stage draft-story') });
  }
  return client;
}

const SYSTEM_PROMPT = [
  'You draft a single, well-scoped user story from a Jira Epic\'s summary and description, for a ' +
    'Product Owner to review before it is registered as a real ticket. The story must be genuinely ' +
    'actionable by an engineering team - concrete enough that a test engineer could later write ' +
    'test scenarios from it without having to guess at intent (the same bar Gate 0 of this ' +
    'pipeline already holds real requirements to).',
  '',
  'Respond with ONLY a JSON object, nothing else - no prose, no markdown fences, no explanation ' +
    'outside the object. Shape exactly: ' +
    '{"title": "...", "description": "...", "acceptanceCriteria": ["...", "..."]}',
  '',
  '- title: a short, specific story title (not the epic\'s own title restated).',
  '- description: 1-3 sentences, standard "As a <role>, I want <capability>, so that <benefit>" ' +
    'form when the epic supports identifying a role and benefit; otherwise a plain, concrete ' +
    'statement of what the story delivers.',
  '- acceptanceCriteria: 2-6 concrete, testable criteria - each one a specific, checkable ' +
    'condition (e.g. "Invalid input shows an inline error, not a blank screen"), never vague ' +
    'statements like "works correctly" or "handles edge cases."',
  '',
  'If the epic is too vague to draft a genuinely concrete story from, still produce your best ' +
    'attempt but keep acceptanceCriteria focused on what IS clear from the epic - never invent ' +
    'product decisions the epic does not support.',
].join('\n');

/** Extracted so it can be unit-tested directly against hand-written model output, the same
 * "malformed LLM response is a real, worth-testing failure mode" reasoning as
 * headlessJudge.ts's parseGapsResponse - just not exported there. Exported here since draftStory
 * produces a richer shape (object, not string[]) with more ways to be malformed. */
export function parseStoryDraftResponse(raw: string): StoryDraft {
  const trimmed = raw.trim();
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`draft-story returned non-JSON-object content, could not extract a story draft: ${trimmed.slice(0, 200)}`);
  }
  const parsed: unknown = JSON.parse(jsonMatch[0]);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as StoryDraft).title !== 'string' ||
    typeof (parsed as StoryDraft).description !== 'string' ||
    !Array.isArray((parsed as StoryDraft).acceptanceCriteria) ||
    !(parsed as StoryDraft).acceptanceCriteria.every((c) => typeof c === 'string')
  ) {
    throw new Error(
      `draft-story returned malformed JSON (expected {title, description, acceptanceCriteria: string[]}): ${jsonMatch[0].slice(0, 300)}`,
    );
  }
  const { title, description, acceptanceCriteria } = parsed as StoryDraft;
  return { title, description, acceptanceCriteria };
}

/** The one real API call this module exists to make. */
export async function draftStoryFromEpic(
  epic: JiraIssueSummary,
  model: string = DEFAULT_MODEL,
): Promise<DraftStoryResult> {
  const pricing = MODEL_PRICING[model];
  if (!pricing) {
    throw new Error(`No pricing entry for model "${model}" - add one to headlessJudge.ts's MODEL_PRICING before using it for cost tracking.`);
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
        content: `Epic ${epic.key}: ${epic.summary}\n\n${epic.description || '(no description)'}`,
      },
    ],
  });
  const wallClockMs = Date.now() - start;

  const textBlock = response.content.find((block) => block.type === 'text');
  const raw = textBlock && textBlock.type === 'text' ? textBlock.text : '{}';
  const draft = parseStoryDraftResponse(raw);

  const inputTokens = response.usage.input_tokens;
  const outputTokens = response.usage.output_tokens;
  const costUsd =
    (inputTokens / 1_000_000) * pricing.inputPerMTok + (outputTokens / 1_000_000) * pricing.outputPerMTok;

  return { ...draft, model, inputTokens, outputTokens, costUsd, wallClockMs };
}
