import { Scenario } from '../types/schemas';

export type ScenarioQualitySeverity = 'block' | 'warn';

export interface ScenarioQualityFinding {
  // null for a spec-level/batch finding that isn't about one specific scenario (e.g. "every
  // scenario has the same priority").
  scenarioId: string | null;
  rule: string;
  severity: ScenarioQualitySeverity;
  message: string;
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'to', 'of', 'on', 'in', 'is', 'are', 'was', 'were', 'be', 'been', 'and', 'or',
  'for', 'with', 'that', 'this', 'it', 'as', 'at', 'by', 'from', 'should', 'will', 'shall', 'then',
  'when', 'after', 'before', 'user', 'page', 'into', 'out', 'not', 'no', 'can', 'has', 'have', 'had',
]);

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    (word) => word.length >= 3 && !STOPWORDS.has(word),
  );
}

function tokenSet(text: string): Set<string> {
  return new Set(tokenize(text));
}

// Cheap stand-in for stemming: two words "relate" if one is a prefix of the other (min 3 shared
// chars) - catches "login"/"log", "cancel"/"cancellation", "subscribe"/"subscription" without a
// real stemming library. Deliberately loose; false "related" matches just mean a check stays
// quiet, which is the safe direction for a heuristic to err in.
function wordsRelated(a: string, b: string): boolean {
  if (a === b) return true;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return shorter.length >= 3 && longer.startsWith(shorter);
}

