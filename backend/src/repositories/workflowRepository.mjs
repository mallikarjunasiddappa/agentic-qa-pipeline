/**
 * Real Prisma-Client-backed data access for WorkflowRecord. Wrapped in a factory (rather than
 * calling `prisma.workflowRecord.*` directly from route handlers) so app.mjs's routes can be
 * exercised in tests against a fake in-memory implementation of this same interface, without a
 * database or a generated Prisma Client - see src/app.test.mjs and README.md's "API layer"
 * section for why that split matters in this project's build sandbox.
 *
 * Interface: { findByProjectAndJiraKey(projectId, jiraKey), applyGate(projectId, jiraKey, patch) }
 */

const GATE_USER_INCLUDES = {
  requirementsClearedByUser: true,
  scenariosApprovedByUser: true,
  testCasesApprovedByUser: true,
};

export function createWorkflowRepository(prisma) {
  return {
    async findByProjectAndJiraKey(projectId, jiraKey) {
      return prisma.workflowRecord.findUnique({
        where: { projectId_jiraKey: { projectId, jiraKey } },
        include: GATE_USER_INCLUDES,
      });
    },

    /** patch is one of buildGatePatch()'s outputs - any gate's *At/*ByUserId field pair. */
    async applyGate(projectId, jiraKey, patch) {
      const existing = await prisma.workflowRecord.findUnique({
        where: { projectId_jiraKey: { projectId, jiraKey } },
      });
      if (!existing) return null;
      return prisma.workflowRecord.update({
        where: { projectId_jiraKey: { projectId, jiraKey } },
        data: patch,
        include: GATE_USER_INCLUDES,
      });
    },
  };
}
