#!/usr/bin/env node
/**
 * Verifies src/lib/jiraClient.mjs's real axios-based createBug() AND createStory() (Phase D) against
 * a real local HTTP server (node:http, listening on 127.0.0.1) - not a mocked function call. This is
 * the one piece of the Jira wiring that src/app.test.mjs's fake-JiraClient tests deliberately don't
 * cover: whether the actual HTTP request axios sends (method, path, basic-auth header, JSON body
 * shape) and the actual response parsing are correct. It cannot verify against real Jira itself (no
 * credentials exist in this environment) - see backend/README.md's "AI Queue" section for what that
 * leaves for you to confirm once real JIRA_* env vars are set.
 *
 * Confirms, for both createBug() and createStory(): the client POSTs to /rest/api/3/issue; sends
 * HTTP Basic Auth built from email/apiToken; the request body's fields match the input (including
 * createStory()'s acceptance-criteria-appended-to-description behavior, since Jira has no universal
 * native field for it); description is real Atlassian Document Format (a "doc" node with one
 * "paragraph" per non-empty input line, matching src/pipeline/jira/jiraClient.ts's textToAdf()
 * exactly); the returned { key, url } is built from the server's real response body.
 *
 * Usage: node backend/scripts/verify-jira-client.mjs
 */
import http from 'node:http';
import { createJiraClient } from '../src/lib/jiraClient.mjs';

function assertEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function main() {
  let receivedRequest = null;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      receivedRequest = {
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        body,
      };
      // Returns a distinguishable key per issue type so the createBug()/createStory() sections
      // below can each assert on the real response their own request actually got back.
      const key = body.fields?.issuetype?.name === 'Story' ? 'STORY-9' : 'REAL-7';
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ key }));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const client = createJiraClient({
      baseUrl,
      email: 'bot@example.com',
      apiToken: 'test-token-123',
      projectKey: 'SCRUM',
    });

    const result = await client.createBug({
      summary: 'Healer escalation: checkout.spec.ts failed to self-heal',
      description: 'Suite: checkout\nTest: checkout.spec.ts\nAttempt: 2',
      labels: ['healer-escalation', 'locator_drift'],
    });

    if (!receivedRequest) throw new Error('Server never received a request - createBug() did not make a real HTTP call.');

    assertEqual(receivedRequest.method, 'POST', 'HTTP method');
    assertEqual(receivedRequest.url, '/rest/api/3/issue', 'request path');
    console.log('Real HTTP POST sent to the correct path.');

    const expectedAuth = `Basic ${Buffer.from('bot@example.com:test-token-123').toString('base64')}`;
    assertEqual(receivedRequest.authorization, expectedAuth, 'Basic Auth header');
    console.log('Real HTTP Basic Auth header built correctly from email/apiToken.');

    assertEqual(receivedRequest.body.fields.project, { key: 'SCRUM' }, 'fields.project');
    assertEqual(receivedRequest.body.fields.issuetype, { name: 'Bug' }, 'fields.issuetype');
    assertEqual(receivedRequest.body.fields.summary, 'Healer escalation: checkout.spec.ts failed to self-heal', 'fields.summary');
    assertEqual(receivedRequest.body.fields.labels, ['healer-escalation', 'locator_drift'], 'fields.labels');
    console.log('Request body fields (project/issuetype/summary/labels) match the input BugReport.');

    const description = receivedRequest.body.fields.description;
    assertEqual(description.type, 'doc', 'description.type (ADF)');
    assertEqual(description.content.length, 3, 'description paragraph count (one per input line)');
    assertEqual(description.content[0].content[0].text, 'Suite: checkout', 'description first paragraph text');
    console.log('Description correctly converted to real Atlassian Document Format (one paragraph per line).');

    assertEqual(result, { key: 'REAL-7', url: `${baseUrl}/browse/REAL-7` }, 'createBug() return value');
    console.log('createBug() correctly parsed the real HTTP response into { key, url }.');

    // --- createStory() (Phase D) ---
    receivedRequest = null;
    const storyResult = await client.createStory({
      title: 'Allow guest checkout',
      description: 'As a shopper, I want to check out without an account.',
      acceptanceCriteria: ['Guest can complete checkout without registering', 'Confirmation email is sent'],
    });

    if (!receivedRequest) throw new Error('Server never received a request - createStory() did not make a real HTTP call.');

    assertEqual(receivedRequest.method, 'POST', 'createStory HTTP method');
    assertEqual(receivedRequest.url, '/rest/api/3/issue', 'createStory request path');
    assertEqual(receivedRequest.body.fields.project, { key: 'SCRUM' }, 'createStory fields.project');
    assertEqual(receivedRequest.body.fields.issuetype, { name: 'Story' }, 'createStory fields.issuetype');
    assertEqual(receivedRequest.body.fields.summary, 'Allow guest checkout', 'createStory fields.summary (from title)');
    console.log('createStory() sent a real HTTP POST with issuetype "Story" and the correct summary.');

    const storyDescription = receivedRequest.body.fields.description;
    assertEqual(storyDescription.type, 'doc', 'createStory description.type (ADF)');
    const storyDescriptionText = storyDescription.content.map((p) => p.content[0].text).join('\n');
    if (!storyDescriptionText.includes('Acceptance Criteria:')) {
      throw new Error(`Expected description to include an appended "Acceptance Criteria:" section, got: ${storyDescriptionText}`);
    }
    if (!storyDescriptionText.includes('- Guest can complete checkout without registering')) {
      throw new Error(`Expected description to include each acceptance criterion as a bullet, got: ${storyDescriptionText}`);
    }
    console.log('createStory() correctly appended acceptanceCriteria as a bullet list onto the ADF description.');

    assertEqual(storyResult, { key: 'STORY-9', url: `${baseUrl}/browse/STORY-9` }, 'createStory() return value');
    console.log('createStory() correctly parsed the real HTTP response into { key, url }.');

    console.log('VERIFICATION PASSED: jiraClient.mjs sends real, correctly-shaped HTTP requests (createBug + createStory) and parses real responses.');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((e) => {
  console.error('VERIFICATION FAILED:', e);
  process.exit(1);
});
