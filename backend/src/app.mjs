import express from 'express';
import {
  GATE_DEFINITIONS,
  validateGateActionRequest,
  buildGatePatch,
  buildAuditLogEntryForGate,
} from './lib/workflowGates.mjs';
import {
  validateCreateQueueItemRequest,
  buildQueueItemCreateData,
  validateResolveQueueItemRequest,
  buildResolvePatch,
  buildAuditLogEntryForQueueResolve,
  validateFileJiraBugRequest,
  mergeFiledBugIntoPayload,
  validateFileJiraStoryRequest,
  mergeFiledStoryIntoPayload,
} from './lib/queueItems.mjs';
import { buildQueueDashboardHtml } from './views/queueDashboard.mjs';

/**
 * Stand-in for real authentication until Azure AD B2C SSO is wired up (see the ADR's remaining
 * action items - this is deliberately NOT done yet). Trusts a userId supplied by the caller
 * (request body or an X-User-Id header) instead of extracting it from a verified token. This is
 * the one piece of this API that is explicitly NOT production-safe as written - every write route
 * that calls this is naming that fact in a comment at the call site, not hiding it.
 */
function getCurrentUserId(req) {
  return req.body?.userId ?? req.headers['x-user-id'] ?? null;
}

/**
 * Builds the Express app from injected repositories rather than importing Prisma Client directly,
 * so routes can be exercised in tests (src/app.test.mjs) against fake in-memory repositories -
 * real HTTP requests, real Express routing/status codes/JSON bodies, no database or generated
 * Prisma Client required. server.mjs is what wires the real Prisma-Client-backed repositories in
 * for production use.
 */
