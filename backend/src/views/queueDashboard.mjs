/**
 * The AI Queue's dashboard card - "AI queue - needs your review," per the source deck's slide 8 UI
 * spec (docs/planning/AI-Assisted Scrum and SDLC Console - Development Plan.docx). A single
 * self-contained HTML page (no build step, no framework - same "no new ingestion, no new
 * aggregation layer" posture as src/pipeline/scrum/stages/scrumDashboard.ts's cards), served
 * directly by app.mjs's GET /api/projects/:projectId/queue/dashboard route.
 *
 * Unlike scrumDashboard.ts's cards, this one is NOT read-only: the source deck's queue concept is
 * inherently an action surface (approve/reject/dismiss, and for defects, file a real Jira bug), so
 * the page includes inline JS that calls this backend's own already-built API
 * (GET .../queue, POST .../queue/:id/resolve) directly from the browser - real fetch() calls
 * against real routes, not a mock.
 *
 * No real login/SSO exists yet (see the ADR's remaining action items), so there is no server-known
 * "current user." The page asks for a "resolved by" user id once and remembers it in
 * localStorage for convenience - this is a real, standalone page served by a real Express app (not
 * a claude.ai conversation artifact), so localStorage is a normal, safe choice here, not the
 * in-conversation-artifact case where it's disallowed.
 *
 * Pure function - no IO here, same reasoning as buildScrumDashboardHtml()/buildGatePatch(): keeps
 * this testable without a server or a database. See src/app.test.mjs's dashboard-route tests for
 * IO-level coverage and README.md's "AI Queue" section for what was and wasn't verified.
 */

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function summarizePayload(item) {
  if (item.sourceStage === 'defects' && item.payload?.draftBugReport?.summary) {
    return item.payload.draftBugReport.summary;
  }
  // Phase D - --stage draft-story's queue payload is flat ({ epicKey, title, description,
  // acceptanceCriteria }, see draftStory.ts), not nested under a sub-key the way defects nests
  // under draftBugReport - so this reads payload.title directly.
  if (item.sourceStage === 'stories' && item.payload?.title) {
    return item.payload.title;
  }
  if (item.payload?.note) return item.payload.note;
  if (item.payload?.jiraKey) return `Jira ticket ${item.payload.jiraKey}`;
  return '(no summary available - see raw payload)';
}

function itemCard(item) {
  const createdAt = item.createdAt instanceof Date ? item.createdAt.toISOString() : String(item.createdAt);
  const canFileJiraBug = item.sourceStage === 'defects' && Boolean(item.payload?.draftBugReport);
  const canFileJiraStory = item.sourceStage === 'stories' && Boolean(item.payload?.title);
  return `
    <section class="queue-item" data-item-id="${escapeHtml(item.id)}">
      <header>
        <span class="badge badge-${escapeHtml(item.type)}">${escapeHtml(item.type)}</span>
        <span class="source-stage">${escapeHtml(item.sourceStage)}</span>
        <span class="created-at">${escapeHtml(createdAt)}</span>
      </header>
      <p class="summary">${escapeHtml(summarizePayload(item))}</p>
      <details>
        <summary>Raw payload</summary>
        <pre>${escapeHtml(JSON.stringify(item.payload, null, 2))}</pre>
      </details>
      <div class="actions">
        <button class="approve" onclick="resolveItem('${escapeHtml(item.id)}', 'approved_as_is', 'RESOLVED', false, false)">Approve</button>
        <button class="reject" onclick="resolveItem('${escapeHtml(item.id)}', 'rejected', 'RESOLVED', false, false)">Reject</button>
        <button class="dismiss" onclick="resolveItem('${escapeHtml(item.id)}', 'dismissed_no_action', 'DISMISSED', false, false)">Dismiss</button>
        ${canFileJiraBug ? `<button class="file-bug" onclick="resolveItem('${escapeHtml(item.id)}', 'approved_as_is', 'RESOLVED', true, false)">Approve &amp; File Jira Bug</button>` : ''}
        ${canFileJiraStory ? `<button class="file-story" onclick="resolveItem('${escapeHtml(item.id)}', 'approved_as_is', 'RESOLVED', false, true)">Approve &amp; File Jira Story</button>` : ''}
      </div>
    </section>`;
}

