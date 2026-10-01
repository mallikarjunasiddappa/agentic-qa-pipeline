import { test } from 'node:test';
import assert from 'node:assert/strict';
import { annotateDatesWithRelativeTime, computeAssigneeWorkloadSummaries } from './askEngine';

// Fixed reference point for every test below - a real bug this covers only reproduces relative to
// a specific "now", so a moving Date.now() would make these tests non-deterministic.
const NOW = new Date('2026-08-24T12:00:00Z');

test('annotateDatesWithRelativeTime: real bug - "started yesterday" for a sprint that started 3 days ago', () => {
  // This is the exact shape (sprintStatus's sprint.startDate/endDate) that produced the real,
  // live-verified bug: the model correctly computed one delta and got the other wrong in the same
  // response, even when told the real current date - see askEngine.ts's own doc comment.
  const json = JSON.stringify({ startDate: '2026-08-21T10:11:32.981Z', endDate: '2026-09-04T10:11:32.981Z' });
  const annotated = annotateDatesWithRelativeTime(json, NOW);
  assert.match(annotated, /"2026-08-21T10:11:32\.981Z" \(3 days ago\)/);
  assert.match(annotated, /"2026-09-04T10:11:32\.981Z" \(in 11 days\)/);
});

test('annotateDatesWithRelativeTime: today/tomorrow/yesterday use words, not "in 0 days" etc.', () => {
  const json = JSON.stringify({ today: '2026-08-24', tomorrow: '2026-08-25', yesterday: '2026-08-23' });
  const annotated = annotateDatesWithRelativeTime(json, NOW);
  assert.match(annotated, /"2026-08-24" \(today\)/);
  assert.match(annotated, /"2026-08-25" \(tomorrow\)/);
  assert.match(annotated, /"2026-08-23" \(yesterday\)/);
});

test('annotateDatesWithRelativeTime: leaves non-date strings untouched', () => {
  const json = JSON.stringify({ summary: 'not a date', assignee: 'Mallikarjuna S' });
  assert.equal(annotateDatesWithRelativeTime(json, NOW), json);
});

test('computeAssigneeWorkloadSummaries: real bug - "12 points including the completed work" when completed items have null points', () => {
  // Mirrors the exact real data that produced this bug: Mallikarjuna's two done issues have
  // storyPoints: null, so nothing from completed work is actually in his not-done total - the
  // model's own "including the completed work" description was false even though the 12 was right.
  const data = {
    sprints: [
      {
        issues: [
          { key: 'A', assignee: 'Mallikarjuna S', statusCategory: 'done', storyPoints: null },
          { key: 'B', assignee: 'Mallikarjuna S', statusCategory: 'done', storyPoints: null },
          { key: 'C', assignee: 'Mallikarjuna S', statusCategory: 'new', storyPoints: 5 },
          { key: 'D', assignee: 'Mallikarjuna S', statusCategory: 'new', storyPoints: 3 },
          { key: 'E', assignee: 'Mallikarjuna S', statusCategory: 'new', storyPoints: 4 },
          { key: 'F', assignee: 'Varun', statusCategory: 'new', storyPoints: 2 },
          { key: 'G', assignee: 'Varun', statusCategory: 'new', storyPoints: 4 },
          { key: 'H', assignee: 'Punya', statusCategory: 'new', storyPoints: 3 },
          { key: 'I', assignee: 'Punya', statusCategory: 'new', storyPoints: 4 },
        ],
      },
    ],
  };
  const summaries = computeAssigneeWorkloadSummaries(data);
  assert.equal(summaries.length, 1);
  assert.match(summaries[0], /Mallikarjuna S: 3 not-done item\(s\), 12 not-done story point\(s\)/);
  assert.match(summaries[0], /Varun: 2 not-done item\(s\), 6 not-done story point\(s\)/);
  assert.match(summaries[0], /Punya: 2 not-done item\(s\), 7 not-done story point\(s\)/);
});

test('computeAssigneeWorkloadSummaries: an assignee who is fully done contributes no line (0 not-done items)', () => {
  const data = {
    issues: [
      { assignee: 'Fully Done Person', statusCategory: 'done', storyPoints: null },
      { assignee: 'Fully Done Person', statusCategory: 'done', storyPoints: null },
    ],
  };
  assert.deepEqual(computeAssigneeWorkloadSummaries(data), []);
});

test('computeAssigneeWorkloadSummaries: returns [] for report data with no assignee-issue-shaped arrays', () => {
  const data = { totalEvents: 0, overall: { healed: 0 } }; // healing/report.json's real shape
  assert.deepEqual(computeAssigneeWorkloadSummaries(data), []);
});

test('computeAssigneeWorkloadSummaries: unassigned issues are grouped under "(unassigned)", not dropped', () => {
  const data = {
    issues: [
      { assignee: null, statusCategory: 'new', storyPoints: 3 },
      { assignee: null, statusCategory: 'new', storyPoints: 2 },
    ],
  };
  const summaries = computeAssigneeWorkloadSummaries(data);
  assert.equal(summaries.length, 1);
  assert.match(summaries[0], /\(unassigned\): 2 not-done item\(s\), 5 not-done story point\(s\)/);
});
