/**
 * Pure functions that turn the existing data/<tenantId>/*.json(l) shapes into row objects matching
 * backend/prisma/schema.prisma's tables. No IO here on purpose - migrate-tenant.mjs does the disk
 * reads and DB writes; this module only shapes data, so it can be unit-verified against real
 * tenant data without a database at all.
 *
 * Every builder takes the already-parsed JSON/JSONL content plus a projectId (and orgId for the
 * two builders that need it) and returns an array of plain objects whose keys line up 1:1 with the
 * SQL column list migrate-tenant.mjs uses for each table - see that file's INSERT statements.
 */

export function buildOrganizationRow(tenantId, orgName) {
  return { id: cryptoRandomId(), name: orgName, legacyTenantId: tenantId };
}

export function buildDefaultProjectRow(orgId, projectName) {
  return { id: cryptoRandomId(), organizationId: orgId, teamId: null, name: projectName, jiraProjectKey: null };
}

/**
 * WorkflowRecordSchema (schemas.ts) -> WorkflowRecord rows. Old *ClearedBy/*ApprovedBy fields (when
 * present - real tenant data captured so far has none) are free-text operator strings; there's no
 * real User row for those yet, so a legacy placeholder User is looked up by a deterministic
 * ssoSubject (`legacy:<operator string>`) rather than inventing an org-less orphan reference. The
 * caller (migrate-tenant.mjs) resolves those to real userIds after this function returns a list of
 * { ...row, requirementsClearedByOperator, scenariosApprovedByOperator, testCasesApprovedByOperator }
 * so the DB write can upsert the placeholder Users first.
 */
export function buildWorkflowRows(manifest, projectId) {
  const workflow = manifest.workflow ?? [];
  return workflow.map((w) => ({
    id: cryptoRandomId(),
    projectId,
    jiraKey: w.jiraKey,
    requirementGapsCheckedAt: w.requirementGapsCheckedAt ?? null,
    requirementGaps: w.requirementGaps ?? null,
    requirementsClearedAt: w.requirementsClearedAt ?? null,
    requirementsClearedByOperator: w.requirementsClearedBy ?? null,
    scenariosApprovedAt: w.scenariosApprovedAt ?? null,
    scenariosApprovedByOperator: w.scenariosApprovedBy ?? null,
    testCasesApprovedAt: w.testCasesApprovedAt ?? null,
    testCasesApprovedByOperator: w.testCasesApprovedBy ?? null,
  }));
}

/** TraceabilityEntrySchema -> TraceabilityEntry rows. manifest.entries is the source array. */
export function buildTraceabilityRows(manifest, projectId) {
  const entries = manifest.entries ?? [];
  return entries.map((e) => ({
    id: cryptoRandomId(),
    projectId,
    jiraKey: e.jiraKey,
    externalCaseId: e.externalCaseId,
    externalCaseHash: e.externalCaseHash,
    externalCaseUpdatedAt: e.externalCaseUpdatedAt,
    tmsProvider: e.tmsProvider,
    testFilePath: e.testFilePath,
    testTitle: e.testTitle ?? null,
    testContentHash: e.testContentHash,
    testLastModified: e.testLastModified,
    syncState: e.syncState,
    lastCheckedAt: e.lastCheckedAt,
  }));
}

/** HealingEventSchema -> HealingEvent rows. Input is the raw healing/telemetry.jsonl text. */
export function buildHealingRows(jsonlText, projectId) {
  return parseJsonl(jsonlText).map((h) => ({
    id: cryptoRandomId(),
    projectId,
    timestamp: h.timestamp,
    jiraKey: h.jiraKey ?? null,
    externalCaseId: h.externalCaseId ?? null,
    testFilePath: h.testFilePath,
    testTitle: h.testTitle ?? null,
    suite: h.suite,
    attemptNumber: h.attemptNumber,
    outcome: h.outcome,
    category: h.category ?? null,
    durationMs: h.durationMs ?? null,
  }));
}

/** FlakyEventSchema -> FlakyEvent rows. Input is the raw flaky/telemetry.jsonl text. */
export function buildFlakyRows(jsonlText, projectId) {
  return parseJsonl(jsonlText).map((f) => ({
    id: cryptoRandomId(),
    projectId,
    timestamp: f.timestamp,
    jiraKey: f.jiraKey ?? null,
    externalCaseId: f.externalCaseId ?? null,
    testFilePath: f.testFilePath,
    testTitle: f.testTitle ?? null,
    suite: f.suite,
    evidence: f.evidence,
    action: f.action,
  }));
}

/** QuarantineEntrySchema -> QuarantineEntry rows. Input is the parsed flaky/quarantine.json array. */
export function buildQuarantineRows(quarantineArray, projectId) {
  return (quarantineArray ?? []).map((q) => ({
    id: cryptoRandomId(),
    projectId,
    testFilePath: q.testFilePath,
    testTitle: q.testTitle ?? null,
    jiraKey: q.jiraKey ?? null,
    externalCaseId: q.externalCaseId ?? null,
    suite: q.suite,
    quarantinedAt: q.quarantinedAt,
    evidence: q.evidence,
  }));
}

/** CostEventSchema -> CostEvent rows. Input is the raw cost/telemetry.jsonl text. */
export function buildCostRows(jsonlText, projectId) {
  return parseJsonl(jsonlText).map((c) => ({
    id: cryptoRandomId(),
    projectId,
    timestamp: c.timestamp,
    agent: c.agent,
    model: c.model,
    inputTokens: c.inputTokens,
    outputTokens: c.outputTokens,
    cacheReadTokens: c.cacheReadTokens,
    cacheCreationTokens: c.cacheCreationTokens,
    costUsd: c.costUsd,
    wallClockMs: c.wallClockMs,
    jiraKey: c.jiraKey ?? null,
  }));
}

function parseJsonl(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

// crypto.randomUUID is available in Node 14.17+/16+ without an import.
function cryptoRandomId() {
  return globalThis.crypto.randomUUID();
}
