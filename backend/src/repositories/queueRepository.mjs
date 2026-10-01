/**
 * Real Prisma-Client-backed data access for QueueItem (Phase A of "AI-Assisted Scrum and SDLC
 * Console - Development Plan"). Same factory-wrapped shape as workflowRepository.mjs/
 * auditLogRepository.mjs/readModelsRepository.mjs, for the same reason (testable route logic
 * without a live database - see src/app.test.mjs).
 *
 * Interface: { create(projectId, data), listByProject(projectId, { state, type, limit }),
 * findById(queueItemId), resolve(queueItemId, patch) }
 */

const RESOLVED_BY_INCLUDE = { resolvedByUser: true };

export function createQueueRepository(prisma) {
  return {
    async create(projectId, data) {
      return prisma.queueItem.create({ data: { ...data, projectId } });
    },

    async listByProject(projectId, { state, type, limit = 100 } = {}) {
      return prisma.queueItem.findMany({
        where: {
          projectId,
          ...(state ? { state } : {}),
          ...(type ? { type } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        include: RESOLVED_BY_INCLUDE,
      });
    },

    async findById(queueItemId) {
      return prisma.queueItem.findUnique({
        where: { id: queueItemId },
        include: RESOLVED_BY_INCLUDE,
      });
    },

    /** patch is buildResolvePatch()'s output. Returns null if the item doesn't exist. */
    async resolve(queueItemId, patch) {
      const existing = await prisma.queueItem.findUnique({ where: { id: queueItemId } });
      if (!existing) return null;
      return prisma.queueItem.update({
        where: { id: queueItemId },
        data: patch,
        include: RESOLVED_BY_INCLUDE,
      });
    },
  };
}
