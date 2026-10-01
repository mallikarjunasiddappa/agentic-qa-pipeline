/**
 * Real Prisma-Client-backed data access for AuditLogEntry. Same factory-wrapped shape as
 * workflowRepository.mjs, for the same reason (testability without a live database).
 *
 * Interface: { create(entry), listRecent(organizationId, limit) }
 */
export function createAuditLogRepository(prisma) {
  return {
    async create(entry) {
      return prisma.auditLogEntry.create({ data: entry });
    },

    async listRecent(organizationId, limit = 50) {
      return prisma.auditLogEntry.findMany({
        where: { organizationId },
        orderBy: { timestamp: 'desc' },
        take: limit,
        include: { user: true },
      });
    },
  };
}
