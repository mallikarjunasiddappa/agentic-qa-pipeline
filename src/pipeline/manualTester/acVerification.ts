/**
 * Mode B (ticket-driven verification) pure core for the Manual-Tester Agent. No IO: given a Jira
 * ticket's plain-text description (JiraAdapter.getRequirement / JiraClient.extractDescription) and
 * the live observations the agent gathered, these functions parse the acceptance criteria, map
 * results to per-AC verdicts, enforce the "ambiguous AC -> comment, never a pass/fail bug" guard,
 * decide the filing outcome, and compose the human-gated Jira comment (verdicts + proposed AC
 * clarifications). The browser driving and the actual Jira write live in the stage shell; the
 * judgement logic lives here so it is unit-testable against a real ticket fixture (SCRUM-76).
 */

export interface AcceptanceCriterion {
  id: string;
  text: string;
  given?: string;
  when?: string;
  then?: string;
}

export interface ParsedTicket {
  key: string;
  summary: string;
  story?: string;
  precondition?: string;
  actionSteps: string[];
  acceptanceCriteria: AcceptanceCriterion[];
}

export type AcVerdictStatus = 'pass' | 'fail' | 'ambiguous' | 'not-exercised';

/** What the agent observed for one criterion. Only a concrete pass/fail is reported here; the
 *  'ambiguous'/'not-exercised' statuses are derived by mapVerdicts, never claimed by the agent. */
export interface AcObservation {
  acId: string;
  status: 'pass' | 'fail';
  observed: string;
}

export interface AcVerdict {
  acId: string;
  criterionText: string;
  given?: string;
  when?: string;
  then?: string;
  status: AcVerdictStatus;
  observed: string;
  note?: string;
}

export interface ProposedClarification {
  acId: string;
  proposedCriterion: string;
  rationale: string;
}

const SECTION_LABELS = [
  'description',
  'precondition',
  'action steps',
  'acceptance criteria',
  'positive scenarios',
  'negative scenarios',
  'expected result',
] as const;
type SectionLabel = (typeof SECTION_LABELS)[number];

function normalizeHeader(line: string): SectionLabel | null {
  const key = line.trim().replace(/:$/, '').toLowerCase();
  return (SECTION_LABELS as readonly string[]).includes(key) ? (key as SectionLabel) : null;
}

/** Buckets a ticket description's lines under its section headers. Blank lines are dropped; text
 *  before the first recognised header is ignored (a plain "Description:" preamble label, say). */
export function sectionize(description: string): Record<SectionLabel, string[]> {
  const out = {} as Record<SectionLabel, string[]>;
  for (const label of SECTION_LABELS) out[label] = [];
  let current: SectionLabel | null = null;
  for (const raw of description.split(/\r?\n/)) {
    const header = normalizeHeader(raw);
    if (header) {
      current = header;
      continue;
    }
    const line = raw.trim();
    if (line === '' || current === null) continue;
    out[current].push(line);
  }
  return out;
}

const GWT = /^given\s+(.*?),\s*when\s+(.*?),\s*then\s+(.*)$/i;

/** Parses the Acceptance Criteria section into structured, id'd criteria (AC-1, AC-2, ...). Each
 *  line becomes one criterion; a Given/When/Then line additionally has its three clauses split. */
export function parseAcceptanceCriteria(description: string): AcceptanceCriterion[] {
  return sectionize(description)['acceptance criteria'].map((text, i) => {
    const criterion: AcceptanceCriterion = { id: `AC-${i + 1}`, text };
    const m = GWT.exec(text);
    if (m) {
      criterion.given = m[1].trim();
      criterion.when = m[2].trim();
      criterion.then = m[3].trim();
    }
    return criterion;
  });
}

export function parseTicket(key: string, summary: string, description: string): ParsedTicket {
  const sections = sectionize(description);
  const join = (label: SectionLabel): string | undefined =>
    sections[label].length ? sections[label].join(' ') : undefined;
  return {
    key,
    summary,
    story: join('description'),
    precondition: join('precondition'),
    actionSteps: sections['action steps'],
    acceptanceCriteria: parseAcceptanceCriteria(description),
  };
}

/**
 * The "app-wrong vs ticket-stale" guard, deterministic half: a criterion whose expected outcome is
 * itself under-specified cannot be judged pass/fail. Flags a Then-clause that offers alternative
 * outcomes ("a warning or validation"), or any criterion text that literally says clarification is
 * required. When flagged, mapVerdicts downgrades the verdict to 'ambiguous' so the agent comments
 * for clarification instead of filing a false bug.
 */
export function classifyAmbiguity(criterion: AcceptanceCriterion): { ambiguous: boolean; reason?: string } {
  if (/clarification required/i.test(criterion.text)) {
    return { ambiguous: true, reason: 'criterion text marks clarification as required' };
  }
  const thenClause = criterion.then ?? criterion.text;
  if (/\bor\b/i.test(thenClause)) {
    return {
      ambiguous: true,
      reason:
        `expected outcome is under-specified - it allows alternatives ("${thenClause}"), so pass/fail ` +
        'cannot be judged until one required behaviour is chosen',
    };
  }
  return { ambiguous: false };
}

