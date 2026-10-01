/**
 * Phase 2 pure core - "record from the trace, don't re-explore" (spec section 6). Turns a PASSED
 * ticket-verify session into a specs/<feature>.plan.md scenario in the exact format
 * specParser.ts's parseScenariosFromSpec consumes: the steps come from the recorded trace (the
 * proven path), and the expectations come from the AC-derived, live-confirmed verdicts. No IO -
 * the promote stage owns reading the session, appending to the spec, and opening Gate 1.
 */
import { Priority } from '../types/schemas';
import { AcVerdict } from './acVerification';
import { TicketVerifySession } from './sessionStore';

export interface PromoteInput {
  groupName: string;
  scenarioId: string;
  testFilePath: string;
  precondition: string;
  priority: Priority;
  steps: string[];
  expectations: string[];
}

/** Kebab-case, filesystem/heading-safe scenario id from free text (e.g. a ticket summary). */
export function toScenarioId(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
  return slug || 'scenario';
}

/**
 * Emits one scenario block in the plan.md format. Standalone-valid (numbered `### 1.` / `#### 1.1.`):
 * the promote stage renumbers when appending under an existing group. Metadata (File / Precondition /
 * Priority) is emitted BEFORE `**Steps:**` because the parser stops matching metadata once steps
 * begin; expectations are emitted as `- expect:` lines after the steps.
 */
export function buildPlanScenario(input: PromoteInput, groupIndex = 1): string {
  const lines: string[] = [];
  lines.push(`### ${groupIndex}. ${input.groupName}`);
  lines.push('');
  lines.push(`#### ${groupIndex}.1. ${input.scenarioId}`);
  lines.push('');
  lines.push('**File:** `' + input.testFilePath + '`');
  lines.push('');
  lines.push(`**Precondition:** ${input.precondition}`);
  lines.push('');
  lines.push(`**Priority:** ${input.priority}`);
  lines.push('');
  lines.push('**Steps:**');
  input.steps.forEach((step, index) => lines.push(`  ${index + 1}. ${step}`));
  for (const expectation of input.expectations) lines.push(`    - expect: ${expectation}`);
  lines.push('');
  return lines.join('\n');
}

/**
 * Builds the PromoteInput from a passed ticket-verify session: steps are the recorded trace's
 * actions (the proven path), expectations are the `then` clause of every PASSED acceptance
 * criterion (the live-confirmed oracle). The caller supplies the group name and target test file
 * (the engineer decides where the test lives), and only calls this for a promotable (all-pass)
 * session.
 */
export function promoteInputFromSession(
  session: TicketVerifySession,
  verdicts: AcVerdict[],
  opts: { groupName: string; testFilePath: string; priority?: Priority },
): PromoteInput {
  const steps = (session.trace ?? []).map((s) => s.action).filter((a) => a.trim().length > 0);
  const expectations = verdicts
    .filter((v) => v.status === 'pass')
    .map((v) => v.then ?? v.criterionText);
  return {
    groupName: opts.groupName,
    scenarioId: toScenarioId(`${session.ticket.key}-${opts.groupName}`),
    testFilePath: opts.testFilePath,
    precondition: session.ticket.precondition ?? 'Logged in as the seeded test account.',
    priority: opts.priority ?? 'medium',
    steps: steps.length > 0 ? steps : ['(no trace recorded - fill in the steps taken)'],
    expectations,
  };
}


/**
 * The next free top-level group index in an existing plan.md (1 + the highest `### N.` heading),
 * so a promoted scenario appends as its own new group rather than colliding with existing numbering.
 * Returns 1 for a spec with no groups yet.
 */
export function nextGroupIndex(specContent: string): number {
  let max = 0;
  for (const line of specContent.split(/\r?\n/)) {
    const m = line.match(/^###\s+(\d+)\.\s+/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

/** Wraps a scenario block in a fresh plan.md file (title + Jira marker + Test Scenarios section). */
export function buildNewSpecFile(title: string, jiraKey: string, scenarioBlock: string): string {
  return [`# ${title}`, '', `<!-- Jira: ${jiraKey} -->`, '', '## Test Scenarios', '', scenarioBlock, ''].join('\n');
}
