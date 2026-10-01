#!/usr/bin/env node
/**
 * Phase B of "AI-Assisted Scrum and SDLC Console - Development Plan" (docs/planning/): scans one
 * migrated project's existing WorkflowRecord/HealingEvent rows for real pending-human-review state
 * and enqueues a QueueItem for each one not already queued - "connect the existing output," not a
 * second drafting mechanism, per that plan's Section 4.
 *
 * Two producers (see scripts/lib/buildQueueProducerRows.mjs for the full reasoning on each):
 *  - test-cases: a WorkflowRecord with Gate 1 (scenariosApprovedAt) cleared but Gate 2
 *    (testCasesApprovedAt) still pending -> a NEEDS_SESSION QueueItem.
 *  - defects: a HealingEvent with outcome='escalated' (the Healer's own documented
 *    failure-escalation path) -> an ESCALATED QueueItem, payload shaped to match
 *    JiraClient.createBug()'s real BugReport input type.
 *
 * Uses raw parameterized SQL against the `pg` package, same as migrate-tenant.mjs and for the same
 * reason (Prisma Client can't be generated in the build sandbox - see backend/README.md's "Known
 * limitation" section). Both the row-shaping logic and the SQL below were verified against a real,
 * embedded Postgres (@electric-sql/pglite) before this was committed - see
 * verify-enqueue-from-pipeline-output.mjs.
 *
 * Idempotent by design, meant to be run repeatedly (a real cron/CI candidate, like sprint-status/
 * standup-digest already are for the CLI pipeline): each producer excludes source rows that already
 * have a QueueItem pointing at them (via payload.workflowRecordId / payload.healingEventId), so
 * running this twice in a row enqueues nothing new the second time.
 *
 * Usage:
 *   DATABASE_URL=postgresql://... node backend/scripts/enqueue-from-pipeline-output.mjs \
 *     --project-id <a real Project.id, e.g. from migrate-tenant.mjs's output>
 */
import { pathToFileURL } from 'node:url';
import {
  selectNewTestCaseReviews,
  buildTestCaseQueueItemRow,
  selectNewEscalatedDefects,
  buildDefectQueueItemRow,
} from './lib/buildQueueProducerRows.mjs';

// Same flag-based parser as migrate-tenant.mjs, same reasoning (a strict positional-pair parser
// breaks on any multi-word flag value) - kept duplicated rather than shared to avoid coupling two
// otherwise-independent scripts to a third shared module for four lines of logic.
function parseArgs(argv) {
  const args = {};
  let currentKey = null;
  for (const token of argv) {
    if (token.startsWith('--')) {
      currentKey = token.slice(2);
      args[currentKey] = '';
    } else if (currentKey) {
      args[currentKey] = args[currentKey] ? `${args[currentKey]} ${token}` : token;
    }
  }
  return args;
}

/**
 * Reads the candidate source rows for one project. `client` only needs a `.query(text, params)`
 * method returning `{ rows }` - satisfied by both a real `pg.Client`/`pg.Pool` and by
 * @electric-sql/pglite, exactly like migrate-tenant.mjs's writeTenantRows().
 */
export async function loadCandidateSourceRows(client, projectId) {
  const workflowRes = await client.query('SELECT * FROM "WorkflowRecord" WHERE "projectId" = $1', [projectId]);
  const healingRes = await client.query('SELECT * FROM "HealingEvent" WHERE "projectId" = $1', [projectId]);
  const queueRes = await client.query('SELECT * FROM "QueueItem" WHERE "projectId" = $1', [projectId]);
  return {
    workflowRecords: workflowRes.rows,
    healingEvents: healingRes.rows,
    existingQueueItems: queueRes.rows,
  };
}

/** Loads candidates, shapes the new rows, writes them, and returns a summary. */
export async function enqueueFromPipelineOutput(client, projectId) {
  const { workflowRecords, healingEvents, existingQueueItems } = await loadCandidateSourceRows(client, projectId);

  const testCaseRows = selectNewTestCaseReviews(workflowRecords, existingQueueItems).map((w) =>
    buildTestCaseQueueItemRow(projectId, w),
  );
  const defectRows = selectNewEscalatedDefects(healingEvents, existingQueueItems).map((h) =>
    buildDefectQueueItemRow(projectId, h),
  );

  for (const row of [...testCaseRows, ...defectRows]) {
    await client.query(
      `INSERT INTO "QueueItem" (id, "projectId", type, "sourceStage", payload) VALUES ($1,$2,$3,$4,$5)`,
      [row.id, row.projectId, row.type, row.sourceStage, JSON.stringify(row.payload)],
    );
  }

  return {
    testCaseReviewsEnqueued: testCaseRows.length,
    defectEscalationsEnqueued: defectRows.length,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const projectId = args['project-id'];
  if (!projectId) {
    console.error('Usage: node enqueue-from-pipeline-output.mjs --project-id <id>');
    process.exit(1);
  }

  console.log('Connecting to database (DATABASE_URL host/db from env)...');
  const { Client } = await import('pg');
  const client = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10_000 });
  await client.connect();
  console.log(`Connected. Scanning project ${projectId} for pending-review pipeline output...`);
  try {
    const result = await enqueueFromPipelineOutput(client, projectId);
    console.log('Enqueue complete:', JSON.stringify(result, null, 2));
  } finally {
    await client.end();
  }
}

// Same Windows pathToFileURL entrypoint-guard fix as migrate-tenant.mjs - see that file's own
// comment for why the naive `file://${process.argv[1]}` comparison never matches on Windows.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error('Enqueue failed:', e);
    process.exit(1);
  });
}
