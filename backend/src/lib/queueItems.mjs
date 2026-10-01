/**
 * Pure functions for the AI Queue (Phase A of "AI-Assisted Scrum and SDLC Console - Development
 * Plan", docs/planning/). No IO here on purpose, same reasoning as workflowGates.mjs: keeping
 * validation/shaping logic IO-free means it can be unit-tested directly (see app.test.mjs) without
 * a database or a generated Prisma Client, which matters in the build sandbox where Prisma Client
 * can't be generated at all (see README.md's "Known limitation" section).
 *
 * Two distinct write paths, deliberately not symmetric:
 *  - create: an AI/pipeline stage proposing something. No human identity involved yet, so no audit
 *    log entry - the audit trail's job (per the ADR) is to record human decisions, and nothing
 *    human has happened at create time.
 *  - resolve: a real human approving/editing/rejecting/dismissing the proposal. This is the actual
 *    governance-relevant action, so it writes an AuditLogEntry, following the exact same
 *    applyGate-style shape workflowGates.mjs uses for WorkflowRecord's three gates.
 */

/** Mirrors the QueueItemType enum in schema.prisma - source deck slide 7 / dev plan Section 3. */
export const QUEUE_ITEM_TYPES = ['SUGGESTED', 'ESCALATED', 'NEEDS_SESSION'];

/** Mirrors the QueueItemState enum in schema.prisma. */
export const QUEUE_ITEM_STATES = ['PENDING', 'RESOLVED', 'DISMISSED'];

export function validateCreateQueueItemRequest(body) {
  const errors = [];
  if (!body || typeof body !== 'object') {
    errors.push('Request body must be a JSON object.');
    return { valid: false, errors };
  }
  if (!QUEUE_ITEM_TYPES.includes(body.type)) {
    errors.push(`type is required and must be one of: ${QUEUE_ITEM_TYPES.join(', ')}.`);
  }
  if (!body.sourceStage || typeof body.sourceStage !== 'string') {
    errors.push('sourceStage is required and must be a string.');
  }
  if (body.payload === undefined || body.payload === null || typeof body.payload !== 'object') {
    errors.push('payload is required and must be a JSON object.');
  }
  return { valid: errors.length === 0, errors };
}

/** Prisma create-data shape for a new QueueItem, scoped to the project from the route params. */
export function buildQueueItemCreateData(projectId, body) {
  return {
    projectId,
    type: body.type,
    sourceStage: body.sourceStage,
    payload: body.payload,
  };
}

