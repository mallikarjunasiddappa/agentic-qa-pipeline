#!/usr/bin/env node
/**
 * Verifies enqueue-from-pipeline-output.mjs (Phase B of "AI-Assisted Scrum and SDLC Console -
 * Development Plan") against a real, embedded Postgres instance - same @electric-sql/pglite
 * approach verify-migration.mjs and verify-queue-schema.mjs use, for the same reason (the real
 * Prisma CLI can't reach binaries.prisma.sh from this build sandbox).
 *
 * Seeds real rows across the exact scenarios the producer logic needs to distinguish:
 *  - a WorkflowRecord with Gate 1 cleared, Gate 2 pending -> SHOULD enqueue
 *  - a WorkflowRecord with both gates cleared -> should NOT enqueue (nothing pending)
 *  - a WorkflowRecord with neither gate cleared -> should NOT enqueue (not ready for Gate 2 yet)
 *  - a HealingEvent with outcome='escalated' -> SHOULD enqueue
 *  - a HealingEvent with outcome='healed' -> should NOT enqueue (nothing to escalate)
 * Then runs the enqueue function a second time and confirms it enqueues nothing new (the real
 * idempotency guarantee this script is meant to have when run repeatedly, e.g. from CI).
 *
 * Usage: node backend/scripts/verify-enqueue-from-pipeline-output.mjs
 */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { enqueueFromPipelineOutput } from './enqueue-from-pipeline-output.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaSqlPath = path.join(__dirname, 'schema.raw.sql');

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function main() {
  const db = new PGlite();
  await db.exec(readFileSync(schemaSqlPath, 'utf8'));
  console.log('Schema applied to a fresh in-memory Postgres instance.');

  const org = await db.query(`INSERT INTO "Organization" ("name") VALUES ('Verification Org') RETURNING "id"`);
  const orgId = org.rows[0].id;
  const project = await db.query(
    `INSERT INTO "Project" ("organizationId", "name") VALUES ($1, 'Verification Project') RETURNING "id"`,
    [orgId],
  );
  const projectId = project.rows[0].id;

  // WorkflowRecord scenarios.
  await db.query(
    `INSERT INTO "WorkflowRecord" ("projectId", "jiraKey", "scenariosApprovedAt", "testCasesApprovedAt")
     VALUES ($1, 'PEND-1', now(), NULL)`, // Gate 1 cleared, Gate 2 pending - SHOULD enqueue
    [projectId],
  );
  await db.query(
    `INSERT INTO "WorkflowRecord" ("projectId", "jiraKey", "scenariosApprovedAt", "testCasesApprovedAt")
     VALUES ($1, 'DONE-1', now(), now())`, // both gates cleared - should NOT enqueue
    [projectId],
  );
  await db.query(
    `INSERT INTO "WorkflowRecord" ("projectId", "jiraKey", "scenariosApprovedAt", "testCasesApprovedAt")
     VALUES ($1, 'EARLY-1', NULL, NULL)`, // neither gate cleared - should NOT enqueue
    [projectId],
  );

  // HealingEvent scenarios.
  await db.query(
    `INSERT INTO "HealingEvent" ("projectId", "timestamp", "testFilePath", "suite", "attemptNumber", "outcome", "category")
     VALUES ($1, now(), 'tests/checkout/checkout.spec.ts', 'checkout', 2, 'escalated', 'locator_drift')`, // SHOULD enqueue
    [projectId],
  );
  await db.query(
    `INSERT INTO "HealingEvent" ("projectId", "timestamp", "testFilePath", "suite", "attemptNumber", "outcome")
     VALUES ($1, now(), 'tests/checkout/checkout.spec.ts', 'checkout', 1, 'healed')`, // should NOT enqueue (healed, no category needed)
    [projectId],
  );

  console.log('Seeded 3 WorkflowRecords and 2 HealingEvents covering enqueue/skip scenarios.');

  const firstRun = await enqueueFromPipelineOutput(db, projectId);
  assertEqual(firstRun.testCaseReviewsEnqueued, 1, 'First run: testCaseReviewsEnqueued');
  assertEqual(firstRun.defectEscalationsEnqueued, 1, 'First run: defectEscalationsEnqueued');
  console.log('First run enqueued exactly 1 test-case review and 1 defect escalation, as expected.');

  const queueRows = await db.query(`SELECT * FROM "QueueItem" WHERE "projectId" = $1 ORDER BY "sourceStage"`, [projectId]);
  assertEqual(queueRows.rows.length, 2, 'Total QueueItem rows after first run');

  const defectItem = queueRows.rows.find((r) => r.sourceStage === 'defects');
  assertEqual(defectItem.type, 'ESCALATED', 'defect QueueItem.type');
  assertEqual(defectItem.state, 'PENDING', 'defect QueueItem.state');
  const draftBug = defectItem.payload.draftBugReport;
  if (!draftBug || typeof draftBug.summary !== 'string' || typeof draftBug.description !== 'string' || !Array.isArray(draftBug.labels)) {
    throw new Error(`defect QueueItem.payload.draftBugReport is not BugReport-shaped: ${JSON.stringify(draftBug)}`);
  }
  console.log('Defect QueueItem payload is correctly BugReport-shaped ({summary, description, labels}).');

  const testCaseItem = queueRows.rows.find((r) => r.sourceStage === 'test-cases');
  assertEqual(testCaseItem.type, 'NEEDS_SESSION', 'test-case QueueItem.type');
  assertEqual(testCaseItem.payload.jiraKey, 'PEND-1', 'test-case QueueItem.payload.jiraKey');
  console.log('Test-case QueueItem correctly points at the WorkflowRecord with Gate 1 cleared, Gate 2 pending.');

  const secondRun = await enqueueFromPipelineOutput(db, projectId);
  assertEqual(secondRun.testCaseReviewsEnqueued, 0, 'Second run: testCaseReviewsEnqueued');
  assertEqual(secondRun.defectEscalationsEnqueued, 0, 'Second run: defectEscalationsEnqueued');
  const queueRowsAfterSecondRun = await db.query(`SELECT * FROM "QueueItem" WHERE "projectId" = $1`, [projectId]);
  assertEqual(queueRowsAfterSecondRun.rows.length, 2, 'Total QueueItem rows after second (idempotent) run');
  console.log('Second run enqueued nothing new - idempotency confirmed against a real Postgres re-read.');

  console.log('VERIFICATION PASSED: enqueue-from-pipeline-output.mjs correctly identifies pending review state and is idempotent.');
}

main().catch((e) => {
  console.error('VERIFICATION FAILED:', e);
  process.exit(1);
});
