/**
 * Pure row-shaping for Phase B of "AI-Assisted Scrum and SDLC Console - Development Plan"
 * (docs/planning/): wiring the six-agent pipeline's EXISTING output into the AI Queue (Phase A's
 * QueueItem table) instead of building a second drafting mechanism, per that plan's Section 4.
 * No IO here, same reasoning as backend/scripts/lib/buildMigrationRows.mjs - keeps this testable
 * without a database (see verify-enqueue-from-pipeline-output.mjs).
 *
 * Two producers, both read-then-diff against already-created QueueItems so re-running the script
 * (enqueue-from-pipeline-output.mjs, a real cron/CI candidate) never double-enqueues the same
 * source row - same idempotency posture as buildMigrationRows.mjs's callers.
 */
import { randomUUID } from 'node:crypto';

/**
 * Test cases: a WorkflowRecord whose Gate 1 (scenariosApprovedAt) is cleared but Gate 2
 * (testCasesApprovedAt) isn't yet is exactly "test cases from Planning -> Generator -> Excel ->
 * TMS are ready for human review" - the real state the dev plan's Phase B describes connecting,
 * not a new judgment. Excludes any WorkflowRecord that already has a 'test-cases' QueueItem
 * pointing at it (via payload.workflowRecordId).
 */
export function selectNewTestCaseReviews(workflowRecords, existingQueueItems) {
  const alreadyQueuedIds = new Set(
    existingQueueItems
      .filter((item) => item.sourceStage === 'test-cases')
      .map((item) => item.payload?.workflowRecordId)
      .filter(Boolean),
  );
  return workflowRecords.filter(
    (w) => w.scenariosApprovedAt != null && w.testCasesApprovedAt == null && !alreadyQueuedIds.has(w.id),
  );
}

export function buildTestCaseQueueItemRow(projectId, workflowRecord) {
  return {
    id: randomUUID(),
    projectId,
    type: 'NEEDS_SESSION',
    sourceStage: 'test-cases',
    payload: {
      producedBy: 'enqueue-from-pipeline-output',
      workflowRecordId: workflowRecord.id,
      jiraKey: workflowRecord.jiraKey,
      scenariosApprovedAt: workflowRecord.scenariosApprovedAt,
      note:
        'Gate 1 (scenarios) is cleared; test cases from the six-agent pipeline (Planning -> ' +
        'Generator -> Excel -> TMS) are ready for Gate 2 human review. Approving/rejecting the ' +
        'actual gate still happens via the existing POST .../test-cases/approve route - this item ' +
        'is a pointer into the unified queue, not a second approval mechanism.',
    },
  };
}

/**
 * Defects: a HealingEvent with outcome 'escalated' is exactly the Healer's own documented
 * failure-escalation path (see docs/planning/End-to-End Pipeline Validation - Runbook.md) -
 * connecting it to the already-existing-but-unused JiraClient.createBug() (src/pipeline/jira/
 * jiraClient.ts), per the dev plan's Phase B note that the write capability already exists and
 * choosing Jira here is the lower-friction path. Excludes any HealingEvent that already has a
 * 'defects' QueueItem pointing at it (via payload.healingEventId).
 */
export function selectNewEscalatedDefects(healingEvents, existingQueueItems) {
  const alreadyQueuedIds = new Set(
    existingQueueItems
      .filter((item) => item.sourceStage === 'defects')
      .map((item) => item.payload?.healingEventId)
      .filter(Boolean),
  );
  return healingEvents.filter((h) => h.outcome === 'escalated' && !alreadyQueuedIds.has(h.id));
}

export function buildDefectQueueItemRow(projectId, healingEvent) {
  const target = healingEvent.testTitle
    ? `${healingEvent.testFilePath} :: ${healingEvent.testTitle}`
    : healingEvent.testFilePath;
  return {
    id: randomUUID(),
    projectId,
    type: 'ESCALATED',
    sourceStage: 'defects',
    payload: {
      producedBy: 'enqueue-from-pipeline-output',
      healingEventId: healingEvent.id,
      jiraKey: healingEvent.jiraKey ?? null,
      externalCaseId: healingEvent.externalCaseId ?? null,
      suite: healingEvent.suite,
      attemptNumber: healingEvent.attemptNumber,
      category: healingEvent.category ?? null,
      // Shaped to match src/pipeline/types/schemas.ts's BugReportSchema ({summary, description,
      // labels}) exactly - JiraClient.createBug()'s real input type - so a human resolving this via
      // the queue is looking at (and can edit) the actual payload that would be sent to Jira, not
      // an invented shape. The resolve action does NOT call createBug() yet - see this repo's
      // README.md "AI Queue" section for why that last wire (real Jira credentials from within
      // backend/, which has none configured today) is left as explicit follow-up, not faked here.
      draftBugReport: {
        summary: `Healer escalation: ${target} failed to self-heal${healingEvent.category ? ` (${healingEvent.category})` : ''}`,
        description: [
          `Suite: ${healingEvent.suite}`,
          `Test: ${target}`,
          `Attempt: ${healingEvent.attemptNumber}`,
          `Category: ${healingEvent.category ?? 'unknown'}`,
          `Timestamp: ${healingEvent.timestamp}`,
          '',
          'The Healer agent attempted to self-heal this failure and escalated instead of ' +
            'resolving it - a human should confirm severity and labels before this is filed.',
        ].join('\n'),
        labels: ['healer-escalation', healingEvent.category].filter(Boolean),
      },
    },
  };
}
