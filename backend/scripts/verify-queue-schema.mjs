#!/usr/bin/env node
/**
 * Verifies the QueueItem table (Phase A of "AI-Assisted Scrum and SDLC Console - Development
 * Plan", docs/planning/) against a real, embedded Postgres instance - same @electric-sql/pglite
 * approach verify-migration.mjs uses for the rest of this schema, and for the same reason: the
 * real Prisma CLI can't reach binaries.prisma.sh from this build sandbox (see README.md's "Known
 * limitation" section), so this is real evidence the DDL is valid and behaves correctly, not a
 * substitute for running `prisma generate`/`prisma migrate dev` yourself.
 *
 * Confirms, against a real running Postgres (not a mock): the table creates from schema.raw.sql
 * with the rest of the schema; a real insert scoped to a real Project FK succeeds; an insert with
 * a bad projectId is rejected by a real foreign-key constraint; an insert with an invalid `type`
 * value is rejected by a real enum constraint; resolving an item (state/resolvedAt/
 * resolvedByUserId/actionTaken) round-trips correctly on read-back.
 *
 * Usage: node backend/scripts/verify-queue-schema.mjs
 */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaSqlPath = path.join(__dirname, 'schema.raw.sql');

async function main() {
  const db = new PGlite();
  await db.exec(readFileSync(schemaSqlPath, 'utf8'));
  console.log('Schema applied to a fresh in-memory Postgres instance.');

  const org = await db.query(
    `INSERT INTO "Organization" ("name") VALUES ('Verification Org') RETURNING "id"`,
  );
  const orgId = org.rows[0].id;
  const project = await db.query(
    `INSERT INTO "Project" ("organizationId", "name") VALUES ($1, 'Verification Project') RETURNING "id"`,
    [orgId],
  );
  const projectId = project.rows[0].id;
  const user = await db.query(
    `INSERT INTO "User" ("organizationId", "email", "ssoSubject") VALUES ($1, 'verifier@example.com', 'sso:verifier') RETURNING "id"`,
    [orgId],
  );
  const userId = user.rows[0].id;

  // Real insert, real FK to a real Project.
  const created = await db.query(
    `INSERT INTO "QueueItem" ("projectId", "type", "sourceStage", "payload")
     VALUES ($1, 'SUGGESTED', 'test-cases', $2) RETURNING *`,
    [projectId, JSON.stringify({ draft: 'a suggested test scenario' })],
  );
  const queueItemId = created.rows[0].id;
  if (created.rows[0].state !== 'PENDING') {
    throw new Error(`Expected default state PENDING, got ${created.rows[0].state}`);
  }
  console.log('Real insert against a real Project FK succeeded, defaulted to state=PENDING.');

  // Bad FK should be rejected by a real constraint, not silently accepted.
  let fkRejected = false;
  try {
    await db.query(
      `INSERT INTO "QueueItem" ("projectId", "type", "sourceStage", "payload")
       VALUES ('not-a-real-project-id', 'SUGGESTED', 'test-cases', '{}')`,
    );
  } catch (e) {
    fkRejected = true;
  }
  if (!fkRejected) throw new Error('Expected a bad projectId to be rejected by a real FK constraint - it was not.');
  console.log('Bad projectId correctly rejected by a real foreign-key constraint.');

  // Bad enum value should be rejected by a real constraint, not silently accepted.
  let enumRejected = false;
  try {
    await db.query(
      `INSERT INTO "QueueItem" ("projectId", "type", "sourceStage", "payload")
       VALUES ($1, 'NOT_A_REAL_TYPE', 'test-cases', '{}')`,
      [projectId],
    );
  } catch (e) {
    enumRejected = true;
  }
  if (!enumRejected) throw new Error('Expected an invalid type value to be rejected by a real enum constraint - it was not.');
  console.log('Invalid type value correctly rejected by a real enum constraint.');

  // Resolve round-trips correctly on read-back.
  await db.query(
    `UPDATE "QueueItem" SET "state" = 'RESOLVED', "resolvedAt" = now(), "resolvedByUserId" = $1, "actionTaken" = 'approved_as_is' WHERE "id" = $2`,
    [userId, queueItemId],
  );
  const resolved = await db.query(`SELECT * FROM "QueueItem" WHERE "id" = $1`, [queueItemId]);
  const row = resolved.rows[0];
  if (row.state !== 'RESOLVED' || row.resolvedByUserId !== userId || row.actionTaken !== 'approved_as_is' || !row.resolvedAt) {
    throw new Error(`Resolve did not round-trip correctly: ${JSON.stringify(row)}`);
  }
  console.log('Resolve (state/resolvedAt/resolvedByUserId/actionTaken) round-trips correctly on read-back.');

  console.log('VERIFICATION PASSED: QueueItem schema is valid, real Postgres DDL, constraints enforced.');
}

main().catch((e) => {
  console.error('VERIFICATION FAILED:', e);
  process.exit(1);
});
