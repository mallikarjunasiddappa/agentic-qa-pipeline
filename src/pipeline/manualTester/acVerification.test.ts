import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sectionize,
  parseTicket,
  parseAcceptanceCriteria,
  classifyAmbiguity,
  mapVerdicts,
  summarizeOutcome,
  suggestClarification,
  composeVerificationComment,
  AcceptanceCriterion,
  AcObservation,
} from './acVerification';

// The real SCRUM-76 description ("Answer All Reading Question Types Correctly"), as JiraAdapter
// .getRequirement() delivers it (ADF -> plain text, one line per paragraph/list item). Using the
// actual ticket as the fixture proves the parser against production content, not a toy sample.
const SCRUM_76 = `Description:
As a student, I want every Reading question type to render and accept my answer correctly, so that I can complete any paper regardless of its question mix.

Precondition:
User is attempting a Reading paper.

Action Steps:
Answer a True/False/Not Given question and verify the selection is recorded.
Answer a Multiple Choice question and verify only the allowed number of options can be selected.
Answer a Matching Headings / Matching Information question using the dropdown or drag control.
Fill a Sentence/Summary/Note Completion text box and verify the entry is recorded.
Fill a Short Answer question and verify the word limit rule is applied.

Acceptance Criteria:
Given any supported question type renders, When the user answers, Then the answer should be recorded and displayed back correctly.
Given a Multiple Choice question allows one answer, When a second option is selected, Then the previous selection should be replaced.
Given a completion question has a word limit, When the user exceeds it, Then a warning or validation should apply.

Positive Scenarios:
Answer one question of each supported type and verify all are recorded.
Change an answer on each type and verify the latest value is retained.

Negative Scenarios:
Enter only whitespace in a text-entry answer and verify it counts as unanswered.

Expected Result:
Every question type records answers accurately and enforces its own input rules.`;

test('sectionize buckets each section and drops blank lines', () => {
  const s = sectionize(SCRUM_76);
  assert.equal(s['action steps'].length, 5);
  assert.equal(s['acceptance criteria'].length, 3);
  assert.equal(s['positive scenarios'].length, 2);
  assert.equal(s['expected result'].length, 1);
});

test('parseTicket extracts story, precondition, 5 action steps and 3 acceptance criteria', () => {
  const t = parseTicket('SCRUM-76', 'Answer All Reading Question Types Correctly', SCRUM_76);
  assert.equal(t.key, 'SCRUM-76');
  assert.ok(t.story && t.story.startsWith('As a student'));
  assert.equal(t.precondition, 'User is attempting a Reading paper.');
  assert.equal(t.actionSteps.length, 5);
  assert.equal(t.acceptanceCriteria.length, 3);
});

test('parseAcceptanceCriteria ids criteria and splits Given/When/Then', () => {
  const ac = parseAcceptanceCriteria(SCRUM_76);
  assert.deepEqual(ac.map((c) => c.id), ['AC-1', 'AC-2', 'AC-3']);
  assert.equal(ac[0].given, 'any supported question type renders');
  assert.equal(ac[0].when, 'the user answers');
  assert.ok(ac[0].then && ac[0].then.startsWith('the answer should be recorded'));
  assert.ok(ac[2].then && ac[2].then.includes('warning or validation'));
});

test('classifyAmbiguity flags only the under-specified "warning or validation" criterion', () => {
  const ac = parseAcceptanceCriteria(SCRUM_76);
  assert.equal(classifyAmbiguity(ac[0]).ambiguous, false);
  assert.equal(classifyAmbiguity(ac[1]).ambiguous, false);
  const a3 = classifyAmbiguity(ac[2]);
  assert.equal(a3.ambiguous, true);
  assert.match(a3.reason ?? '', /under-specified/);
});

test('mapVerdicts forces an ambiguous criterion to NEEDS-CLARIFICATION even when observed as a fail (comment-not-bug guard)', () => {
  const ac = parseAcceptanceCriteria(SCRUM_76);
  const observations: AcObservation[] = [
    { acId: 'AC-1', status: 'pass', observed: 'each supported type reflected the answer' },
    { acId: 'AC-2', status: 'pass', observed: 'selecting a second option replaced the first' },
    { acId: 'AC-3', status: 'fail', observed: 'nothing happened past the word limit' },
  ];
  const verdicts = mapVerdicts(ac, observations);
  assert.equal(verdicts[0].status, 'pass');
  assert.equal(verdicts[1].status, 'pass');
  assert.equal(verdicts[2].status, 'ambiguous'); // NOT 'fail' - guard downgraded it
  assert.ok(verdicts[2].note);
});