/**
 * Builds the full dashboard page. `items` should already be filtered to state: 'PENDING' (the
 * route above does this via queueRepository.listByProject(projectId, { state: 'PENDING' })) -
 * kept as a caller responsibility, same split every other report-building function in this repo
 * uses, so this function stays a pure render step over data it's handed.
 */
export function buildQueueDashboardHtml(items, { projectId, organizationId }) {
  const body =
    items.length === 0
      ? '<p class="empty">Nothing pending review right now.</p>'
      : items.map(itemCard).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AI Queue - Needs Your Review</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 900px; margin: 2rem auto; padding: 0 1rem; color: #1a1a2e; }
  h1 { font-size: 1.5rem; }
  .toolbar { margin-bottom: 1.5rem; display: flex; gap: 0.5rem; align-items: center; }
  .toolbar input { padding: 0.4rem; }
  .queue-item { border: 1px solid #ddd; border-radius: 8px; padding: 1rem; margin-bottom: 1rem; }
  .queue-item header { display: flex; gap: 0.75rem; align-items: baseline; margin-bottom: 0.5rem; }
  .badge { font-weight: 600; padding: 0.15rem 0.5rem; border-radius: 4px; background: #eef; }
  .badge-SUGGESTED { background: #e6f4ea; }
  .badge-ESCALATED { background: #fdecea; }
  .badge-NEEDS_SESSION { background: #fff4e5; }
  .source-stage { color: #555; }
  .created-at { margin-left: auto; color: #888; font-size: 0.85rem; }
  .summary { margin: 0.5rem 0; }
  pre { background: #f7f7f7; padding: 0.5rem; overflow-x: auto; font-size: 0.8rem; }
  .actions button { margin-right: 0.5rem; padding: 0.4rem 0.8rem; cursor: pointer; }
  .empty { color: #888; }
  .status-line { min-height: 1.2rem; color: #b00; }
</style>
</head>
<body>
<div class="toolbar">
  <label for="resolvedBy">Resolved by (user id):</label>
  <input id="resolvedBy" type="text" placeholder="your User.id">
</div>
<h1>AI Queue - Needs Your Review</h1>
<p class="status-line" id="statusLine"></p>
<div id="items">
${body}
</div>
<script>
  const PROJECT_ID = ${JSON.stringify(projectId)};
  const ORGANIZATION_ID = ${JSON.stringify(organizationId)};
  const resolvedByInput = document.getElementById('resolvedBy');
  resolvedByInput.value = window.localStorage.getItem('aiQueueResolvedBy') || '';
  resolvedByInput.addEventListener('change', () => {
    window.localStorage.setItem('aiQueueResolvedBy', resolvedByInput.value);
  });

  async function resolveItem(queueItemId, actionTaken, state, fileJiraBug, fileJiraStory) {
    const userId = resolvedByInput.value.trim();
    const statusLine = document.getElementById('statusLine');
    statusLine.textContent = '';
    if (!userId) {
      statusLine.textContent = 'Enter your user id above before resolving an item.';
      return;
    }
    try {
      const res = await fetch(
        \`/api/organizations/\${ORGANIZATION_ID}/projects/\${PROJECT_ID}/queue/\${queueItemId}/resolve\`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId, actionTaken, state, fileJiraBug, fileJiraStory }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        statusLine.textContent = 'Failed: ' + (body.error || body.errors || res.status);
        return;
      }
      window.location.reload();
    } catch (e) {
      statusLine.textContent = 'Network error: ' + e.message;
    }
  }
</script>
</body>
</html>
`;
}