export function validateResolveQueueItemRequest(body) {
  const errors = [];
  if (!body || typeof body !== 'object') {
    errors.push('Request body must be a JSON object.');
    return { valid: false, errors };
  }
  if (!body.userId || typeof body.userId !== 'string') {
    errors.push('userId is required and must be a string.');
  }
  if (!body.actionTaken || typeof body.actionTaken !== 'string') {
    errors.push('actionTaken is required and must be a string (e.g. "approved_as_is", "edited_and_approved", "rejected", "dismissed").');
  }
  if (body.state !== undefined && !QUEUE_ITEM_STATES.includes(body.state)) {
    errors.push(`state, if provided, must be one of: ${QUEUE_ITEM_STATES.join(', ')}.`);
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Prisma update-data shape for resolving a QueueItem. Defaults to RESOLVED (the human acted on
 * it); callers pass state: 'DISMISSED' explicitly for a no-action dismissal - both still count as
 * a real human decision worth auditing, so both go through this same path.
 */
export function buildResolvePatch(userId, actionTaken, state = 'RESOLVED', now = new Date()) {
  return {
    state,
    resolvedAt: now,
    resolvedByUserId: userId,
    actionTaken,
  };
}

/**
 * Prisma create-data shape for AuditLogEntry when a queue item is resolved - same "real
 * authenticated human, real audit trail" contract buildAuditLogEntryForGate() gives
 * WorkflowRecord's gates. userId here is trusted from the request today (see app.mjs's
 * getCurrentUserId, still a stand-in until Azure AD B2C SSO lands per the ADR).
 *
 * jiraIssueKey/jiraIssueUrl are only present when this resolve also filed a real Jira bug (see
 * validateFileJiraBugRequest/mergeFiledBugIntoPayload below) - omitted entirely (not written as
 * null) when it didn't, so existing metadata shape for a plain resolve is unchanged.
 */
export function buildAuditLogEntryForQueueResolve({ organizationId, userId, queueItemId, sourceStage, actionTaken, jiraIssueKey, jiraIssueUrl }) {
  return {
    organizationId,
    userId,
    action: 'queue_item_resolved',
    entityType: 'QueueItem',
    entityId: queueItemId,
    metadata: {
      sourceStage,
      actionTaken,
      ...(jiraIssueKey ? { jiraIssueKey, jiraIssueUrl } : {}),
    },
  };
}

/**
 * Validates a resolve request's optional `fileJiraBug`/`bugReport` fields against the QueueItem
 * being resolved. Only called when the caller sets `fileJiraBug: true` - a plain resolve (the
 * default, existing behavior) never touches this path, so filing a bug is always an explicit human
 * choice, never implied by approving/dismissing.
 */
export function validateFileJiraBugRequest(body, queueItem) {
  const errors = [];
  if (queueItem.sourceStage !== 'defects') {
    errors.push('fileJiraBug is only valid for a QueueItem with sourceStage "defects".');
  }
  if (body.bugReport !== undefined) {
    const b = body.bugReport;
    if (!b || typeof b !== 'object' || typeof b.summary !== 'string' || typeof b.description !== 'string') {
      errors.push('bugReport, if provided, must be a JSON object with a string summary and description.');
    }
  }
  if (!queueItem.payload?.draftBugReport && body.bugReport === undefined) {
    errors.push('QueueItem has no payload.draftBugReport and no bugReport override was provided.');
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Merges a real, successful JiraClient.createBug() result into the QueueItem's existing payload -
 * additive (payload.filedBug), never overwrites payload.draftBugReport, so the original AI-drafted
 * proposal and what was actually filed both stay visible in the audit trail.
 */
export function mergeFiledBugIntoPayload(payload, filedBug, filedAt = new Date()) {
  return { ...payload, filedBug: { key: filedBug.key, url: filedBug.url, filedAt } };
}

/**
 * Phase D ("AI-Assisted Scrum and SDLC Console - Development Plan," docs/planning/) - "turning an
 * approved queue item into a real Jira ticket," the story side. Validates a resolve request's
 * optional `fileJiraStory`/`storyDraft` fields against the QueueItem being resolved, same shape and
 * same "only called when fileJiraStory: true is explicit" contract as validateFileJiraBugRequest
 * above - filing a real story is always a separate, auditable human choice from approving the
 * queue item, never implied by it.
 *
 * --stage draft-story's payload (src/pipeline/storyDraft/draftStory.ts /
 * queueClient.ts's createQueueItem() call in pipeline.ts's stageDraftStory) is flat -
 * { epicKey, title, description, acceptanceCriteria } - not nested under a draftStoryReport key
 * the way defects nests under draftBugReport, so this reads queueItem.payload.title/description
 * directly rather than a sub-object.
 */
export function validateFileJiraStoryRequest(body, queueItem) {
  const errors = [];
  if (queueItem.sourceStage !== 'stories') {
    errors.push('fileJiraStory is only valid for a QueueItem with sourceStage "stories".');
  }
  if (body.storyDraft !== undefined) {
    const s = body.storyDraft;
    if (!s || typeof s !== 'object' || typeof s.title !== 'string' || typeof s.description !== 'string') {
      errors.push('storyDraft, if provided, must be a JSON object with a string title and description.');
    }
  }
  if (!(queueItem.payload?.title && queueItem.payload?.description) && body.storyDraft === undefined) {
    errors.push('QueueItem has no payload.title/description and no storyDraft override was provided.');
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Merges a real, successful JiraClient.createStory() result into the QueueItem's existing payload -
 * additive (payload.filedStory), never overwrites the original title/description/acceptanceCriteria,
 * same "keep the original draft and what was actually filed both visible" reasoning as
 * mergeFiledBugIntoPayload() above.
 */
export function mergeFiledStoryIntoPayload(payload, filedStory, filedAt = new Date()) {
  return { ...payload, filedStory: { key: filedStory.key, url: filedStory.url, filedAt } };
}
