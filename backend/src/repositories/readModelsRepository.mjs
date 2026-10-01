/**
 * Real Prisma-Client-backed read access for the five project-scoped tables migrated by
 * scripts/migrate-tenant.mjs: TraceabilityEntry, HealingEvent, FlakyEvent, QuarantineEntry,
 * CostEvent. Same factory-wrapped shape as workflowRepository.mjs/auditLogRepository.mjs, for the
 * same reason (testable route logic without a live database).
 *
 * All five tables are scoped by projectId alone (none has an organizationId column - see
 * schema.prisma) - that's why these routes are nested under /api/projects/:projectId/... in
 * app.mjs rather than under /api/organizations/:organizationId/..., unlike the workflow/audit-log
 * routes. See README.md's API layer section for that inconsistency called out explicitly.
 */
export function createReadModelsRepository(prisma) {
  return {
    async listTraceability(projectId, limit = 100) {
      return prisma.traceabilityEntry.findMany({
        where: { projectId },
        orderBy: { lastCheckedAt: 'desc' },
        take: limit,
      });
    },

    async listHealing(projectId, limit = 100) {
      return prisma.healingEvent.findMany({
        where: { projectId },
        orderBy: { timestamp: 'desc' },
        take: limit,
      });
    },

    async listFlaky(projectId, limit = 100) {
      return prisma.flakyEvent.findMany({
        where: { projectId },
        orderBy: { timestamp: 'desc' },
        take: limit,
      });
    },

    async listQuarantine(projectId) {
      // Current state, not history (that's FlakyEvent above) - same split as the flat
      // flaky/quarantine.json vs. flaky/telemetry.jsonl files this table replaced. No natural
      // ordering beyond "everything currently quarantined," so no orderBy/limit here.
      return prisma.quarantineEntry.findMany({ where: { projectId } });
    },

    async listCost(projectId, limit = 200) {
      return prisma.costEvent.findMany({
        where: { projectId },
        orderBy: { timestamp: 'desc' },
        take: limit,
      });
    },
  };
}