test('mapVerdicts marks a criterion with no observation as not-exercised', () => {
  const ac = parseAcceptanceCriteria(SCRUM_76);
  const verdicts = mapVerdicts(ac, [{ acId: 'AC-1', status: 'pass', observed: 'ok' }]);
  assert.equal(verdicts[0].status, 'pass');
  assert.equal(verdicts[1].status, 'not-exercised');
  assert.equal(verdicts[2].status, 'ambiguous');
});

test('summarizeOutcome: pass+pass+ambiguous -> needs-clarification, comment yes, no bug, not promotable', () => {
  const ac = parseAcceptanceCriteria(SCRUM_76);
  const verdicts = mapVerdicts(ac, [
    { acId: 'AC-1', status: 'pass', observed: 'ok' },
    { acId: 'AC-2', status: 'pass', observed: 'ok' },
    { acId: 'AC-3', status: 'pass', observed: 'ok' },
  ]);
  const outcome = summarizeOutcome(verdicts);
  assert.equal(outcome.overall, 'needs-clarification');
  assert.equal(outcome.shouldComment, true);
  assert.equal(outcome.shouldFileBug, false);
  assert.equal(outcome.promotable, false);
});

test('summarizeOutcome: a real fail on a non-ambiguous criterion -> fail + file bug', () => {
  const criteria: AcceptanceCriterion[] = [
    { id: 'AC-1', text: 'Then the answer is recorded', then: 'the answer is recorded' },
    { id: 'AC-2', text: 'Then the selection is replaced', then: 'the selection is replaced' },
  ];
  const verdicts = mapVerdicts(criteria, [
    { acId: 'AC-1', status: 'pass', observed: 'ok' },
    { acId: 'AC-2', status: 'fail', observed: 'both selections stayed' },
  ]);
  const outcome = summarizeOutcome(verdicts);
  assert.equal(outcome.overall, 'fail');
  assert.equal(outcome.shouldFileBug, true);
  assert.equal(outcome.promotable, false);
});

test('summarizeOutcome: all non-ambiguous criteria pass -> pass + promotable', () => {
  const criteria: AcceptanceCriterion[] = [
    { id: 'AC-1', text: 'Then the answer is recorded', then: 'the answer is recorded' },
    { id: 'AC-2', text: 'Then the selection is replaced', then: 'the selection is replaced' },
  ];
  const verdicts = mapVerdicts(criteria, [
    { acId: 'AC-1', status: 'pass', observed: 'ok' },
    { acId: 'AC-2', status: 'pass', observed: 'ok' },
  ]);
  const outcome = summarizeOutcome(verdicts);
  assert.equal(outcome.overall, 'pass');
  assert.equal(outcome.promotable, true);
  assert.equal(outcome.shouldFileBug, false);
});

test('summarizeOutcome: some not-exercised, rest pass, none ambiguous -> incomplete', () => {
  const criteria: AcceptanceCriterion[] = [
    { id: 'AC-1', text: 'Then the answer is recorded', then: 'the answer is recorded' },
    { id: 'AC-2', text: 'Then the selection is replaced', then: 'the selection is replaced' },
  ];
  const verdicts = mapVerdicts(criteria, [{ acId: 'AC-1', status: 'pass', observed: 'ok' }]);
  assert.equal(summarizeOutcome(verdicts).overall, 'incomplete');
});

test('suggestClarification produces a concrete proposal for the ambiguous criterion', () => {
  const ac = parseAcceptanceCriteria(SCRUM_76);
  const proposal = suggestClarification(ac[2]);
  assert.equal(proposal.acId, 'AC-3');
  assert.match(proposal.proposedCriterion, /under-specified/);
  assert.match(proposal.rationale, /single testable outcome/);
});

test('composeVerificationComment renders the key, verdicts, and proposals as line-per-item text', () => {
  const ac = parseAcceptanceCriteria(SCRUM_76);
  const verdicts = mapVerdicts(ac, [
    { acId: 'AC-1', status: 'pass', observed: 'each type reflected the answer' },
    { acId: 'AC-2', status: 'pass', observed: 'second option replaced the first' },
    { acId: 'AC-3', status: 'fail', observed: 'no visible response past the limit' },
  ]);
  const comment = composeVerificationComment({ key: 'SCRUM-76' }, verdicts, [suggestClarification(ac[2])]);
  assert.match(comment, /verification of SCRUM-76/);
  assert.match(comment, /AC-1 \[PASS\]/);
  assert.match(comment, /AC-3 \[NEEDS CLARIFICATION\]/);
  assert.match(comment, /Proposed acceptance-criteria clarifications:/);
  assert.match(comment, /Summary: 2 passed, 0 failed, 1 need clarification, 0 not exercised\./);
});