export function createApp({ workflowRepository, auditLogRepository, readModelsRepository, queueRepository, jiraClient = null }) {
  const app = express();
  app.use(express.json());

  app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  app.get('/api/organizations/:organizationId/projects/:projectId/workflow/:jiraKey', async (req, res, next) => {
    try {
      const { projectId, jiraKey } = req.params;
      const record = await workflowRepository.findByProjectAndJiraKey(projectId, jiraKey);
      if (!record) return res.status(404).json({ error: 'WorkflowRecord not found' });
      res.json(record);
    } catch (e) {
      next(e);
    }
  });

  // One POST route per WorkflowRecord gate (requirements/clear, scenarios/approve,
  // test-cases/approve) - registered from GATE_DEFINITIONS so the route list and the gate list
  // can't drift apart. Route bodies are identical apart from which gate they apply; see
  // workflowGates.mjs for the gate-specific field/action mapping.
  for (const [gateKey, gate] of Object.entries(GATE_DEFINITIONS)) {
    app.post(
      `/api/organizations/:organizationId/projects/:projectId/workflow/:jiraKey/${gate.routeSegment}`,
      async (req, res, next) => {
        try {
          const { organizationId, projectId, jiraKey } = req.params;
          // TODO(SSO): userId is trusted from the request, not a verified token - see
          // getCurrentUserId's comment above. Real identity wiring replaces this line only;
          // nothing downstream of it changes shape.
          const userId = getCurrentUserId(req);
          const { valid, errors } = validateGateActionRequest({ userId });
          if (!valid) return res.status(400).json({ errors });

          const patch = buildGatePatch(gateKey, userId);
          const updated = await workflowRepository.applyGate(projectId, jiraKey, patch);
          if (!updated) return res.status(404).json({ error: 'WorkflowRecord not found' });

          await auditLogRepository.create(
            buildAuditLogEntryForGate({
              organizationId,
              userId,
              jiraKey,
              workflowRecordId: updated.id,
              gateKey,
            }),
          );

          res.json(updated);
        } catch (e) {
          next(e);
        }
      },
    );
  }

  app.get('/api/organizations/:organizationId/audit-log', async (req, res, next) => {
    try {
      const { organizationId } = req.params;
      const limit = req.query.limit ? Number(req.query.limit) : undefined;
      const entries = await auditLogRepository.listRecent(organizationId, limit);
      res.json(entries);
    } catch (e) {
      next(e);
    }
  });

  // Read-only endpoints over the five tables scripts/migrate-tenant.mjs populates. All five are
  // scoped by projectId alone in the schema (no organizationId column), so these routes are
  // nested under /api/projects/:projectId/... rather than under .../organizations/:organizationId
  // /... like the routes above - a deliberate, documented inconsistency (see README.md).
  const READ_ROUTES = [
    ['traceability', (repo, projectId, limit) => repo.listTraceability(projectId, limit)],
    ['healing', (repo, projectId, limit) => repo.listHealing(projectId, limit)],
    ['flaky', (repo, projectId, limit) => repo.listFlaky(projectId, limit)],
    ['quarantine', (repo, projectId) => repo.listQuarantine(projectId)],
    ['cost', (repo, projectId, limit) => repo.listCost(projectId, limit)],
  ];
  for (const [segment, list] of READ_ROUTES) {
    app.get(`/api/projects/:projectId/${segment}`, async (req, res, next) => {
      try {
        const { projectId } = req.params;
        const limit = req.query.limit ? Number(req.query.limit) : undefined;
        const rows = await list(readModelsRepository, projectId, limit);
        res.json(rows);
      } catch (e) {
        next(e);
      }
    });
  }

  // --- AI Queue (Phase A of "AI-Assisted Scrum and SDLC Console - Development Plan") ---
  //
  // Create/list are scoped by projectId alone, same convention as the five read-only resources
  // above - an AI/pipeline stage proposing something isn't a human action, so there's nothing to
  // tie to an organization-scoped audited human yet. Resolve is nested under
  // /api/organizations/:organizationId/... instead, matching the WorkflowRecord gate routes above,
  // because resolving a queue item IS the governance-relevant human action this table exists to
  // capture, and it needs organizationId to write a real AuditLogEntry.

  app.post('/api/projects/:projectId/queue', async (req, res, next) => {
    try {
      const { projectId } = req.params;
      const { valid, errors } = validateCreateQueueItemRequest(req.body);
      if (!valid) return res.status(400).json({ errors });

      const created = await queueRepository.create(projectId, buildQueueItemCreateData(projectId, req.body));
      res.status(201).json(created);
    } catch (e) {
      next(e);
    }
  });

  app.get('/api/projects/:projectId/queue', async (req, res, next) => {
    try {
      const { projectId } = req.params;
      const { state, type } = req.query;
      const limit = req.query.limit ? Number(req.query.limit) : undefined;
      const items = await queueRepository.listByProject(projectId, { state, type, limit });
      res.json(items);
    } catch (e) {
      next(e);
    }
  });

  app.post(
    '/api/organizations/:organizationId/projects/:projectId/queue/:queueItemId/resolve',
    async (req, res, next) => {
      try {
        const { organizationId, queueItemId } = req.params;
        // TODO(SSO): userId is trusted from the request, not a verified token - same stand-in as
        // the WorkflowRecord gate routes above; see getCurrentUserId's comment.
        const userId = getCurrentUserId(req);
        const { valid, errors } = validateResolveQueueItemRequest({ ...req.body, userId });
        if (!valid) return res.status(400).json({ errors });

        const { actionTaken, state, fileJiraBug, bugReport, fileJiraStory, storyDraft } = req.body;

        // Filing a real Jira bug OR story is always an explicit, separate human choice
        // (fileJiraBug: true / fileJiraStory: true) - a plain resolve (approve/reject/dismiss, the
        // default) never files anything, so approving a queue item and actually creating the Jira
        // issue are two distinct, auditable actions, not one implied by the other. The two are
        // mutually exclusive in practice (a QueueItem's sourceStage is either "defects" or
        // "stories", never both - validateFileJiraBugRequest/validateFileJiraStoryRequest each
        // enforce their own sourceStage), so this does not need to guard against both being set.
        let jiraIssueKey;
        let jiraIssueUrl;
        let payloadPatch;
        if (fileJiraBug) {
          const queueItem = await queueRepository.findById(queueItemId);
          if (!queueItem) return res.status(404).json({ error: 'QueueItem not found' });

          const bugValidation = validateFileJiraBugRequest(req.body, queueItem);
          if (!bugValidation.valid) return res.status(400).json({ errors: bugValidation.errors });

          if (!jiraClient) {
            return res.status(503).json({
              error:
                'Jira is not configured for this backend (JIRA_BASE_URL/JIRA_EMAIL/JIRA_API_TOKEN/' +
                'JIRA_PROJECT_KEY) - cannot file a real bug. See backend/README.md\'s "AI Queue" section.',
            });
          }

          let filedBug;
          try {
            filedBug = await jiraClient.createBug(bugReport ?? queueItem.payload.draftBugReport);
          } catch (jiraError) {
            // eslint-disable-next-line no-console
            console.error('Jira createBug failed:', jiraError);
            return res.status(502).json({
              error: 'Failed to file the Jira bug - the queue item was NOT resolved and remains PENDING for retry.',
            });
          }
          jiraIssueKey = filedBug.key;
          jiraIssueUrl = filedBug.url;
          payloadPatch = mergeFiledBugIntoPayload(queueItem.payload, filedBug);
        } else if (fileJiraStory) {
          const queueItem = await queueRepository.findById(queueItemId);
          if (!queueItem) return res.status(404).json({ error: 'QueueItem not found' });

          const storyValidation = validateFileJiraStoryRequest(req.body, queueItem);
          if (!storyValidation.valid) return res.status(400).json({ errors: storyValidation.errors });

          if (!jiraClient) {
            return res.status(503).json({
              error:
                'Jira is not configured for this backend (JIRA_BASE_URL/JIRA_EMAIL/JIRA_API_TOKEN/' +
                'JIRA_PROJECT_KEY) - cannot file a real story. See backend/README.md\'s "AI Queue" section.',
            });
          }

          let filedStory;
          try {
            filedStory = await jiraClient.createStory(storyDraft ?? queueItem.payload);
          } catch (jiraError) {
            // eslint-disable-next-line no-console
            console.error('Jira createStory failed:', jiraError);
            return res.status(502).json({
              error: 'Failed to file the Jira story - the queue item was NOT resolved and remains PENDING for retry.',
            });
          }
          jiraIssueKey = filedStory.key;
          jiraIssueUrl = filedStory.url;
          payloadPatch = mergeFiledStoryIntoPayload(queueItem.payload, filedStory);
        }

        const patch = buildResolvePatch(userId, actionTaken, state);
        if (payloadPatch) patch.payload = payloadPatch;
        const updated = await queueRepository.resolve(queueItemId, patch);
        if (!updated) return res.status(404).json({ error: 'QueueItem not found' });

        await auditLogRepository.create(
          buildAuditLogEntryForQueueResolve({
            organizationId,
            userId,
            queueItemId,
            sourceStage: updated.sourceStage,
            actionTaken,
            jiraIssueKey,
            jiraIssueUrl,
          }),
        );

        res.json(updated);
      } catch (e) {
        next(e);
      }
    },
  );

  // Dashboard's single "AI queue - needs your review" view (Phase A/B of the dev plan, source
  // deck's slide 8 UI spec) - a self-contained HTML page (no build step, no framework) that reads
  // PENDING items via the same queueRepository the JSON routes above use, and drives the same
  // create/resolve API from inline JS. organizationId is a query param (not part of the queue's
  // own project-scoped path above) purely because the resolve route below needs it - the dashboard
  // has no other source for it.
  app.get('/api/projects/:projectId/queue/dashboard', async (req, res, next) => {
    try {
      const { projectId } = req.params;
      const { organizationId } = req.query;
      if (!organizationId) return res.status(400).json({ error: 'organizationId query param is required.' });

      const items = await queueRepository.listByProject(projectId, { state: 'PENDING' });
      res.set('Content-Type', 'text/html').send(buildQueueDashboardHtml(items, { projectId, organizationId }));
    } catch (e) {
      next(e);
    }
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
