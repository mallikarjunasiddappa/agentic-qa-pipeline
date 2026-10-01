# Phase 2 Backend (multi-tenant service + database)

Separate deployable package from the CLI pipeline in `../src/pipeline` - same reasoning as
`../apps/<name>/` (Phase 0's genericity proof). Implements Production Roadmap Section 6: move
traceability/cost/healing/flaky state off flat JSON files onto a real service + database, scoped
by org/team/project, with SSO-ready identity and an audit trail. See the ADR in
`../docs/planning/Phase 2 Backend Architecture - ADR.md` for the full decision record (why
Postgres, why local-first, why Azure AD B2C for identity, why Key Vault stays where it is).

## Schema

`prisma/schema.prisma`. Every table except `Organization`/`Team`/`Project`/`User`/`AuditLogEntry`
(new for Phase 2) mirrors an existing zod schema in `../src/pipeline/types/schemas.ts` field-for-
field - see the comments in the schema file for the cross-reference. `Organization.legacyTenantId`
exists specifically to support a future migration script from today's `data/<tenantId>/*.json`
files into these tables.

## Local dev

```bash
npm install
npm run db:up          # postgres:16-alpine via docker-compose.yml, port 5432
cp .env.example .env
npm run prisma:generate
npm run prisma:migrate
```

`DATABASE_URL` in `.env` is the only thing that changes to point this at a hosted Postgres later
(Azure Database for PostgreSQL, DigitalOcean Managed Databases, etc.) - nothing in the schema or
generated client depends on where the database runs.

## Known limitation: `prisma validate`/`migrate`/`generate` may hang in a network-restricted
sandbox

While building this schema, running `prisma validate` (and separately, `prisma generate`) inside
the assistant's sandboxed shell consistently hung (exit code 124 under a `timeout` wrapper, with
and without `CHECKPOINT_DISABLE=1`). Root cause, confirmed directly: Prisma's CLI needs to fetch its
schema-engine binary from `binaries.prisma.sh`, and that host doesn't resolve in that sandbox
(`getaddrinfo EAI_AGAIN binaries.prisma.sh`). This is a property of that specific execution
environment, not of this schema or of a real dev machine with normal internet access - running the
commands above on your own machine should work normally.

Because the CLI itself couldn't be exercised there, the schema was instead verified by hand-
translating it to equivalent raw DDL and executing that against `@electric-sql/pglite` (a real,
embedded WASM build of Postgres 16 - not a mock). That run confirmed: all 11 tables created
without error, a full FK chain (`Organization` -> `Project` -> `User` -> `WorkflowRecord`) inserts
and joins correctly, and an intentionally-bad foreign key is rejected by a real constraint
violation, not silently accepted. This is real evidence the schema is valid, executable
PostgreSQL DDL - it is not a substitute for actually running `prisma generate`/`prisma migrate
dev` yourself before relying on the generated Prisma Client, which you should do the first time
you work in this directory.

## Migrating from `data/<tenantId>/`

`scripts/migrate-tenant.mjs` - one `Organization` row per existing `tenantId` (set via
`legacyTenantId`), a single default `Project` per org (real team/project structure can be
introduced later without a schema change), then a straight read of that tenant's
`traceability/manifest.json` (`workflow` -> `WorkflowRecord`, `entries` -> `TraceabilityEntry`),
`healing/telemetry.jsonl` -> `HealingEvent`, `flaky/telemetry.jsonl` -> `FlakyEvent`,
`flaky/quarantine.json` -> `QuarantineEntry`, and `cost/telemetry.jsonl` -> `CostEvent`. Legacy
free-text `*ClearedBy`/`*ApprovedBy` operator strings (if present) are resolved to a placeholder
`User` row (`ssoSubject: "legacy:<operator>"`) rather than dropped, so gate history isn't lost -
these get superseded by real SSO-authenticated Users once identity is wired up.

Run it:

```bash
DATABASE_URL=postgresql://... npm run migrate:tenant -- \
  --tenant-id default --org-name "Default Org" --data-dir ../data/default
```