/**
 * Joins criteria to the agent's observations by acId and applies the ambiguity guard. A criterion
 * with no observation is 'not-exercised'; an ambiguous criterion is always 'ambiguous' regardless
 * of what the observation claimed - the comment-not-bug guard, enforced here so no code path can
 * turn an under-specified AC into a filed bug.
 */
export function mapVerdicts(criteria: AcceptanceCriterion[], observations: AcObservation[]): AcVerdict[] {
  const byId = new Map(observations.map((o) => [o.acId, o]));
  return criteria.map((c) => {
    const obs = byId.get(c.id);
    const ambiguity = classifyAmbiguity(c);
    const verdict: AcVerdict = {
      acId: c.id,
      criterionText: c.text,
      given: c.given,
      when: c.when,
      then: c.then,
      status: obs ? obs.status : 'not-exercised',
      observed: obs ? obs.observed : '(not exercised in this session)',
    };
    if (ambiguity.ambiguous) {
      verdict.status = 'ambiguous';
      verdict.note = ambiguity.reason;
    }
    return verdict;
  });
}

export interface VerificationOutcome {
  counts: { pass: number; fail: number; ambiguous: number; notExercised: number; total: number };
  overall: 'pass' | 'fail' | 'needs-clarification' | 'incomplete';
  shouldFileBug: boolean;
  shouldComment: boolean;
  promotable: boolean;
}

/**
 * Rolls verdicts into one outcome and the resulting actions. Precedence: any real fail -> 'fail'
 * (file a bug, gated); else any ambiguous -> 'needs-clarification' (comment only); else any
 * not-exercised -> 'incomplete'; else 'pass'. Only a clean 'pass' is promotable to a scripted
 * regression test (spec section 6). shouldComment is true whenever there is anything to report.
 */
export function summarizeOutcome(verdicts: AcVerdict[]): VerificationOutcome {
  const counts = {
    pass: verdicts.filter((v) => v.status === 'pass').length,
    fail: verdicts.filter((v) => v.status === 'fail').length,
    ambiguous: verdicts.filter((v) => v.status === 'ambiguous').length,
    notExercised: verdicts.filter((v) => v.status === 'not-exercised').length,
    total: verdicts.length,
  };
  let overall: VerificationOutcome['overall'];
  if (counts.fail > 0) overall = 'fail';
  else if (counts.ambiguous > 0) overall = 'needs-clarification';
  else if (counts.notExercised > 0) overall = 'incomplete';
  else overall = 'pass';
  return {
    counts,
    overall,
    shouldFileBug: counts.fail > 0,
    shouldComment: counts.total > 0,
    promotable: overall === 'pass',
  };
}

/**
 * A starting-point clarification scaffold for an ambiguous criterion - the agent may refine the
 * wording, but this guarantees every ambiguous AC leaves the session with a concrete proposal to
 * post, satisfying the "add/clarify acceptance criteria after the test" requirement deterministically.
 */
export function suggestClarification(criterion: AcceptanceCriterion): ProposedClarification {
  const then = criterion.then ?? criterion.text;
  return {
    acId: criterion.id,
    proposedCriterion:
      `Given ${criterion.given ?? '<precondition>'}, When ${criterion.when ?? '<action>'}, ` +
      `Then <choose exactly one required outcome> (currently under-specified as "${then}").`,
    rationale:
      `Replace the ambiguity in "${then}" with a single testable outcome so this criterion can be ` +
      'verified pass/fail and automated.',
  };
}

const STATUS_LABEL: Record<AcVerdictStatus, string> = {
  pass: 'PASS',
  fail: 'FAIL',
  ambiguous: 'NEEDS CLARIFICATION',
  'not-exercised': 'NOT EXERCISED',
};

/**
 * Composes the human-gated Jira comment: a one-line summary, each AC's verdict + observation, and a
 * "Proposed acceptance-criteria clarifications" block. Plain line-per-item text (no markdown
 * tables) because JiraClient.addComment renders each non-empty line as its own ADF paragraph.
 */
export function composeVerificationComment(
  ticket: { key: string },
  verdicts: AcVerdict[],
  proposals: ProposedClarification[] = [],
): string {
  const outcome = summarizeOutcome(verdicts);
  const lines: string[] = [];
  lines.push(
    `Manual-Tester Agent - ticket-driven verification of ${ticket.key} (automated, posted after human review).`,
  );
  lines.push(
    `Summary: ${outcome.counts.pass} passed, ${outcome.counts.fail} failed, ` +
      `${outcome.counts.ambiguous} need clarification, ${outcome.counts.notExercised} not exercised.`,
  );
  for (const v of verdicts) {
    lines.push(`${v.acId} [${STATUS_LABEL[v.status]}] ${v.criterionText}`);
    lines.push(`  observed: ${v.observed}`);
    if (v.note) lines.push(`  note: ${v.note}`);
  }
  if (proposals.length > 0) {
    lines.push('Proposed acceptance-criteria clarifications:');
    for (const p of proposals) {
      lines.push(`  ${p.acId} -> ${p.proposedCriterion}`);
      lines.push(`  rationale: ${p.rationale}`);
    }
  }
  lines.push('Verdicts reflect a single verification session on the live app; please confirm before acting.');
  return lines.join('\n');
}
