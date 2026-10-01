/**
 * Headless Healer spike (Production Roadmap section 2 / docs/planning/Generator-Healer Headless
 * Conversion - Scoping Notes.md). NOT wired into pipeline.ts - this is a standalone, throwaway
 * script for the spike only, same "prototype before committing" spirit as Gate 0's early scripts.
 *
 * Runs healer-agent.md's own real instructions (unmodified, read straight from the file) via the
 * Claude Agent SDK's headless mode (permissionMode: 'dontAsk', explicit allowedTools) instead of
 * an interactive Claude Code session - the actual open question this spike exists to answer is
 * whether the playwright-cli attach/snapshot/click loop those instructions depend on still works
 * when driven by an unattended agent's own Bash tool calls, with no human watching.
 *
 * One addition NOT in the original interactive instructions: an explicit headless override for
 * the "stop and ask the user" case (healer-agent.md step 5, test-generation.md 3.4). There's
 * nobody to ask in this mode, so per the scoping doc's Section 3.2 recommendation, that case is
 * redirected to writing a structured JSON record to HEADLESS_ESCALATIONS_FILE and moving on,
 * rather than blocking - the same governance/approval-gate shape this project already uses for
 * Gate 0's requirement gaps, not a new pattern invented for this script.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=... npx tsx scripts/spike-headless-healer.ts --test-file tests/path/to.spec.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';

const REPO_ROOT = path.resolve(__dirname, '..');
const ESCALATIONS_FILE = path.join(REPO_ROOT, 'headless-healer-escalations.jsonl');

function parseArgs(): { testFile?: string; model?: string } {
  const args: Record<string, string> = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      args[argv[i].slice(2)] = argv[i + 1];
      i += 1;
    }
  }
  // --model is optional and intentionally not defaulted here - omitting it reproduces the
  // original run's behavior exactly (SDK's own default model), so the same script can be used
  // for a same-input/same-scope model comparison (e.g. --model claude-haiku-4-5-20251001) without
  // touching anything else about how the spike runs.
  return { testFile: args['test-file'], model: args['model'] };
}

function loadHealerAgentPrompt(): string {
  const raw = fs.readFileSync(path.join(REPO_ROOT, '.claude/agents/healer-agent.md'), 'utf-8');
  // Strip the YAML frontmatter (--- ... ---) - only the prose body is the actual system prompt;
  // name/description/tools up there are Claude Code's own subagent-file metadata, not part of
  // what the agent should be told about itself.
  const withoutFrontmatter = raw.replace(/^---[\s\S]*?---\n/, '').trim();
  return withoutFrontmatter;
}

const HEADLESS_OVERRIDE = `

--- HEADLESS EXECUTION OVERRIDE (added for this spike only, not part of the original agent) ---
You are running unattended - there is no human available to answer questions or point at
something on screen. Wherever your instructions above say to "stop and ask the user" (or to use
\`playwright-cli show --annotate\` to have a human point at something), do this instead:
1. Do NOT attempt any further fix on this specific test.
2. Append one line of JSON to ${ESCALATIONS_FILE} with this shape:
   {"testFile": "<path>", "reason": "<why you stopped>", "specLines": "<the mismatched spec lines, if applicable>", "observedBehavior": "<what you actually saw>"}
   Use Bash (e.g. \`echo '...' >> ${ESCALATIONS_FILE}\`) to append it - create the file if it
   doesn't exist yet.
3. Report this test as escalated in your final summary and continue with any other tests in your
   batch, if there are more. Do not treat this as a failure of your own diagnosis - it means the
   ambiguity is real and belongs to a human, same as the interactive version's behavior, just
   recorded instead of asked in real time.

When you finish (whether you healed the test, escalated it, or exhausted your fix-attempt bound),
end your final message with a single JSON object on its own line, prefixed with SPIKE_RESULT:, for
example:
SPIKE_RESULT: {"testFile": "tests/foo.spec.ts", "outcome": "healed", "category": "locator_drift", "attempts": 1}
outcome must be exactly one of: "healed", "escalated", "gave_up", "passed_no_heal_needed".
--- END HEADLESS EXECUTION OVERRIDE ---
`;

async function main() {
  const { testFile, model } = parseArgs();

  const systemPrompt = loadHealerAgentPrompt() + HEADLESS_OVERRIDE;
  const userPrompt = testFile
    ? `Follow your instructions to heal the failing test at ${testFile}. Run it, diagnose the ` +
      `failure, and fix it - or escalate per the headless override if it's genuinely ambiguous.`
    : `Follow your instructions starting from step 1 (find failing tests across the whole repo) ` +
      `and heal whatever you find, one at a time.`;

  console.log(`--- Headless Healer spike starting ---`);
  console.log(`Target: ${testFile ?? '(whole suite)'}`);
  console.log(`Model: ${model ?? '(SDK default)'}`);
  console.log(`System prompt length: ${systemPrompt.length} chars`);
  console.log('');

  let turns = 0;
  let finalCostUsd: number | undefined;
  let finalResultText: string | undefined;
  const start = Date.now();

  for await (const message of query({
    prompt: userPrompt,
    options: {
      cwd: REPO_ROOT,
      systemPrompt,
      allowedTools: ['Bash', 'Read', 'Write', 'Edit'],
      permissionMode: 'dontAsk',
      maxTurns: 80,
      ...(model ? { model } : {}),
    },
  })) {
    const msg = message as any;
    turns += 1;

    if (msg.type === 'assistant' && msg.message?.content) {
      for (const block of msg.message.content) {
        if (block.type === 'text') {
          console.log(`[assistant] ${block.text.slice(0, 500)}`);
        } else if (block.type === 'tool_use') {
          console.log(`[tool_use] ${block.name}: ${JSON.stringify(block.input).slice(0, 300)}`);
        }
      }
    } else if (msg.type === 'user' && msg.message?.content) {
      for (const block of msg.message.content) {
        if (block.type === 'tool_result') {
          const text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
          console.log(`[tool_result] ${String(text).slice(0, 500)}`);
        }
      }
    } else if (msg.type === 'result') {
      finalCostUsd = msg.total_cost_usd;
      finalResultText = msg.result;
      console.log(`[result] subtype=${msg.subtype} cost_usd=${msg.total_cost_usd} turns=${msg.num_turns ?? 'n/a'}`);
    } else {
      console.log(`[${msg.type ?? 'unknown'}]`);
    }
  }

  const wallClockMs = Date.now() - start;

  console.log('');
  console.log('--- Headless Healer spike finished ---');
  console.log(`Wall clock: ${wallClockMs}ms`);
  console.log(`SDK-reported cost: $${finalCostUsd ?? 'unknown'}`);
  console.log(`Message/turn count observed: ${turns}`);

  const spikeResultMatch = finalResultText?.match(/SPIKE_RESULT:\s*(\{.*\})/);
  if (spikeResultMatch) {
    console.log(`Parsed spike result: ${spikeResultMatch[1]}`);
  } else {
    console.log('No SPIKE_RESULT JSON found in final message - check the full transcript above.');
  }

  if (fs.existsSync(ESCALATIONS_FILE)) {
    console.log('');
    console.log(`Escalations written to ${ESCALATIONS_FILE}:`);
    console.log(fs.readFileSync(ESCALATIONS_FILE, 'utf-8'));
  }
}

main().catch((err) => {
  console.error('Spike script failed:', err);
  process.exit(1);
});