`WorkflowRecord`/`TraceabilityEntry`/`QuarantineEntry` writes are idempotent (`ON CONFLICT DO
NOTHING` on the same unique constraints the schema declares). `HealingEvent`/`FlakyEvent`/
`CostEvent` are append-only history with no natural unique key in the source JSONL, so the script
skips importing any of those three tables for a project that already has rows in it, rather than
risk duplicating history on a re-run.

The row-shaping logic (`scripts/lib/buildMigrationRows.mjs`) is pure/IO-free, and both it and the
SQL write path (`loadTenantRows`/`writeTenantRows` in `scripts/migrate-tenant.mjs`) were verified
end-to-end against this repo's own real `data/default` tenant data - not synthetic fixtures - via
`npm run migrate:verify` (uses `@electric-sql/pglite`, the same real-Postgres-without-a-server
approach the schema itself was verified with above). That run confirmed: all 6 real `WorkflowRecord`
rows, 17 `HealingEvent` rows, and 18 `CostEvent` rows load and write correctly; an independent
re-read of the database matches the counts loaded from disk; and re-running the migration a second
time does not duplicate any rows.

**Windows note:** `migrate-tenant.mjs`'s "only run main() when executed directly" guard originally
compared `import.meta.url` against a hand-built `` `file://${process.argv[1]}` `` string, which
never matches on Windows (`process.argv[1]` uses backslashes; `import.meta.url` always uses
forward slashes with a drive-letter leading slash). That made the script silently do nothing - no
output, no error, exit code 0 - the first time it was run for real. Fixed by comparing against
`pathToFileURL(process.argv[1]).href` instead. Worth remembering for any other `.mjs` script in
this repo that adds a similar entrypoint guard.

## API layer

Covers the roadmap's "approval-gate actions tie to a real authenticated human... with an audit
trail" deliverable for all three `WorkflowRecord` gates, plus read-only access to everything else
`scripts/migrate-tenant.mjs` populates:

- `GET /health`
- `GET /api/organizations/:organizationId/projects/:projectId/workflow/:jiraKey` - read a
  `WorkflowRecord`
- `POST .../workflow/:jiraKey/requirements/clear`, `.../scenarios/approve`,
  `.../test-cases/approve` (body `{ "userId": "..." }`) - one route per gate in
  `workflowGates.mjs`'s `GATE_DEFINITIONS`; each clears its gate and writes a real `AuditLogEntry`
  in the same request. Verified live end-to-end for `requirements/clear` against a real running
  Postgres (real gate-clear call, real audit log entry confirmed in Prisma Studio) - the other two
  gates share the exact same code path (`applyGate`/`buildGatePatch`/`buildAuditLogEntryForGate`,
  parameterized by gate), so that verification covers their correctness too, though each hasn't
  been individually curled yet
- `GET /api/organizations/:organizationId/audit-log` - lists recent audit entries for an org
- `GET /api/projects/:projectId/traceability`, `/healing`, `/flaky`, `/quarantine`, `/cost`
  (optional `?limit=`) - read-only lists over the tables the migration script populates. Scoped by
  `projectId` alone (no `organizationId` in the path) because none of these five tables has an
  `organizationId` column in the schema - a deliberate inconsistency with the routes above, not an
  oversight

Run it:

```bash
npm run dev   # http://localhost:4000, PORT env var to override
```

```bash
curl -X POST http://localhost:4000/api/organizations/<orgId>/projects/<projectId>/workflow/<jiraKey>/requirements/clear \
  -H "Content-Type: application/json" -d '{"userId":"<a real User.id from your DB>"}'
curl http://localhost:4000/api/projects/<projectId>/healing?limit=5
```

**Identity is a stand-in, not real yet.** `src/app.mjs`'s `getCurrentUserId()` trusts a `userId`
supplied in the request body or an `X-User-Id` header - it does not verify a token, because Azure
AD B2C SSO isn't wired up yet (see the ADR's remaining action items). Every write route that calls
it says so in a `TODO(SSO)` comment at the call site. Swapping this for real token verification
later doesn't change anything downstream - `buildGatePatch`/`buildAuditLogEntryForGate` in
`src/lib/workflowGates.mjs` just take a `userId` string, they don't care where it came from.

