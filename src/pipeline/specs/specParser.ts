import fs from 'node:fs';
import { Scenario, ScenarioSchema, PrioritySchema } from '../types/schemas';

interface ParsedGroup {
  name: string;
  seedFile: string;
  priority?: string;
}

const GROUP_HEADING_RE = /^###\s+\d+\.\s+(.+?)\s*$/;
const SEED_RE = /^\*\*Seed:\*\*\s*`([^`]+)`/;
const SCENARIO_HEADING_RE = /^####\s+\d+\.\d+\.\s+(.+?)\s*$/;
const FILE_RE = /^\*\*File:\*\*\s*`([^`]+)`/;
const PRECONDITION_RE = /^\*\*Precondition:\*\*\s*(.+?)\s*$/i;
const PRIORITY_RE = /^\*\*Priority:\*\*\s*(low|medium|high|critical)\s*$/i;
const STEPS_LABEL_RE = /^\*\*Steps:\*\*/;
const STEP_RE = /^\s*\d+\.\s+(.+?)\s*$/;
const EXPECT_RE = /^\s*-\s*expect:\s*(.+?)\s*$/i;
const JIRA_KEY_RE = /^<!--\s*Jira:\s*(\S+)\s*-->/;
const SUITE_RE = /^<!--\s*Suite:\s*(.+?)\s*-->/;

function humanizeName(kebabName: string): string {
  return kebabName
    .split('-')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Parses the "## Test Scenarios" section of a specs/<feature>.plan.md file (as written by the
 * playwright-cli skill's Planning step) into zod-validated Scenario objects for the Excel and
 * Qase agents. See .claude/skills/playwright-cli/references/test-generation.md section 1.4 for
 * the source format.
 */
export function parseScenariosFromSpec(specFilePath: string): Scenario[] {
  const lines = fs.readFileSync(specFilePath, 'utf-8').split('\n');
  const scenarios: Scenario[] = [];

  let currentGroup: ParsedGroup | null = null;
  let currentName: string | null = null;
  let currentFile: string | null = null;
  let currentPrecondition: string | null = null;
  let currentPriority: string | null = null;
  let currentSteps: string[] = [];
  let currentExpects: string[] = [];
  let inSteps = false;
  let lastTarget: 'step' | 'expect' | null = null;

  const flush = () => {
    if (currentName === null) return;
    scenarios.push(
      ScenarioSchema.parse({
        id: currentName,
        title: currentGroup
          ? `${currentGroup.name}: ${humanizeName(currentName)}`
          : humanizeName(currentName),
        // A scenario-specific **Precondition:** line always wins - it's the actual, testable
        // starting state a human wrote for this one scenario. Falls back to the group's shared
        // **Seed:** path only for older specs written before this field existed; that fallback is
        // deliberately not prose (it's a file reference), so the Scenario Quality Guardrail's
        // no-implementation-details check exempts the Precondition field specifically to avoid
        // blocking on it - see scenarioQualityRules.ts.
        preconditions: currentPrecondition ?? (currentGroup?.seedFile ? `Seed: ${currentGroup.seedFile}` : ''),
        steps: currentSteps.length > 0 ? currentSteps : ['(no steps captured)'],
        expectedResult:
          currentExpects.length > 0 ? currentExpects.join('; ') : '(no expectations captured)',
        // A scenario-specific **Priority:** line overrides the group's shared one, which in turn
        // overrides the 'medium' default - same override-wins-over-group-default shape as
        // Precondition above. Previously this was unconditionally hardcoded to 'medium', silently
        // ignoring any **Priority:** line a spec author wrote; specs already relying on that (e.g.
        // priority set by hand during Excel review, never written back to the spec) keep working
        // via the 'medium' fallback.
        priority: PrioritySchema.parse((currentPriority ?? currentGroup?.priority ?? 'medium').toLowerCase()),
        testFilePath: currentFile ?? undefined,
        suite: currentGroup?.name,
      }),
    );
    currentName = null;
    currentFile = null;
    currentPrecondition = null;
    currentPriority = null;
    currentSteps = [];
    currentExpects = [];
    inSteps = false;
    lastTarget = null;
  };

  for (const rawLine of lines) {
    const groupMatch = rawLine.match(GROUP_HEADING_RE);
    if (groupMatch) {
      flush();
      currentGroup = { name: groupMatch[1], seedFile: '' };
      continue;
    }

    if (currentGroup && !currentGroup.seedFile) {
      const seedMatch = rawLine.match(SEED_RE);
      if (seedMatch) {
        currentGroup.seedFile = seedMatch[1];
        continue;
      }
    }

    if (currentGroup && currentName === null && !currentGroup.priority) {
      const groupPriorityMatch = rawLine.match(PRIORITY_RE);
      if (groupPriorityMatch) {
        currentGroup.priority = groupPriorityMatch[1];
        continue;
      }
    }

    const scenarioMatch = rawLine.match(SCENARIO_HEADING_RE);
    if (scenarioMatch) {
      flush();
      currentName = scenarioMatch[1].replace(/`/g, '').trim();
      continue;
    }

    if (currentName === null) continue;

    if (currentFile === null) {
      const fileMatch = rawLine.match(FILE_RE);
      if (fileMatch) {
        currentFile = fileMatch[1];
        continue;
      }
    }

    if (currentPrecondition === null) {
      const preconditionMatch = rawLine.match(PRECONDITION_RE);
      if (preconditionMatch) {
        currentPrecondition = preconditionMatch[1];
        continue;
      }
    }

    if (currentPriority === null) {
      const priorityMatch = rawLine.match(PRIORITY_RE);
      if (priorityMatch) {
        currentPriority = priorityMatch[1];
        continue;
      }
    }

    if (STEPS_LABEL_RE.test(rawLine)) {
      inSteps = true;
      continue;
    }

    if (!inSteps) continue;

    const expectMatch = rawLine.match(EXPECT_RE);
    if (expectMatch) {
      currentExpects.push(expectMatch[1]);
      lastTarget = 'expect';
      continue;
    }

    const stepMatch = rawLine.match(STEP_RE);
    if (stepMatch) {
      currentSteps.push(stepMatch[1]);
      lastTarget = 'step';
      continue;
    }

    // Soft-wrapped continuation of the previous step/expect line, not a new list item.
    const continuation = rawLine.trim();
    if (continuation.length === 0) continue;

    if (lastTarget === 'step' && currentSteps.length > 0) {
      currentSteps[currentSteps.length - 1] += ` ${continuation}`;
    } else if (lastTarget === 'expect' && currentExpects.length > 0) {
      currentExpects[currentExpects.length - 1] += ` ${continuation}`;
    }
  }

  flush();
  return scenarios;
}

/**
 * Reads the `<!-- Jira: KEY -->` marker a spec file carries under its title (see section 1.4 of
 * test-generation.md / the KAN-1 example in specs/profile-subscriptions.plan.md). One spec file
 * covers one Jira ticket across all of its scenarios.
 */
export function parseJiraKeyFromSpec(specFilePath: string): string | null {
  const lines = fs.readFileSync(specFilePath, 'utf-8').split('\n');
  for (const line of lines) {
    const match = line.match(JIRA_KEY_RE);
    if (match) return match[1];
  }
  return null;
}

/**
 * Reads an optional `<!-- Suite: My Feature -->` marker a spec file may carry under its title, next
 * to the `<!-- Jira: KEY -->` marker. When present it names the top-level TMS suite every case
 * generated from this spec is filed under (see resolveSuiteTitle in testmgmt/suiteResolver.ts and
 * --stage tms-upload). Optional - returns null when the spec declares no suite, so the caller falls
 * back to the --suite flag or the Jira key rather than a guessed suite.
 */
export function parseSuiteFromSpec(specFilePath: string): string | null {
  const lines = fs.readFileSync(specFilePath, 'utf-8').split('\n');
  for (const line of lines) {
    const match = line.match(SUITE_RE);
    if (match) return match[1].trim();
  }
  return null;
}
