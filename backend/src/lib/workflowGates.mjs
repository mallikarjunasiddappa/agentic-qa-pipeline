/**
 * Pure functions for WorkflowRecord's three approval gates. No IO here on purpose, same reasoning
 * as scripts/lib/buildMigrationRows.mjs: keeping validation/shaping logic IO-free means it can be
 * unit-tested directly (see src/app.test.mjs) without a database or a generated Prisma Client,
 * which matters in the build sandbox where Prisma Client can't be generated at all (see
 * README.md's "Known limitation" section).
 */

/**
 * One entry per WorkflowRecord gate field pair in schema.prisma. `routeSegment` is what app.mjs
 * appends after `/workflow/:jiraKey/` to build each gate's POST route - kept here, not duplicated
 * in app.mjs, so the gate list has exactly one source of truth.
 */
export const GATE_DEFINITIONS = {
  requirements: {
    clearedAtField: 'requirementsClearedAt',
    clearedByField: 'requirementsClearedByUserId',
    action: 'requirements_cleared',
    routeSegment: 'requirements/clear',
  },
  scenarios: {
    clearedAtField: 'scenariosApprovedAt',
    clearedByField: 'scenariosApprovedByUserId',
    action: 'scenarios_approved',
    routeSegment: 'scenarios/approve',
  },
  testCases: {
    clearedAtField: 'testCasesApprovedAt',
    clearedByField: 'testCasesApprovedByUserId',
    action: 'test_cases_approved',
    routeSegment: 'test-cases/approve',
  },
};

export function validateGateActionRequest(body) {
  const errors = [];
  if (!body || typeof body !== 'object') {
    errors.push('Request body must be a JSON object.');
    return { valid: false, errors };
  }
  if (!body.userId || typeof body.userId !== 'string') {
    errors.push('userId is required and must be a string.');
  }
  return { valid: errors.length === 0, errors };
}

/** Prisma update-data shape for the given gate's *At/*ByUserId field pair. */
export function buildGatePatch(gateKey, userId, now = new Date()) {
  const gate = GATE_DEFINITIONS[gateKey];
  if (!gate) throw new Error(`Unknown gate: ${gateKey}`);
  return {
    [gate.clearedAtField]: now,
    [gate.clearedByField]: userId,
  };
}

/**
 * Prisma create-data shape for AuditLogEntry - the roadmap's explicit "approval-gate actions tie
 * to a real authenticated human... with an audit trail" deliverable. userId here is trusted from
 * the request today (see app.mjs's getCurrentUserId - a stand-in until Azure AD B2C SSO is wired
 * up per the ADR's remaining action items); once SSO lands, this function doesn't change, only
 * where userId comes from does.
 */
export function buildAuditLogEntryForGate({ organizationId, userId, jiraKey, workflowRecordId, gateKey }) {
  const gate = GATE_DEFINITIONS[gateKey];
  if (!gate) throw new Error(`Unknown gate: ${gateKey}`);
  return {
    organizationId,
    userId,
    action: gate.action,
    entityType: 'WorkflowRecord',
    entityId: workflowRecordId,
    metadata: { jiraKey },
  };
}
