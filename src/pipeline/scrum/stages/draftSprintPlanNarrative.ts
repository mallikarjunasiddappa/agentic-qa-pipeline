import Anthropic from '@anthropic-ai/sdk';
import { requireTenantEnv } from '../../config/env';
import { MODEL_PRICING, DEFAULT_MODEL } from '../../requirementGate/headlessJudge';
import { SprintIssueSnapshot } from '../agileClient';

/**
 * --stage draft-sprint-plan's only Anthropic call - and its ONLY job is to narrate numbers that
 * are already fully computed (velocityReport.ts's averageVelocity, sprintPlanCandidates.ts's
 * selected/deferred split). It never computes, re-sums, or re-derives any figure itself - see
 * sprintPlanCandidates.ts's header comment for why that split is deliberate, not incidental. Same
 * lazy-singleton-via-requireTenantEnv / MODEL_PRICING/DEFAULT_MODEL-reuse / real-token-cost-off-
 * the-response shape as draftStory.ts and headlessJudge.ts before it.
 */

export interface SprintPlanNarrativeInput {
  boardId: string;
  futureSprintName: string;
  averageVelocity: number;
  closedSprintsUsed: number;
  pointBudget: number;
  selected: SprintIssueSnapshot[];
  deferred: SprintIssueSnapshot[];
  selectedStoryPoints: number;
  unestimatedCandidateCount: number;
}

export interface SprintPlanNarrativeResult {
  narrative: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  wallClockMs: number;
}

let client: Anthropic | null = null;

async function getAnthropicClient(): Promise<Anthropic> {
  if (!client) {
    client = new Anthropic({ apiKey: await requireTenantEnv('ANTHROPIC_API_KEY', '--stage draft-sprint-plan') });
  }
  return client;
}

const SYSTEM_PROMPT = [
  'You write a short, plain-English rationale for a proposed sprint plan, for a Scrum team to ' +
    'review in an AI Queue item before confirming it. You are given ALREADY-COMPUTED numbers - ' +
    'the team\'s average velocity, the point budget, which issues were selected vs deferred, and ' +
    'their points. Do NOT recompute, re-sum, re-derive, or restate any of these numbers ' +
    'differently than given - use them exactly as provided; treat every number in the prompt as ' +
    'ground truth, not something to check or re-add. Your job is only to explain the plan in 3-6 ' +
    'sentences: why this point budget, what is in vs deferred, and call out unestimated issues if ' +
    'any exist (they were excluded from the point-budgeted selection because their cost is ' +
    'unknown, not because they were judged low-priority). Do not invent reasons beyond what the ' +
    'given data supports, and do not claim this reflects team capacity - this is velocity ' +
    '(recent completed-points history) only, capacity/availability was not factored in. Respond ' +
    'with plain prose only - no JSON, no markdown headers, no bullet lists.',
].join('\n');

function buildUserPrompt(input: SprintPlanNarrativeInput): string {
  const selectedLines =
    input.selected.map((i) => `- ${i.key} (${i.storyPoints} pts): ${i.summary}`).join('\n') || '(none)';
  const deferredLines =
    input.deferred.map((i) => `- ${i.key} (${i.storyPoints ?? 'unestimated'} pts): ${i.summary}`).join('\n') ||
    '(none)';

  return [
    `Board: ${input.boardId}, future sprint "${input.futureSprintName}"`,
    `Average velocity: ${input.averageVelocity} story points, computed from the last ${input.closedSprintsUsed} closed sprint(s)`,
    `Point budget for this plan: ${input.pointBudget}`,
    `Selected (fits within the budget), totaling ${input.selectedStoryPoints} points:`,
    selectedLines,
    '',
    `Deferred (over budget, or unestimated), ${input.unestimatedCandidateCount} of these unestimated:`,
    deferredLines,
  ].join('\n');
}

export async function draftSprintPlanNarrative(
  input: SprintPlanNarrativeInput,
  model: string = DEFAULT_MODEL,
): Promise<SprintPlanNarrativeResult> {
  const pricing = MODEL_PRICING[model];
  if (!pricing) {
    throw new Error(
      `No pricing entry for model "${model}" - add one to headlessJudge.ts's MODEL_PRICING before using it for cost tracking.`,
    );
  }

  const anthropic = await getAnthropicClient();
  const start = Date.now();
  const response = await anthropic.messages.create({
    model,
    max_tokens: 512,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildUserPrompt(input) }],
  });
  const wallClockMs = Date.now() - start;

  const textBlock = response.content.find((block) => block.type === 'text');
  const narrative = textBlock && textBlock.type === 'text' ? textBlock.text.trim() : '';

  const inputTokens = response.usage.input_tokens;
  const outputTokens = response.usage.output_tokens;
  const costUsd =
    (inputTokens / 1_000_000) * pricing.inputPerMTok + (outputTokens / 1_000_000) * pricing.outputPerMTok;

  return { narrative, model, inputTokens, outputTokens, costUsd, wallClockMs };
}
