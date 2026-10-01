#!/usr/bin/env node
/**
 * Migrates one existing data/<tenantId>/ directory into the Phase 2 Postgres schema
 * (backend/prisma/schema.prisma). Real production run needs `pg` (added to backend/package.json)
 * and a real DATABASE_URL; see backend/README.md for why this uses raw parameterized SQL instead
 * of the generated Prisma Client (prisma generate can't be verified in the build sandbox - this
 * script's SQL matches the schema's column/constraint names exactly, and both the row-shaping
 * logic and the INSERT statements below were verified against real tenant data through
 * @electric-sql/pglite before this was committed - see backend/scripts/verify-migration.mjs).
 *
 * Usage:
 *   DATABASE_URL=postgresql://... node backend/scripts/migrate-tenant.mjs \
 *     --tenant-id default --org-name "Default Org" --data-dir ../data/default
 *
 * Idempotency: WorkflowRecord, TraceabilityEntry, and QuarantineEntry rows use ON CONFLICT DO
 * NOTHING against the same unique constraints the schema declares, so re-running is safe for those.
 * HealingEvent/FlakyEvent/CostEvent are append-only history with no natural unique key in the
 * source JSONL (same as the flat files today) - this script guards against double-importing them
 * by skipping any table that already has rows for the target project, and says so.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  buildOrganizationRow,
  buildDefaultProjectRow,
  buildWorkflowRows,
  buildTraceabilityRows,
  buildHealingRows,
  buildFlakyRows,
  buildQuarantineRows,
  buildCostRows,
} from './lib/buildMigrationRows.mjs';

/**
 * Flag-based, not positional-pair-based: an argv item starting with `--` starts a new flag, and
 * every following item up to the next `--flag` is joined (space-separated) into that flag's value.
 * A strict "consume exactly 2 argv slots per flag" parser breaks the moment any value contains a
 * space (e.g. --org-name "Default Org"), because the shell hands that through as two argv entries
 * ('Default', 'Org') and everything after silently shifts out of alignment - the bug that produced
 * a completely silent failure below (dataDir ended up undefined, but the mis-shifted args also
 * broke the intended "print usage and exit" fallback instead of triggering it visibly).
 */
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

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

