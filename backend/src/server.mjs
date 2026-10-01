#!/usr/bin/env node
/**
 * Real production entrypoint - wires the real Prisma-Client-backed repositories into createApp()
 * and listens on PORT. Can't be run in the build sandbox (needs a generated Prisma Client, which
 * needs `prisma generate` to have run for real - see README.md's "Known limitation" section), so
 * this file is verified by you, once, the same way migrate-tenant.mjs's real-Postgres path was:
 * run it and hit the routes with curl. app.mjs's route logic itself is already unit-tested against
 * a fake repository in src/app.test.mjs, which _does_ run in the sandbox.
 */
import { PrismaClient } from '@prisma/client';
import { createApp } from './app.mjs';
import { createWorkflowRepository } from './repositories/workflowRepository.mjs';
import { createAuditLogRepository } from './repositories/auditLogRepository.mjs';
import { createReadModelsRepository } from './repositories/readModelsRepository.mjs';
import { createQueueRepository } from './repositories/queueRepository.mjs';
import { createJiraClient, loadJiraConfigFromEnv } from './lib/jiraClient.mjs';

const prisma = new PrismaClient();
const jiraConfig = loadJiraConfigFromEnv();
if (!jiraConfig) {
  console.warn(
    'Jira is not configured (JIRA_BASE_URL/JIRA_EMAIL/JIRA_API_TOKEN/JIRA_PROJECT_KEY not all set) - ' +
      'the AI Queue resolve route\'s fileJiraBug option will return 503 until these are set. See ' +
      'backend/.env.example and backend/README.md\'s "AI Queue" section.',
  );
}
const app = createApp({
  workflowRepository: createWorkflowRepository(prisma),
  auditLogRepository: createAuditLogRepository(prisma),
  readModelsRepository: createReadModelsRepository(prisma),
  queueRepository: createQueueRepository(prisma),
  jiraClient: jiraConfig ? createJiraClient(jiraConfig) : null,
});

const port = process.env.PORT ?? 4000;
app.listen(port, () => {
  console.log(`Backend API listening on http://localhost:${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
}