**How this was verified.** `src/app.mjs`'s routes are built via `createApp({ workflowRepository,
auditLogRepository, readModelsRepository, queueRepository })` - all four are constructor-injected,
not imported directly - so `src/app.test.mjs` can exercise real HTTP requests (`app.listen(0)` +
`fetch`, real Express routing/status codes/JSON, not mocked request objects) against fake in-memory
repositories implementing the same interfaces `src/repositories/*.mjs` do. All 31 cases pass in the
build sandbox (`npm run test:unit`) - the three gates are tested table-driven from the same
`GATE_DEFINITIONS` the routes are built from, and each confirms exactly one correctly-shaped audit
log entry gets written. The five read-only routes are tested for project-scoping and `?limit=`
behavior. What that suite does *not* prove is that `src/repositories/*.mjs`'s real Prisma Client
calls are correct, since Prisma Client can't be generated in the build sandbox (same limitation as
above) - `requirements/clear` was verified live against a real Postgres already (see above); verify
the other two gates and the read-only routes for real on your machine the same way before relying
on them, the same pattern as `prisma:migrate` and `migrate:tenant`.

## AI Queue (Phase A of the Scrum/SDLC Console dev plan)

Implements Phase A of `../docs/planning/AI-Assisted Scrum and SDLC Console - Development Plan.docx`
- the real prerequisite that plan identifies: every "new" judgment-generating stage the source deck
describes (Stories, Sprint plan, Test cases, Defects, Release) needs somewhere for an AI-drafted
action to land for human review, and that place didn't exist before this. Reuses the
Organization/Project/User/AuditLogEntry infrastructure already built for Phase 2 rather than
standing up a parallel store.

`QueueItem` (`prisma/schema.prisma`): `type` (`SUGGESTED` / `ESCALATED` / `NEEDS_SESSION` - the
three interaction states from the source deck's slide 7), `sourceStage` (free text, not an enum -
new stages shouldn't require a migration), `payload` (the AI-drafted proposal itself, JSON),
`state` (`PENDING` / `RESOLVED` / `DISMISSED`), plus `resolvedAt`/`resolvedByUserId`/`actionTaken`
for the human decision. Shaping/validation logic lives in `src/lib/queueItems.mjs`
(IO-free, same reasoning as `workflowGates.mjs`); data access in
`src/repositories/queueRepository.mjs` (same factory-wrapped shape as `workflowRepository.mjs`).

Routes, in `src/app.mjs`:

- `POST /api/projects/:projectId/queue` (body `{ type, sourceStage, payload }`) - an AI/pipeline
  stage proposing something. Not nested under an organization, and doesn't write an
  `AuditLogEntry` - deliberate: nothing human has happened yet at create time, so there's nothing
  to audit.
- `GET /api/projects/:projectId/queue` (optional `?state=&type=&limit=`) - list, same
  project-scoped convention as the five read-only resources above.
- `POST /api/organizations/:organizationId/projects/:projectId/queue/:queueItemId/resolve` (body
  `{ userId, actionTaken, state? }`, `state` defaults to `RESOLVED`, pass `"DISMISSED"` for a
  no-action dismissal) - the actual governance-relevant human action, nested under
  `organizationId` and writing a real `AuditLogEntry` (`action: "queue_item_resolved"`), same
  pattern as the `WorkflowRecord` gate routes. Same `TODO(SSO)` caveat: `userId` is trusted from
  the request, not a verified token, until Azure AD B2C SSO lands.

**How this was verified.** Route logic: 8 new table-driven cases in `src/app.test.mjs` (create
validation, project-scoped list with `state`/`type` filters, resolve validation/404/success/
audit-log-entry-shape, explicit `DISMISSED`), all passing against a fake in-memory repository -
part of the same 31-case `npm run test:unit` run referenced above. Schema: `scripts/schema.raw.sql`
was extended with `QueueItem`'s DDL and re-verified via `npm run migrate:verify` (confirms it
doesn't break the existing schema/migration path), plus a new dedicated script,
`npm run verify:queue-schema`, that inserts a real `QueueItem` row against a real `Project` FK in
an in-memory `@electric-sql/pglite` Postgres, confirms a bad `projectId` is rejected by a real
foreign-key constraint, confirms an invalid `type` value is rejected by a real enum constraint, and
confirms a resolve (`state`/`resolvedAt`/`resolvedByUserId`/`actionTaken`) round-trips correctly on
read-back. As with the rest of this package, that's real evidence the DDL is valid Postgres - it is
not a substitute for running `prisma generate`/`prisma migrate dev` yourself, which you should do
before relying on `queueRepository.mjs`'s real Prisma Client calls (untested in the build sandbox,
same limitation as every other repository here).

The dashboard's "AI queue - needs your review" card (source deck's slide 8 UI spec) and real Jira
bug-filing on resolve are both now built - see the next two sections.

## AI Queue dashboard

`GET /api/projects/:projectId/queue/dashboard?organizationId=<id>` - a self-contained HTML page
(no build step, no framework - `src/views/queueDashboard.mjs`), listing every `PENDING` `QueueItem`
for the project with Approve / Reject / Dismiss buttons, plus an "Approve & File Jira Bug" button
on `defects` items. Unlike `scrumDashboard.ts`'s read-only cards, this one is a real action surface
- its inline JS calls this API's own `GET .../queue`/`POST .../queue/:id/resolve` routes directly
from the browser. `organizationId` is a required query param purely because the resolve route needs
it and the dashboard has no other source for it (no SSO yet - see the ADR).

No real login exists yet, so the page asks for a "resolved by" user id once and remembers it in
`localStorage` for convenience. That's a normal, safe choice here: this is a real page served by a
real Express app, not a claude.ai conversation artifact (where `localStorage` is unreliable) - see
`src/views/queueDashboard.mjs`'s header comment for the explicit reasoning.

**How this was verified.** 5 unit tests in `src/views/queueDashboard.test.mjs` (pure function, no
server) covering the empty state, item rendering per `sourceStage`, the conditional "File Jira Bug"
button, and HTML-escaping of untrusted payload content. 2 more HTTP-level tests in
`src/app.test.mjs` confirm the route requires `organizationId`, returns `text/html`, and correctly
scopes to `PENDING` items in the requested project only (39 dashboard+resolve-related cases across
both files, part of the 51 total in `npm run test:unit`).

## Real Jira bug filing on resolve

`POST .../queue/:queueItemId/resolve` now accepts an optional `fileJiraBug: true` (plus an optional
`bugReport` override for a human-edited summary/description/labels) - when set, and only then, it
calls a real `JiraClient.createBug()` (`src/lib/jiraClient.mjs`) with the item's
`payload.draftBugReport` (or the override), merges the result into `payload.filedBug` (`{ key, url,
filedAt }`, additive - the original `draftBugReport` is never overwritten), and records
`jiraIssueKey`/`jiraIssueUrl` on the `AuditLogEntry`. A plain resolve (the default - approve/reject/
dismiss) never files anything: filing a real Jira bug is always a second, explicit, separately
auditable human choice, never implied by approval.

Failure handling is deliberately conservative: if Jira isn't configured
(`JIRA_BASE_URL`/`JIRA_EMAIL`/`JIRA_API_TOKEN`/`JIRA_PROJECT_KEY` - see `.env.example`), the route
returns `503` and the item is untouched. If the real Jira API call itself fails, the route returns
`502` and **the item is not resolved** - it stays `PENDING` so retrying is safe, rather than
silently losing the "a bug needs filing" state. `fileJiraBug` is also rejected with `400` for any
`sourceStage` other than `defects`.

`src/lib/jiraClient.mjs` is a small, backend-local Jira client (createBug only - not a port of the
CLI's full `src/pipeline/jira/jiraClient.ts`, which also reads tickets and manages transitions).
Same ADF (Atlassian Document Format) description conversion and request shape as that file, so both
clients send identical Jira API calls for the same `BugReport` input. Config is read from flat env
vars (`loadJiraConfigFromEnv()`), not the CLI's per-tenant `envFileTenantKey()`/`secretsProvider.ts`
resolution - `backend/` is still single-tenant-per-deployment as of Phase 2 (see the ADR); real
multi-tenant Jira credentials would be a separate, later change.

**How this was verified**, in three layers, same discipline as everywhere else in this package:

1. Route logic (`app.mjs`): 6 new HTTP-level tests in `src/app.test.mjs` against a fake
   `JiraClient` - 503 when unconfigured (and the item stays untouched), 400 for a non-`defects`
   item, 404 for an unknown item, a full success path (payload merge + audit metadata asserted),
   the `bugReport` override path, and the 502-and-stays-`PENDING` failure path.
2. The real HTTP call itself (`jiraClient.mjs`): `npm run verify:jira-client` spins up a real
   `node:http` server on `127.0.0.1` (not a mock) and confirms the client sends a real `POST
   /rest/api/3/issue`, a real HTTP Basic Auth header built from `email`/`apiToken`, a request body
   whose `fields.project`/`issuetype`/`summary`/`labels` match the input exactly, and a real
   Atlassian Document Format `description` (one paragraph per non-empty input line) - then confirms
   the real HTTP response is parsed back into `{ key, url }` correctly.
3. **Not verified, and cannot be from this environment**: an actual call against real Jira.
   Nothing in this codebase has real Jira credentials. Before relying on `fileJiraBug` in
   production, set real `JIRA_*` env vars and file one real test bug against a real (ideally
   sandbox) Jira project - the same "verify the real network path yourself" pattern this package
   has followed for Postgres (`prisma generate`/`migrate dev`) since Phase 2 began.

## Real Jira story filing on resolve (Phase D)

Phase D of the same dev plan - "turning an approved queue item into a real Jira ticket" for the
story side (Phase D's bug-side equivalent, `fileJiraBug`, shipped earlier - see above). Same shape,
same trust boundary: `POST .../queue/:queueItemId/resolve` now also accepts an optional
`fileJiraStory: true` (plus an optional `storyDraft` override for a human-edited
title/description/acceptanceCriteria) - when set, it calls a real `JiraClient.createStory()`
(`src/lib/jiraClient.mjs`) with the item's `payload` (a `--stage draft-story` queue item's payload
is already flat - `{ epicKey, title, description, acceptanceCriteria }`, not nested under a
sub-key the way `defects` nests under `draftBugReport`) or the override, merges the result into
`payload.filedStory` (`{ key, url, filedAt }`, additive), and records `jiraIssueKey`/`jiraIssueUrl`
on the `AuditLogEntry` - the exact same audit fields a filed bug uses, so both show up identically
in the audit log. `fileJiraStory` is rejected with `400` for any `sourceStage` other than `stories`,
and shares the exact same `503`-when-unconfigured / `502`-and-stays-`PENDING`-on-failure semantics
`fileJiraBug` already has.

Jira's Story issue type has no universal native acceptance-criteria field across instances, so
`createStory()` appends `acceptanceCriteria` to the description body as a plain bullet list rather
than dropping it - "surface it, don't lose it," same posture the rest of this pipeline takes with
data it can't map 1:1 onto a target system's schema.

**How this was verified**, same three-layer discipline as `fileJiraBug` above:

1. Route logic (`app.mjs`): 5 new HTTP-level tests in `src/app.test.mjs` against a fake
   `JiraClient` - 503 when unconfigured, 400 for a non-`stories` item, 404 for an unknown item, a
   full success path (payload merge + audit metadata asserted), the `storyDraft` override path, and
   the 502-and-stays-`PENDING` failure path (57 total in `npm run test:unit`, up from 52).
2. The real HTTP call itself (`jiraClient.mjs`): `npm run verify:jira-client` (extended, not a new
   script) now also exercises `createStory()` against the same real local `node:http` server -
   confirms `issuetype.name: "Story"`, the acceptance criteria bullet list actually appears in the
   real ADF description body, and the real HTTP response is parsed back into `{ key, url }`.
3. **Not verified, and cannot be from this environment**: an actual call against real Jira, same
   limitation `fileJiraBug` already notes.

## Phase B: wiring existing pipeline output into the queue

`backend/scripts/enqueue-from-pipeline-output.mjs` - implements Phase B of the dev plan's Section
4: "connect the existing output," not a second drafting mechanism. Scans one migrated project's
`WorkflowRecord`/`HealingEvent` rows for real pending-human-review state and enqueues a `QueueItem`
for each one not already queued. Same raw-SQL-via-`pg` approach as `migrate-tenant.mjs` (not the
Prisma-Client-backed `queueRepository.mjs`), for the same reason: Prisma Client can't be generated
in the build sandbox, so this script (and its row-shaping logic) needed to be verifiable against a
real Postgres without one - see below.

Two producers (full reasoning in `backend/scripts/lib/buildQueueProducerRows.mjs`):

- **test-cases**: a `WorkflowRecord` with Gate 1 (`scenariosApprovedAt`) cleared but Gate 2
  (`testCasesApprovedAt`) still pending -> a `NEEDS_SESSION` `QueueItem`. This is the real state
  the six-agent pipeline's existing Planning -> Generator -> Excel -> TMS output already produces
  and already gates via the existing `test-cases/approve` route (see the API layer section above) -
  the queue item is a pointer into the unified queue, not a second approval mechanism. Approving/
  rejecting the actual gate still goes through that existing route.
- **defects**: a `HealingEvent` with `outcome: 'escalated'` (the Healer agent's own documented
  failure-escalation path - see `docs/planning/End-to-End Pipeline Validation - Runbook.md`) -> an
  `ESCALATED` `QueueItem`, `payload.draftBugReport` shaped to match `BugReportSchema`
  (`src/pipeline/types/schemas.ts`) exactly - the real input type
  `JiraClient.createBug()` (`src/pipeline/jira/jiraClient.ts`) already accepts. **The resolve action
  does not call `createBug()` yet** - `backend/` has no Jira credentials/client wired in today (only
  the CLI pipeline does, via `requireTenantEnv`), and actually filing a Jira issue on resolve is a
  real side effect that needs that wiring plus its own review before being trusted with real Jira
  writes. Today, resolving this queue item is a human record-keeping decision only.

Idempotent by design (a real cron/CI candidate, like `sprint-status`/`standup-digest` already are
for the CLI pipeline): each producer excludes source rows that already have a `QueueItem` pointing
at them, via `payload.workflowRecordId` / `payload.healingEventId`.

The dev plan's third Phase B item, **test runs**, needed no new build - confirmed, not assumed:
`src/pipeline/pipelineReport/pipelineReport.ts` already reads `HealingReport`/`FlakyReport`
directly (`healingReport.ts`/`flakyReport.ts`) for the CLI's own pipeline-health dashboard, and this
package's `readModelsRepository.mjs` (built in the Phase 2 API layer, see above) already serves
`HealingEvent`/`FlakyEvent` read-only via `GET /api/projects/:projectId/healing` and `/flaky`. Both
already "connect... rather than rebuilding," per the source deck's own slide 10 guidance - nothing
to wire here.

Run it:

```bash
DATABASE_URL=postgresql://... npm run enqueue:from-pipeline -- --project-id <a real Project.id>
```

**How this was verified.** Row-shaping logic: 7 unit tests in
`scripts/lib/buildQueueProducerRows.test.mjs` (part of `npm run test:unit`, 38 cases total now).
End-to-end behavior: `npm run verify:enqueue-from-pipeline` seeds real `WorkflowRecord`/
`HealingEvent` rows covering every enqueue/skip scenario into an in-memory
`@electric-sql/pglite` Postgres, confirms exactly the right rows get queued (and the wrong ones
don't), confirms the defect payload is genuinely `BugReport`-shaped, and confirms a second run
enqueues nothing new (real idempotency, not asserted-by-construction). Also run once against this
repo's own real, already-migrated `data/default` tenant data (6 real `WorkflowRecord` rows, 17 real
`HealingEvent` rows) as an honest sanity check, not a synthetic-only test: as of this writing, 0 of
those 6 tickets have Gate 1 cleared yet and 0 of those 17 healing events are `escalated` (2
`healed`, 15 `passed_no_heal_needed`), so the script correctly enqueued nothing for this tenant
today - that's the real current state of this project's pipeline, not a script bug. Re-run
`npm run verify:queue-schema`-style: after a real ticket clears Gate 1, or a real Healer run
escalates, running `enqueue:from-pipeline` again is how you'd see the first real `QueueItem`
appear.
