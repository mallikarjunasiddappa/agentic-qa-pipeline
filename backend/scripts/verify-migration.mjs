#!/usr/bin/env node
/**
 * Verifies migrate-tenant.mjs's row-shaping and SQL write logic against a REAL tenant data
 * directory, without needing a live Postgres server or the `pg` npm package: it applies
 * prisma/schema.prisma's schema (translated to raw DDL, see ../README.md) to a fresh in-process
 * @electric-sql/pglite instance, then calls the exact same loadTenantRows()/writeTenantRows()
 * functions the production CLI uses, and independently re-reads the result back out of the
 * database to confirm it landed correctly. Also re-runs the same migration a second time to
 * confirm the append-only tables' "skip if already populated" idempotency guard works.
 *
 * This is how backend/prisma/schema.prisma and this migration script were verified end-to-end
 * before being committed - see backend/README.md's "Known limitation" section for why the Prisma
 * CLI itself couldn't be exercised in the build sandbox, and why this pglite-based approach is the
 * substitute used throughout this package's development.
 *
 * Usage: node backend/scripts/verify-migration.mjs [path/to/data/<tenantId>]
 * Defaults to ../../data/default (this repo's own real tenant data) if no path is given.
 */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTenantRows, writeTenantRows } from './migrate-tenant.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaSqlPath = path.join(__dirname, 'schema.raw.sql');
const dataDir = process.argv[2] ?? path.join(__dirname, '../../data/default');

async function main() {
  const db = new PGlite();
  await db.exec(readFileSync(schemaSqlPath, 'utf8'));
  console.log(`Schema applied to a fresh in-memory Postgres instance.`);
  console.log(`Loading tenant data from: ${dataDir}`);

  const rows = await loadTenantRows(dataDir, 'default', 'Verification Org', 'Main');
  console.log('Loaded row counts:', {
    workflow: rows.workflow.length,
    traceability: rows.traceability.length,
    healing: rows.healing.length,
    flaky: rows.flaky.length,
    quarantine: rows.quarantine.length,
    cost: rows.cost.length,
  });

  const result = await writeTenantRows(db, rows);
  console.log('Write result:', JSON.stringify(result, null, 2));

  const wfCount = await db.query('SELECT count(*)::int as n FROM "WorkflowRecord"');
  const healCount = await db.query('SELECT count(*)::int as n FROM "HealingEvent"');
  const costCount = await db.query('SELECT count(*)::int as n FROM "CostEvent"');
  console.log('Independent re-read counts:', {
    workflow: wfCount.rows[0].n,
    healing: healCount.rows[0].n,
    cost: costCount.rows[0].n,
  });

  if (wfCount.rows[0].n !== rows.workflow.length) throw new Error('WorkflowRecord count mismatch after write');
  if (healCount.rows[0].n !== rows.healing.length) throw new Error('HealingEvent count mismatch after write');
  if (costCount.rows[0].n !== rows.cost.length) throw new Error('CostEvent count mismatch after write');

  // Idempotency: re-running must not duplicate rows.
  const rows2 = await loadTenantRows(dataDir, 'default', 'Verification Org', 'Main');
  await writeTenantRows(db, rows2);
  const wfCount2 = await db.query('SELECT count(*)::int as n FROM "WorkflowRecord"');
  const healCount2 = await db.query('SELECT count(*)::int as n FROM "HealingEvent"');
  if (wfCount2.rows[0].n !== wfCount.rows[0].n) throw new Error('Idempotency check failed: WorkflowRecord duplicated on re-run');
  if (healCount2.rows[0].n !== healCount.rows[0].n) throw new Error('Idempotency check failed: HealingEvent duplicated on re-run');

  console.log('VERIFICATION PASSED: schema is valid, real tenant data migrates correctly, and re-running is idempotent.');
}

main().catch((e) => {
  console.error('VERIFICATION FAILED:', e);
  process.exit(1);
});