async function readTextIfExists(filePath) {
  try {
    return await readFile(filePath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return '';
    throw e;
  }
}

/**
 * Loads every source file for one tenant off disk and shapes it via buildMigrationRows.mjs's pure
 * functions. Exported so verify-migration.mjs can call this exact code path against real fixture
 * data without needing a database.
 */
export async function loadTenantRows(dataDir, tenantId, orgName, projectName) {
  const manifest = (await readJsonIfExists(path.join(dataDir, 'traceability/manifest.json'))) ?? {
    workflow: [],
    entries: [],
  };
  const healingJsonl = await readTextIfExists(path.join(dataDir, 'healing/telemetry.jsonl'));
  const flakyJsonl = await readTextIfExists(path.join(dataDir, 'flaky/telemetry.jsonl'));
  const quarantineArr = (await readJsonIfExists(path.join(dataDir, 'flaky/quarantine.json'))) ?? [];
  const costJsonl = await readTextIfExists(path.join(dataDir, 'cost/telemetry.jsonl'));

  const org = buildOrganizationRow(tenantId, orgName);
  const project = buildDefaultProjectRow(org.id, projectName);

  return {
    org,
    project,
    workflow: buildWorkflowRows(manifest, project.id),
    traceability: buildTraceabilityRows(manifest, project.id),
    healing: buildHealingRows(healingJsonl, project.id),
    flaky: buildFlakyRows(flakyJsonl, project.id),
    quarantine: buildQuarantineRows(quarantineArr, project.id),
    cost: buildCostRows(costJsonl, project.id),
  };
}

/**
 * Resolves a legacy free-text operator string to a real User row via a deterministic placeholder
 * ssoSubject, upserting it if it doesn't exist yet. Returns null for a null operator (gate not yet
 * cleared/approved in the source data). Real SSO wiring later replaces how new Users are created,
 * not this lookup shape.
 */
async function resolveOperatorToUserId(client, orgId, operator) {
  if (!operator) return null;
  const ssoSubject = `legacy:${operator}`;
  const existing = await client.query('SELECT id FROM "User" WHERE "ssoSubject" = $1', [ssoSubject]);
  if (existing.rows.length > 0) return existing.rows[0].id;
  const id = globalThis.crypto.randomUUID();
  await client.query(
    'INSERT INTO "User" (id, "organizationId", email, "displayName", "ssoSubject") VALUES ($1,$2,$3,$4,$5)',
    [id, orgId, `${operator}@legacy.invalid`, operator, ssoSubject],
  );
  return id;
}

async function tableHasRowsForProject(client, table, projectId) {
  const r = await client.query(`SELECT 1 FROM "${table}" WHERE "projectId" = $1 LIMIT 1`, [projectId]);
  return r.rows.length > 0;
}

/**
 * Writes one tenant's already-shaped rows into Postgres. `client` only needs a `.query(text,
 * params)` method returning `{ rows }` - satisfied by both a real `pg.Client`/`pg.Pool` and by
 * @electric-sql/pglite's own query method, which is exactly how verify-migration.mjs exercises
 * this function against real Postgres semantics without a live database server.
 */
export async function writeTenantRows(client, rows) {
  const { org, project, workflow, traceability, healing, flaky, quarantine, cost } = rows;
  const summary = {};

  await client.query(
    'INSERT INTO "Organization" (id, name, "legacyTenantId") VALUES ($1,$2,$3) ON CONFLICT ("legacyTenantId") DO NOTHING',
    [org.id, org.name, org.legacyTenantId],
  );
  const orgRow = await client.query('SELECT id FROM "Organization" WHERE "legacyTenantId" = $1', [org.legacyTenantId]);
  const orgId = orgRow.rows[0].id;

  await client.query(
    'INSERT INTO "Project" (id, "organizationId", "teamId", name, "jiraProjectKey") VALUES ($1,$2,$3,$4,$5) ON CONFLICT ("organizationId", name) DO NOTHING',
    [project.id, orgId, project.teamId, project.name, project.jiraProjectKey],
  );
  const projRow = await client.query('SELECT id FROM "Project" WHERE "organizationId" = $1 AND name = $2', [orgId, project.name]);
  const projectId = projRow.rows[0].id;

  for (const w of workflow) {
    const requirementsClearedByUserId = await resolveOperatorToUserId(client, orgId, w.requirementsClearedByOperator);
    const scenariosApprovedByUserId = await resolveOperatorToUserId(client, orgId, w.scenariosApprovedByOperator);
    const testCasesApprovedByUserId = await resolveOperatorToUserId(client, orgId, w.testCasesApprovedByOperator);
    await client.query(
      `INSERT INTO "WorkflowRecord"
        (id, "projectId", "jiraKey", "requirementGapsCheckedAt", "requirementGaps",
         "requirementsClearedAt", "requirementsClearedByUserId",
         "scenariosApprovedAt", "scenariosApprovedByUserId",
         "testCasesApprovedAt", "testCasesApprovedByUserId")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT ("projectId", "jiraKey") DO NOTHING`,
      [
        w.id, projectId, w.jiraKey, w.requirementGapsCheckedAt, JSON.stringify(w.requirementGaps),
        w.requirementsClearedAt, requirementsClearedByUserId,
        w.scenariosApprovedAt, scenariosApprovedByUserId,
        w.testCasesApprovedAt, testCasesApprovedByUserId,
      ],
    );
  }
  summary.workflow = workflow.length;

  for (const t of traceability) {
    await client.query(
      `INSERT INTO "TraceabilityEntry"
        (id, "projectId", "jiraKey", "externalCaseId", "externalCaseHash", "externalCaseUpdatedAt",
         "tmsProvider", "testFilePath", "testTitle", "testContentHash", "testLastModified",
         "syncState", "lastCheckedAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT ("projectId", "jiraKey", "externalCaseId", "testFilePath", "testTitle") DO NOTHING`,
      [
        t.id, projectId, t.jiraKey, t.externalCaseId, t.externalCaseHash, t.externalCaseUpdatedAt,
        t.tmsProvider, t.testFilePath, t.testTitle, t.testContentHash, t.testLastModified,
        t.syncState, t.lastCheckedAt,
      ],
    );
  }
  summary.traceability = traceability.length;

  if (healing.length > 0 && !(await tableHasRowsForProject(client, 'HealingEvent', projectId))) {
    for (const h of healing) {
      await client.query(
        `INSERT INTO "HealingEvent"
          (id, "projectId", "timestamp", "jiraKey", "externalCaseId", "testFilePath", "testTitle",
           suite, "attemptNumber", outcome, category, "durationMs")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [h.id, projectId, h.timestamp, h.jiraKey, h.externalCaseId, h.testFilePath, h.testTitle,
         h.suite, h.attemptNumber, h.outcome, h.category, h.durationMs],
      );
    }
    summary.healing = healing.length;
  } else {
    summary.healing = healing.length > 0 ? 'skipped (project already has healing events)' : 0;
  }

  if (flaky.length > 0 && !(await tableHasRowsForProject(client, 'FlakyEvent', projectId))) {
    for (const f of flaky) {
      await client.query(
        `INSERT INTO "FlakyEvent"
          (id, "projectId", "timestamp", "jiraKey", "externalCaseId", "testFilePath", "testTitle",
           suite, evidence, action)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [f.id, projectId, f.timestamp, f.jiraKey, f.externalCaseId, f.testFilePath, f.testTitle,
         f.suite, JSON.stringify(f.evidence), f.action],
      );
    }
    summary.flaky = flaky.length;
  } else {
    summary.flaky = flaky.length > 0 ? 'skipped (project already has flaky events)' : 0;
  }

  for (const q of quarantine) {
    await client.query(
      `INSERT INTO "QuarantineEntry"
        (id, "projectId", "testFilePath", "testTitle", "jiraKey", "externalCaseId", suite,
         "quarantinedAt", evidence)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT ("projectId", "testFilePath", "testTitle") DO NOTHING`,
      [q.id, projectId, q.testFilePath, q.testTitle, q.jiraKey, q.externalCaseId, q.suite,
       q.quarantinedAt, JSON.stringify(q.evidence)],
    );
  }
  summary.quarantine = quarantine.length;

  if (cost.length > 0 && !(await tableHasRowsForProject(client, 'CostEvent', projectId))) {
    for (const c of cost) {
      await client.query(
        `INSERT INTO "CostEvent"
          (id, "projectId", "timestamp", agent, model, "inputTokens", "outputTokens",
           "cacheReadTokens", "cacheCreationTokens", "costUsd", "wallClockMs", "jiraKey")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [c.id, projectId, c.timestamp, c.agent, c.model, c.inputTokens, c.outputTokens,
         c.cacheReadTokens, c.cacheCreationTokens, c.costUsd, c.wallClockMs, c.jiraKey],
      );
    }
    summary.cost = cost.length;
  } else {
    summary.cost = cost.length > 0 ? 'skipped (project already has cost events)' : 0;
  }

  return { orgId, projectId, summary };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const tenantId = args['tenant-id'];
  const orgName = args['org-name'] ?? tenantId;
  const dataDir = args['data-dir'];
  const projectName = args['project-name'] ?? 'Main';
  if (!tenantId || !dataDir) {
    console.error('Usage: node migrate-tenant.mjs --tenant-id <id> --data-dir <path> [--org-name <name>] [--project-name <name>]');
    process.exit(1);
  }

  console.log(`Connecting to database (DATABASE_URL host/db from env)...`);
  const { Client } = await import('pg');
  const client = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10_000 });
  await client.connect();
  console.log('Connected. Loading tenant data from disk...');
  try {
    const rows = await loadTenantRows(dataDir, tenantId, orgName, projectName);
    console.log('Loaded row counts:', {
      workflow: rows.workflow.length,
      traceability: rows.traceability.length,
      healing: rows.healing.length,
      flaky: rows.flaky.length,
      quarantine: rows.quarantine.length,
      cost: rows.cost.length,
    });
    const result = await writeTenantRows(client, rows);
    console.log('Migration complete:', JSON.stringify(result, null, 2));
  } finally {
    await client.end();
  }
}

// Only run main() when executed directly (not when imported by verify-migration.mjs).
// Compares resolved file:// URLs (via pathToFileURL) rather than string-templating
// `file://${process.argv[1]}` directly - the latter never matches on Windows, since
// process.argv[1] uses backslashes ("C:\Users\...") while import.meta.url always uses forward
// slashes with a drive-letter leading slash ("file:///C:/Users/..."). That mismatch made main()
// silently never run on Windows - the script loaded, did nothing, and exited with no output and
// no error, which is exactly the "nothing is displaying" symptom this fixes.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error('Migration failed:', e);
    process.exit(1);
  });
}