function anyWordRelated(word: string, others: Iterable<string>): boolean {
  for (const other of others) {
    if (wordsRelated(word, other)) return true;
  }
  return false;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// --- ID format + uniqueness ---

const ID_FORMAT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function checkIdFormatAndUniqueness(scenarios: Scenario[]): ScenarioQualityFinding[] {
  const findings: ScenarioQualityFinding[] = [];
  const seen = new Map<string, number>();

  for (const scenario of scenarios) {
    const id = scenario.id.trim();
    if (id.length === 0) {
      findings.push({
        scenarioId: scenario.id,
        rule: 'id-format',
        severity: 'block',
        message: 'Scenario has an empty ID.',
      });
      continue;
    }
    if (!ID_FORMAT_RE.test(id)) {
      findings.push({
        scenarioId: id,
        rule: 'id-format',
        severity: 'block',
        message: `ID "${id}" contains spaces/punctuation that isn't a single identifier token (letters, digits, "-", "_" only).`,
      });
    }
    const key = id.toLowerCase();
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }

  for (const [key, count] of seen) {
    if (count > 1) {
      findings.push({
        scenarioId: key,
        rule: 'id-uniqueness',
        severity: 'block',
        message: `ID "${key}" is used by ${count} scenarios in this spec - IDs must be unique.`,
      });
    }
  }

  return findings;
}

// --- Title quality + uniqueness ---

export function checkTitleQuality(scenarios: Scenario[]): ScenarioQualityFinding[] {
  const findings: ScenarioQualityFinding[] = [];
  const seen = new Map<string, number>();

  for (const scenario of scenarios) {
    const title = scenario.title.trim();
    if (title.length === 0) {
      findings.push({
        scenarioId: scenario.id,
        rule: 'title-quality',
        severity: 'block',
        message: 'Scenario has an empty title.',
      });
      continue;
    }
    const key = title.toLowerCase();
    seen.set(key, (seen.get(key) ?? 0) + 1);

    const colonIndex = title.indexOf(':');
    if (colonIndex > -1) {
      const prefixWords = tokenSet(title.slice(0, colonIndex));
      const restWords = tokenize(title.slice(colonIndex + 1));
      if (restWords.length > 0) {
        const overlap = restWords.filter((w) => anyWordRelated(w, prefixWords)).length;
        const ratio = overlap / restWords.length;
        if (ratio >= 0.5) {
          findings.push({
            scenarioId: scenario.id,
            rule: 'title-quality',
            severity: 'block',
            message: `Title "${title}" repeats ${Math.round(ratio * 100)}% of its words between the category prefix and the rest - reads like a generated test-function name, not a human-written title.`,
          });
        }
      }
    }
  }

  for (const [key, count] of seen) {
    if (count > 1) {
      findings.push({
        scenarioId: null,
        rule: 'title-uniqueness',
        severity: 'block',
        message: `Title "${key}" is used by ${count} scenarios in this spec - titles must be unique.`,
      });
    }
  }

  return findings;
}

// --- Precondition quality ---

const MIN_PRECONDITION_LENGTH = 15;

export function checkPreconditionQuality(scenarios: Scenario[]): ScenarioQualityFinding[] {
  const findings: ScenarioQualityFinding[] = [];

  for (const scenario of scenarios) {
    const pre = scenario.preconditions.trim();
    if (pre.length === 0) {
      findings.push({
        scenarioId: scenario.id,
        rule: 'precondition-quality',
        severity: 'block',
        message: 'Precondition is empty.',
      });
    } else if (pre.length < MIN_PRECONDITION_LENGTH) {
      findings.push({
        scenarioId: scenario.id,
        rule: 'precondition-quality',
        severity: 'block',
        message: `Precondition "${pre}" is too short (${pre.length} chars) to state a concrete, testable starting state.`,
      });
    }
  }

  if (scenarios.length > 1) {
    const normalized = scenarios.map((s) => s.preconditions.trim().toLowerCase());
    const allIdentical = normalized[0].length > 0 && normalized.every((p) => p === normalized[0]);
    if (allIdentical) {
      findings.push({
        scenarioId: null,
        rule: 'precondition-quality',
        severity: 'block',
        message: `All ${scenarios.length} scenarios in this spec share the exact same precondition ("${scenarios[0].preconditions.trim()}") - likely generic copy-paste rather than a real, scenario-specific starting state (e.g. which test account, what data must already exist).`,
      });
    }
  }

  return findings;
}

// --- Step granularity ---

const MAX_STEP_LENGTH = 160;
const MIN_STEPS_FOR_COMPRESSED_FLOW = 3;

function looksCompound(step: string): boolean {
  const andCount = (step.match(/\band\b/gi) ?? []).length;
  const commaCount = (step.match(/,/g) ?? []).length;
  return step.length > MAX_STEP_LENGTH || andCount >= 2 || (andCount >= 1 && commaCount >= 1);
}

export function checkStepGranularity(scenarios: Scenario[]): ScenarioQualityFinding[] {
  const findings: ScenarioQualityFinding[] = [];

  for (const scenario of scenarios) {
    scenario.steps.forEach((step, index) => {
      if (looksCompound(step)) {
        const preview = step.length > 80 ? `${step.slice(0, 80)}…` : step;
        findings.push({
          scenarioId: scenario.id,
          rule: 'step-granularity',
          severity: 'block',
          message: `Step ${index + 1} ("${preview}") looks like it combines multiple actions into one step - split into separate numbered steps, one action each.`,
        });
      }
    });

    const expectClauseCount = scenario.expectedResult.split(';').filter((c) => c.trim().length > 0).length;
    if (scenario.steps.length === 1 && expectClauseCount >= MIN_STEPS_FOR_COMPRESSED_FLOW) {
      findings.push({
        scenarioId: scenario.id,
        rule: 'step-granularity',
        severity: 'block',
        message: `Scenario has only 1 step but ${expectClauseCount} expected-result clauses - the flow that produces those results is likely compressed into a single step and should be broken out into the steps that actually produce each result.`,
      });
    }
  }

  return findings;
}

// --- Expected Result granularity + missing ---

const MAX_EXPECT_CLAUSES = 3;
const PLACEHOLDER_EXPECT = '(no expectations captured)';

export function checkExpectedResultQuality(scenarios: Scenario[]): ScenarioQualityFinding[] {
  const findings: ScenarioQualityFinding[] = [];

  for (const scenario of scenarios) {
    const expected = scenario.expectedResult.trim();
    if (expected.length === 0 || expected === PLACEHOLDER_EXPECT) {
      findings.push({
        scenarioId: scenario.id,
        rule: 'expected-result',
        severity: 'block',
        message: 'Expected Result is missing.',
      });
      continue;
    }
    const clauses = expected.split(';').map((c) => c.trim()).filter(Boolean);
    if (clauses.length > MAX_EXPECT_CLAUSES) {
      findings.push({
        scenarioId: scenario.id,
        rule: 'expected-result',
        severity: 'block',
        message: `Expected Result has ${clauses.length} semicolon-separated clauses crammed into one cell - split into multiple expected-result lines (or separate scenarios) so a tester can check each one independently.`,
      });
    }
  }

  return findings;
}

// --- Priority variance ---

export function checkPriorityVariance(scenarios: Scenario[]): ScenarioQualityFinding[] {
  if (scenarios.length < 2) return [];
  const priorities = new Set(scenarios.map((s) => s.priority));
  if (priorities.size === 1) {
    return [
      {
        scenarioId: null,
        rule: 'priority-variance',
        severity: 'block',
        message: `All ${scenarios.length} scenarios in this spec are priority "${scenarios[0].priority}" - verify each was actually assessed individually rather than left at a default.`,
      },
    ];
  }
  return [];
}

// --- Observable expected results ---

const VAGUE_PHRASES = [
  'works correctly',
  'functions correctly',
  'behaves correctly',
  'works as designed',
  'successfully',
  'properly',
  'as expected',
  'as intended',
  'correctly',
];

export function checkObservability(scenarios: Scenario[]): ScenarioQualityFinding[] {
  const findings: ScenarioQualityFinding[] = [];

  for (const scenario of scenarios) {
    const haystacks = [
      { field: 'Expected Result', text: scenario.expectedResult },
      ...scenario.steps.map((step, i) => ({ field: `step ${i + 1}`, text: step })),
    ];
    for (const { field, text } of haystacks) {
      const lower = text.toLowerCase();
      const hit = VAGUE_PHRASES.find((phrase) => lower.includes(phrase));
      if (hit) {
        findings.push({
          scenarioId: scenario.id,
          rule: 'observability',
          severity: 'block',
          message: `${field} uses vague, unobservable language ("${hit}") without a concrete, checkable criterion - state exactly what the tester should see, read, or count instead.`,
        });
      }
    }
  }

  return findings;
}

// --- No implementation details in tester-facing text ---

const IMPLEMENTATION_PATTERNS: { label: string; re: RegExp; excludeFields?: string[] }[] = [
  { label: 'a data-test-id attribute', re: /data-test-id/i },
  { label: 'locator/selector API syntax', re: /getByRole|getByLabel|getByTestId|querySelector|\.locator\(/i },
  { label: 'an HTML tag', re: /<\/?(div|span|button|input|table|tr|td)[\s>]/i },
  { label: 'SQL', re: /\b(SELECT|INSERT INTO|UPDATE\s+\w+\s+SET|DELETE FROM)\b/i },
  { label: 'a raw HTTP/API path', re: /\b(GET|POST|PUT|PATCH|DELETE)\s+\/[\w/-]*/ },
  // Excludes 'Precondition': specParser.ts always renders it as "Seed: <path>.spec.ts" - sanctioned
  // pipeline-generated metadata naming which seed test sets up the starting state, not an agent
  // typing implementation detail into tester-facing prose. Still applies to every other field, so a
  // stray file reference in a step or expected result is still caught.
  { label: 'a source code file reference', re: /\b[\w-]+\.(ts|js|tsx|jsx|json)\b/i, excludeFields: ['Precondition'] },
];

export function checkNoImplementationDetails(scenarios: Scenario[]): ScenarioQualityFinding[] {
  const findings: ScenarioQualityFinding[] = [];

  for (const scenario of scenarios) {
    const haystacks = [
      { field: 'Precondition', text: scenario.preconditions },
      { field: 'Expected Result', text: scenario.expectedResult },
      ...scenario.steps.map((step, i) => ({ field: `step ${i + 1}`, text: step })),
    ];
    for (const { field, text } of haystacks) {
      const match = IMPLEMENTATION_PATTERNS.find(
        ({ re, excludeFields }) => re.test(text) && !excludeFields?.includes(field),
      );
      if (match) {
        const preview = text.length > 60 ? `${text.slice(0, 60)}…` : text;
        findings.push({
          scenarioId: scenario.id,
          rule: 'no-implementation-details',
          severity: 'block',
          message: `${field} ("${preview}") looks like it contains ${match.label} - manual test cases should describe tester-observable behavior, not implementation.`,
        });
      }
    }
  }

  return findings;
}

// --- Traceability to the source Jira ticket ---

export function checkTraceabilityToTicket(
  scenarios: Scenario[],
  ticketText: string,
): ScenarioQualityFinding[] {
  const ticketTokens = tokenSet(ticketText);
  if (ticketTokens.size === 0) return [];

  const findings: ScenarioQualityFinding[] = [];
  for (const scenario of scenarios) {
    const scenarioTokens = tokenize([scenario.title, ...scenario.steps, scenario.expectedResult].join(' '));
    const overlap = scenarioTokens.filter((t) => anyWordRelated(t, ticketTokens)).length;
    if (overlap === 0) {
      findings.push({
        scenarioId: scenario.id,
        rule: 'traceability-to-ticket',
        severity: 'block',
        message:
          'Scenario shares no keywords at all with the Jira ticket summary/description - verify it actually traces back to this ticket rather than having been generated off-topic.',
      });
    }
  }
  return findings;
}

// --- Warn-only: possible invented business rules ---

const SPECIFIC_VALUE_RE =
  /\b\d+(\.\d+)?\s?(hours?|hrs?|minutes?|mins?|days?|%|percent|seconds?|secs?)\b|\$\s?\d+(\.\d+)?/gi;

export function checkInventedBusinessRules(
  scenarios: Scenario[],
  ticketText: string,
): ScenarioQualityFinding[] {
  if (ticketText.trim().length === 0) return [];
  const findings: ScenarioQualityFinding[] = [];
  const lowerTicketText = ticketText.toLowerCase();

  for (const scenario of scenarios) {
    const text = [scenario.preconditions, ...scenario.steps, scenario.expectedResult].join(' ');
    const matches = text.match(SPECIFIC_VALUE_RE) ?? [];
    for (const match of matches) {
      if (!lowerTicketText.includes(match.toLowerCase())) {
        findings.push({
          scenarioId: scenario.id,
          rule: 'invented-business-rule',
          severity: 'warn',
          message: `Mentions a specific value ("${match.trim()}") that doesn't appear anywhere in the Jira ticket text - double-check this wasn't invented rather than sourced from the requirement. Heuristic check, may be a false positive (e.g. a generic value or one paraphrased from the ticket).`,
        });
      }
    }
  }

  return findings;
}

// --- Warn-only: duplicate semantic coverage between scenarios ---

const SIMILARITY_THRESHOLD = 0.6;

export function checkDuplicateCoverage(scenarios: Scenario[]): ScenarioQualityFinding[] {
  const findings: ScenarioQualityFinding[] = [];
  const sets = scenarios.map((s) => tokenSet([s.title, ...s.steps, s.expectedResult].join(' ')));

  for (let i = 0; i < scenarios.length; i += 1) {
    for (let j = i + 1; j < scenarios.length; j += 1) {
      const similarity = jaccard(sets[i], sets[j]);
      if (similarity >= SIMILARITY_THRESHOLD) {
        findings.push({
          scenarioId: scenarios[i].id,
          rule: 'duplicate-coverage',
          severity: 'warn',
          message: `Scenario "${scenarios[i].id}" and "${scenarios[j].id}" share ${Math.round(similarity * 100)}% word overlap in their steps/expected results - verify they're not testing the same behavior twice. Heuristic (word overlap, not true semantic comparison), may be a false positive.`,
        });
      }
    }
  }

  return findings;
}
