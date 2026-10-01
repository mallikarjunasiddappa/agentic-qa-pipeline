# Agentic QA Pipeline

> **Portfolio version.** This is a sanitized copy of an AI-assisted test automation pipeline I designed
> and built (Claude Code CLI + Claude Agent SDK + Playwright/TypeScript) while supporting QA for a client.
> Client-specific material has been removed: the application's tests, page objects, test data, specs,
> internal documents and all credentials (see `.env.example` for placeholders). The pipeline itself —
> agents, orchestrator, human approval gates, CI guardrails, traceability/drift detection, healing and
> cost telemetry — is included, type-checks cleanly (`npm run typecheck`) and its 842 unit tests pass
> (`npm run test:unit`). Some sections below still refer to client-specific folders that are not part
> of this copy.

> AI-agent-orchestrated, requirements-to-regression-suite test automation: six cooperating Claude
> Code agents take a Jira ticket from requirement to a reviewed, traceable, self-healing
> Playwright test - with governance and cost accounting built in from day one, not bolted on
> after.

**Stack:** TypeScript · Playwright · Claude Code (Agent SDK) · Node.js · Zod · GitHub Actions ·
Jira REST API · Qase (behind a provider-agnostic interface)

## Why this is worth a closer look

Most "AI test generation" projects stop at "the AI writes a test." This one's actual thesis,
worked out the hard way across real debugging sessions (see the gotcha call-outs and Deviations
section throughout this README) is that **building the agent is the easy part - keeping it
reliable, observable, and accountable is where the real engineering is**:

- **Traceability isn't "AI keeps things in sync"** - it's an explicit, six-state contract
  (`IN_SYNC` / `CASE_DRIFTED` / `TEST_DRIFTED` / `BOTH_DRIFTED` / `ORPHANED_CASE` /
  `ORPHANED_TEST`) that never silently auto-resolves. A drifted case gets *reported*, never
  quietly patched over.
- **Healing and flakiness are deliberately separate metrics.** Most tools blend "the AI fixed it"
  and "this test is unreliable" into one blurred reliability score - this project keeps them apart
  on purpose, because merging them makes both numbers meaningless.
- **Two human-approval gates are enforced in code, not in a prompt.** `--stage excel-write` and
  `--stage tms-upload` mechanically refuse to run without a recorded approval - an agent can't be
  told to "just skip review" and have that actually happen silently.
- **Per-agent cost accounting exists because of a real, empirically-confirmed telemetry gotcha:**
  Claude Code's own OTel `agent.name` attribute collapses to `"custom"` for every subagent, so
  this project built its own marker-correlation mechanism to attribute cost per agent instead of
  reporting one undifferentiated total.

## Pipeline at a glance

![Pipeline architecture: Jira ticket into the Planning Agent orchestrator, through Gate 0's requirement gap check and the Gate 1/Gate 2 human approvals, dispatching Excel, TMS, Generator, and Healer agents, feeding Traceability, Healing/Flaky, and Cost telemetry, plus two PR-time CI guardrails](docs/architecture.svg)

The full technical deep-dive - every module, every empirically-confirmed gotcha, every deliberate
deviation from the original spec and why - is below. It's written the way real engineering
decisions get made: what broke, what was tried, what was confirmed rather than assumed.

---

A TypeScript Playwright test automation framework built around seven cooperating Claude Code
agents: Jira ticket in, a reviewed test plan and healed Playwright specs out, with results
reported back to Jira and the configured test management provider, drift between the three
continuously watched by the Traceability Agent, and the Healer Agent's own success rate tracked
over time as healing telemetry. Two separate, non-agent CI gates enforce the rest of
`CLAUDE.md`'s rulebook mechanically: the Assertion Integrity Guardrail blocks a pull request that
deletes or weakens a test assertion without an explicit, justified sign-off, and the Locator
Priority Guardrail blocks one that introduces a CSS/XPath-style locator. A third piece of
cross-cutting instrumentation, Cost & Latency Accounting, tracks what each agent actually costs
per invocation - built around a real gotcha in Claude Code's own telemetry, confirmed empirically
rather than assumed (see that section below).

**No MCP servers.** Jira and the test management provider are direct REST API calls (`axios`);
Excel I/O is direct `exceljs` calls; Playwright is driven directly via `playwright-cli` /
`npx playwright` (`execFile`/background processes), never through an MCP Playwright server. There
is no programmatic LLM API call anywhere in this project - scenario writing, spec generation, and
test healing are all done by Claude Code agents reasoning natively in-session, using the
`playwright-cli` skill to explore and drive the real app.

## Architecture

| Agent | Module(s) / mechanism | Responsibility |
|---|---|---|
| Planning Agent (orchestrator) | Own reasoning + `playwright-cli` skill Section 1 | State machine, retry/escalation policy, writes `specs/<feature>.plan.md` |
| Jira Agent | `src/pipeline/jira/jiraClient.ts` | Jira Cloud REST API v3 |
| Generator Agent | `playwright-cli` skill Section 2 | Turns plan scenarios into real Playwright TypeScript |
| Excel Agent | `src/pipeline/excel/excelWriter.ts`, `excelReader.ts`, `src/pipeline/specs/specParser.ts` | Human sign-off sheet (`exceljs`) |
| TMS Agent | `src/pipeline/testmgmt/` (`getTestManagementClient()`, provider chosen by `TMS_PROVIDER`), `src/pipeline/specs/specParser.ts` | Test management provider REST API - Qase today, behind a provider-agnostic interface (see Test Management Provider Abstraction below) |
| Healer Agent | `playwright-cli` skill Section 3, `src/pipeline/telemetry/` | Runs + interactively heals Playwright specs, records healing telemetry |
| Traceability Agent | `src/pipeline/traceability/` | Detects drift between a Jira ticket, its test management case(s), and their generated test file(s) |

## Billing

Using this workflow requires an interactive `claude` session - it is covered by your Claude
subscription, the same as any other Claude Code conversation. There is intentionally **no
automated or headless mode**: scenario writing, spec generation, and healing all happen as the
agents' own in-session reasoning (via `playwright-cli`), not as programmatic calls to the
Anthropic API, so there's no separate per-token API billing to account for. If you want a fully
unattended CI-style run, you'd need to add that back deliberately (and budget for API usage) -
it's out of scope here by design.

## Setup

```bash
npm install
npx playwright install       # add --with-deps on Linux - browser binaries, not covered by npm install
cp .env.example .env
```

Requires Node.js 22+ (see `package.json`'s `engines`). Actually running the six/seven-agent
workflow (Using the workflow, below) also requires a `claude` (Claude Code) session, separate from
this npm install - it's what drives the Planning/Generator/Healer agents' own reasoning, not a
package dependency (see Billing below for how that's covered).

Fill in `.env`:

| Variable | Used by | Notes |
|---|---|---|
| `TENANT_ID` | Every stage | Optional. Which tenant this CLI invocation runs as - `--tenant` (CLI flag) takes precedence over this, both fall back to `default` if neither is set, so this table and every existing invocation keep working unchanged. See Multi-Tenant Foundations below |
| `JIRA_BASE_URL` | Jira Agent | e.g. `https://your-domain.atlassian.net` |
| `JIRA_EMAIL` | Jira Agent | Account email for Basic auth |
| `JIRA_API_TOKEN` | Jira Agent | [Atlassian API token](https://id.atlassian.com/manage-profile/security/api-tokens) |
| `JIRA_PROJECT_KEY` | Jira Agent, Dev Status Stage (`--stage dev-status`) | Project bugs are filed into, e.g. `PROJ` - also the key `matchBranchToTicket()` looks for in branch/PR names, see Scrum Master Automation Program below |
| `TMS_PROVIDER` | TMS Agent | Which test management adapter to use. Defaults to `qase` - the only one built today |
| `GITHUB_TOKEN` | Dev Status Stage (VCS Client, GitHub adapter) | A [PAT](https://github.com/settings/tokens) with `repo` scope (or fine-grained equivalent: Pull requests + Contents read access) on the repo below |
| `GITHUB_REPO` | Dev Status Stage | `owner/repo`, e.g. `your-org/agentic-qa-pipeline` |
| `QASE_API_TOKEN` | TMS Agent (Qase adapter) | From Qase account settings |
| `QASE_PROJECT_CODE` | TMS Agent (Qase adapter) | Qase project code, e.g. `PROJ` |
| `DRIFT_CHECK_CONCURRENCY` | Traceability drift check | Optional. How many manifest entries are fetched from the TMS at once instead of one at a time. Defaults to 5 if unset - see Traceability below |
| `PIPELINE_OPERATOR` | Gate stages (`flag-requirement-gaps`, `approve-requirements`, `approve-scenarios`, `approve-test-cases`) | Optional. Who's running this CLI, recorded on the gate record in `traceability/manifest.json` - falls back to `JIRA_EMAIL` if unset. See Team Usage below |
| `SLACK_WEBHOOK_URL` | Pipeline health report (`npm run pipeline:report`) | Optional. [Incoming webhook URL](https://api.slack.com/messaging/webhooks) - if unset, the report is still written to disk, just not posted to Slack |
| `DRIFT_CHECK_SLACK_WEBHOOK_URL` | Traceability drift check (`npm run drift:check`) | Optional. A **separate** incoming webhook from `SLACK_WEBHOOK_URL` above, by design - drift alerts and the general health heartbeat go to different Slack channels |
| `SLACK_NOTIFY_LOCAL` | Pipeline health report, drift check | Optional. Both Slack posts are CI-only by default - set to `true` to opt back in for local runs. See Team Usage below |
| `PIPELINE_REPORT_PUBLIC_URL` | Pipeline health report | Optional. In CI, sourced from a repo Actions **variable** of the same name (not computed - this repo's Pages site is private, served from a randomized subdomain; see Pipeline Health Report below for how to set it once). Drives two things: the Slack message's link, and `report.html`'s "Full X report" sub-links (pointed at that same site's self-hosted `cost/report.html` etc. instead of a relative path that only resolves in a local repo checkout). Leave unset for local runs - both fall back accordingly |
| `MERGE_NOTIFY_SLACK_WEBHOOK_URL` | Merge Notify workflow (CI only) | Optional. Its own incoming webhook, separate from `SLACK_WEBHOOK_URL` above - a merge-ping fires far more often than the daily health report and would otherwise drown it out. Set as a **GitHub Actions repository secret**, not a local `.env` value. See Slack Notifications below |
| `SLACK_BOT_TOKEN` | Ticket summary (`--stage ticket-summary`) | Optional. A Bot User OAuth Token (`xoxb-...`), not a webhook - this DMs the person running the command, which a webhook can't do. Requires a Slack App with `users:read.email`, `im:write`, and `chat:write` bot scopes, shared team-wide. See Slack Notifications below |
| `SLACK_USER_EMAIL` | Ticket summary | Optional. Which email `--stage ticket-summary` looks you up by in Slack - falls back to `JIRA_EMAIL` if unset |
| `OUTPUT_DIR` | Excel Agent | Defaults to `output` |
| `RBP_API_BASE_URL` | Test Data via API (`src/api/testData/booking.ts`) | Defaults to the live public Restful-Booker-Platform instance |
| `RBP_AUTH_USERNAME` / `RBP_AUTH_PASSWORD` | Test Data via API | Dedicated test credentials, never a real application session |

Env vars are read lazily per-client, not all at once, so you only need to fill in the section for
whichever agent you're using.

## Multi-Tenant Foundations

Every CLI invocation resolves a tenant id and scopes data, credentials, and feature availability to
it. Running with no `--tenant`/`TENANT_ID` set (the case for every command shown elsewhere in this
README) resolves to the `default` tenant, behaving exactly as this pipeline always has - none of
this requires any config to use it single-tenant.

- **Tenant identity** (`src/pipeline/config/tenantContext.ts`) - `resolveTenantId()`: `--tenant`
  flag, then `TENANT_ID` env var, then `default`. Resolved once in `main()`, immediately after
  argv parsing and before any `--stage` handler runs, and validated against a filesystem-safe
  pattern (lowercase alphanumeric + hyphens, must start with a letter or digit) - a typo'd tenant
  id fails loudly instead of silently writing outside `data/`.
- **Data isolation** - every stage-generated file (`traceability/manifest.json`,
  `flaky/quarantine.json`, `healing/telemetry.jsonl`, `cost/telemetry.jsonl`, `cost/report.*`,
  `output/*.xlsx`, `output/tms-run-*.json`, etc.) lives under `data/<tenantId>/...`, routed through
  `tenantDataPath()` - the single choke point every tenant-scoped path in this pipeline resolves
  through, replacing the old bare top-level paths. **Elsewhere in this document**, a path like
  `traceability/manifest.json` or `output/tms-run-<key>.json` is shorthand for that file under the
  active tenant's root (`data/default/...` unless you've set `--tenant`/`TENANT_ID`); the literal
  `--file`/`--log` example commands below are written with the real `data/default/...` path so
  they work copy-pasted as-is.
- **Per-tenant credentials** (`resolveTenantEnv()`/`requireTenantEnv()`,
  `src/pipeline/config/env.ts`) - any `JIRA_*`/`QASE_*`/`SLACK_*` env var can be overridden for one
  tenant with a `<VAR>__<TENANT>` suffix (tenant id uppercased, hyphens become underscores - e.g.
  `JIRA_API_TOKEN__ACME_CORP` for tenant `acme-corp`). The override is checked first, falling back
  to the bare var, so every existing single-tenant `.env` keeps working with zero changes.
- **Per-tenant capability flags** (`config/tenants/<tenantId>.json`,
  `src/pipeline/config/capabilityStore.ts`) - admin-provisioned config, gating two independent
  things: which **integrations** a tenant has (Jira; a TMS - provider-agnostic, e.g. `qase` /
  `xray` / `zephyr`, resolved via `resolveTmsProvider()` ahead of the global `TMS_PROVIDER` env
  fallback; and notification channels, e.g. `slack`) and which **pipeline features** their plan
  includes (nine grouped capabilities - scenario generation, TMS upload, traceability, healing,
  flaky management, cost accounting, notifications, reporting, and Jira workflow actions -
  covering every real `--stage` value via an exhaustive map, enforced by `assertStageAllowed()`
  right after tenant resolution in `main()`). A missing file means full access - this is an
  opt-**out** model for narrower plans, not an opt-in lockdown, so an unprovisioned tenant
  (including `default`) is unaffected. The CI guardrail-check stages (Secrets, Forbidden
  Playwright Patterns, Required Test Tags, Scenario Quality, Traceability Coverage, Manifest
  Provenance, Spec File Consolidation, Assertion Integrity, Locator Priority) are never gated by
  this - they're universal policy enforcement on every PR, not a plan feature a tenant's plan
  could lack.
- **Known gap** - scenario/Playwright test generation itself happens via an interactive agent
  dispatch, not a `--stage` in `pipeline.ts`'s switch, so it has no hook this model gates yet.
  Deliberately deferred rather than solved speculatively, with only one tenant in play so far.
- **Onboarding a new tenant** - `docs/onboarding/internal-runbook.md` walks through the full
  process (choosing a tenant id, wiring per-tenant credentials, provisioning `scrum.json`/
  `capabilities.json`, verifying each integration actually works). `docs/onboarding/
  client-setup-guide.md` is the simpler version to hand a client's own IT/admin for the parts they
  need to do themselves (Jira access, Slack app creation, SMTP/email setup).

## Using the workflow

This is a conversation, not a script. Kick it off as a normal turn in a `claude` session, e.g.:

> run the test workflow for PROJ-123

The Planning Agent takes it from there: fetch the ticket (Jira Agent), explore the app and write
`specs/<feature>.plan.md`, hand scenarios to the Generator Agent to produce real Playwright specs,
write the sign-off sheet (Excel Agent) and **pause for your review**, then - once you confirm -
upload to the configured test management provider (TMS Agent), run and heal the specs (Healer
Agent), and report pass/fail back, filing Jira bugs and test management results for anything that
stays broken.

You can also drive or debug any single non-interactive stage directly:

```bash
npm run pipeline -- --stage jira              --issue PROJ-123
npm run pipeline -- --stage jira-transitions  --issue PROJ-123
npm run pipeline -- --stage jira-transition   --issue PROJ-123 --transition-id <id>
npm run pipeline -- --stage flag-requirement-gaps --issue PROJ-123 [--gaps-file <path to JSON string[]>]
npm run pipeline -- --stage approve-requirements  --issue PROJ-123
npm run pipeline -- --stage scenario-quality-check --spec specs/<feature>.plan.md
npm run pipeline -- --stage approve-scenarios     --issue PROJ-123
npm run pipeline -- --stage approve-test-cases    --issue PROJ-123
npm run pipeline -- --stage excel-write       --spec specs/<feature>.plan.md
npm run pipeline -- --stage excel-read        --file data/default/output/PROJ-123-<feature>-scenarios.xlsx
npm run pipeline -- --stage tms-upload        --file data/default/output/PROJ-123-<feature>-scenarios.xlsx
npm run pipeline -- --stage tms-submit-result --issue PROJ-123 --scenario-id <id> --status passed
npm run pipeline -- --stage traceability-record --spec specs/<feature>.plan.md
npm run pipeline -- --stage traceability-update-baseline --test-file tests/<group>/<scenario>.spec.ts [--test-title "<exact test name>"]
npm run pipeline -- --stage traceability-link --issue PROJ-123 --external-case-id <id> --test-file tests/<group>/<scenario>.spec.ts [--test-title "<exact test name>"]
npm run pipeline -- --stage traceability-accept-baseline --issue PROJ-123 --external-case-id <id> --test-file tests/<group>/<scenario>.spec.ts [--test-title "<exact test name>"]
npm run pipeline -- --stage traceability-unlink --issue PROJ-123 --external-case-id <id> --test-file tests/<group>/<scenario>.spec.ts [--test-title "<exact test name>"] [--force true]
npm run pipeline -- --stage rename-spec-file --test-file tests/<group>/<old-name>.spec.ts --new-path tests/<group>/<new-name>.spec.ts
npm run pipeline -- --stage traceability-coverage-check [--base-sha <sha>]
npm run pipeline -- --stage manifest-provenance-check [--base-sha <sha>]
npm run pipeline -- --stage drift-check
npm run pipeline -- --stage ticket-summary --issue PROJ-123
npm run pipeline -- --stage healing-record --test-file <path> --attempt <n> --outcome healed|escalated|passed_no_heal_needed [--category <category>] [--issue <jiraKey>] [--external-case-id <id>] [--duration-ms <ms>] [--test-title "<exact test name>"]
npm run pipeline -- --stage healing-report
npm run pipeline -- --stage flaky-record --test-file <path> --results fail,pass,fail [--issue <jiraKey>] [--external-case-id <id>] [--test-title "<exact test name>"]
npm run pipeline -- --stage flaky-clear --test-file <path> [--test-title "<exact test name>"]
npm run pipeline -- --stage flaky-report
npm run pipeline -- --stage prompt-version-report
npm run pipeline -- --stage assertion-check [--base-sha <sha>]
npm run pipeline -- --stage locator-check
npm run pipeline -- --stage cost-marker --agent <agent-name> --event start|end [--issue PROJ-123]
npm run pipeline -- --stage cost-record --log data/default/cost/raw/session-<timestamp>.log [--markers <path>]
npm run pipeline -- --stage cost-report [--issue PROJ-123]
```

`tms-upload` writes the run id and each scenario's external case id to a per-ticket
`data/default/output/tms-run-<jiraKey>.json` (e.g. `data/default/output/tms-run-kan-3.json`), not
one shared `tms-run.json` -
every ticket used to overwrite that same file, so uploading a second ticket silently clobbered the
first ticket's run/case mapping, leaving `tms-submit-result` unable to resolve it even though those
cases still existed in the TMS (`buildRunFilePath` in `runFilePath.ts`). `tms-submit-result` and
`traceability-record` resolve the right file automatically from `--issue` (or the spec's
`<!-- Jira: KEY -->` marker) - pass `--run-file <path>` explicitly only to override that.

`excel-write` names its output `<jiraKey>-<feature-slug>-scenarios.xlsx` (e.g.
`KAN-1-profile-subscriptions-scenarios.xlsx`), not a fixed `scenarios.xlsx` - every ticket used to
share that one generic filename, so writing a second ticket's scenarios silently overwrote
whatever sign-off sheet was already sitting there from the first (`buildScenarioFileName` in
`src/pipeline/excel/excelWriter.ts`). The exact path is printed by `excel-write` itself; pass that
same path to `excel-read`/`tms-upload` afterward.

**Deprecated aliases (still work, print a one-line warning):** `--stage qase-upload` →
`tms-upload`, `--stage qase-submit-result` → `tms-submit-result`, `--qase-case-id` →
`--external-case-id`. These exist so nothing broke when the provider abstraction landed; new call
sites should use the current names. `qase-submit-result` additionally still accepts
`--status invalid` (Qase's real vocabulary, dropped from the canonical `TmsResultStatus` - see
Test Management Provider Abstraction below) - it's translated to `--status blocked` plus a note
appended to the comment before it reaches the generic client.

Planning, generation, and healing aren't scriptable stages - they're interactive, agent-driven
work per `.claude/skills/playwright-cli/references/test-generation.md` sections 1-3, so just ask
for them in conversation (e.g. "plan the checkout feature", "generate scenario 1.2", "heal the
failing tests").

Type-check everything with `npm run typecheck`. Run the unit tests - traceability hashing, healing
telemetry, flaky-test quarantine, and the assertion integrity guardrail (Node's built-in test
runner, no separate test framework) - with `npm run test:unit`.

## Human Approval Gates

Three gates, all hard-enforced in code (`traceability/manifest.json`'s `workflow` array is the
source of truth - a prompt cannot talk an agent past them, they're checked against what's actually
on disk):

- **Gate 0 - requirement gap check.** Before generating any scenarios, the Planning Agent assesses
  whether the raw Jira ticket actually has enough detail to generate from without guessing at
  intent. Clear tickets clear the gate immediately and generation proceeds normally. Unclear ones
  get their specific gaps posted back as a comment on the ticket itself (`--stage
  flag-requirement-gaps`) and `--stage excel-write` refuses to run until either the ticket is
  updated and re-checked, or a human explicitly overrides via `--stage approve-requirements`. The
  principle: an agent's job is to make the human decision points explicit, not to eliminate them -
  including the decision of "is this requirement even clear enough to act on," which is easy to
  skip past silently if nothing ever checks for it.
- **Gate 1 - scenario approval.** After scenarios are generated from the (now-clear) requirement,
  a human reviews them before they're written to the Excel sign-off sheet (`--stage
  approve-scenarios`, enforced by `--stage excel-write`).
- **Gate 2 - test-case approval.** After the Excel Agent writes the sign-off sheet, a human reviews
  or edits it before it's uploaded to the test management provider (`--stage approve-test-cases`,
  enforced by `--stage tms-upload`).

The sign-off sheet a reviewer actually sees at Gates 1/2 has a short, human-facing **Case ID**
column (e.g. `KAN3-01`, `KAN3-02` - ticket-prefixed, sequential, assigned by
`assignDisplayIds()` in `excelWriter.ts`) alongside the real columns (Title, Precondition, Steps,
Expected Result, Priority, Suite). It exists purely so a reviewer isn't staring at
`should-open-my-profile-from-account-menu` as their only "ID" - it's not sent to the TMS and plays
no role in traceability; once uploaded, the provider's own case id (`externalCaseId`) is the real,
permanent identifier. Absent (blank) for scenarios read back from an older sign-off sheet written
before this column existed.

## Traceability

`traceability/manifest.json` tracks, per scenario, the link between a Jira ticket, its test
management case, and its generated test file, plus a content hash of each side (including which
provider that case lives in, `tmsProvider` - `externalCaseId` is a string since not every provider
uses numeric ids the way Qase does). This is a snapshot of the last *legitimately recorded* state,
not a live view:

- The TMS Agent's `tms-upload` automatically calls `traceability-record` right after uploading,
  which is the first point in the pipeline where a scenario's Jira ticket, external case, and test
  file are all linked at once (generation happens *before* case ids exist).
- The Healer Agent calls `traceability-update-baseline` after a legitimate fix, so a sanctioned
  heal doesn't look like drift later.
- `npm run drift:check` (or `--stage drift-check`) refetches every linked case, re-hashes
  every test file, and classifies each entry as `IN_SYNC` / `CASE_DRIFTED` / `TEST_DRIFTED` /
  `BOTH_DRIFTED` / `ORPHANED_CASE` / `ORPHANED_TEST` - this is what catches a case edited after
  the fact, or a test file hand-edited outside the pipeline. Case fetches run with up to
  `DRIFT_CHECK_CONCURRENCY` (default 5) in flight at once via `src/pipeline/shared/concurrency.ts`'s
  `mapWithConcurrency`, not one at a time - at a few dozen entries the difference doesn't matter,
  but the old one-at-a-time loop was a genuine multi-minute-plus bottleneck once a manifest reaches
  the thousands-of-entries range. It never overwrites a baseline hash itself, only
  `syncState`/`lastCheckedAt`; it writes `traceability/report.json` (full dump) and
  `traceability/report.md` (grouped summary), and posts one grouped Jira comment per ticket for
  anything that *newly* becomes `CASE_DRIFTED`/`BOTH_DRIFTED` (edge-triggered, so a daily CI run
  doesn't re-comment on the same unresolved drift every day). It never auto-regenerates anything.
- **Accepting a legitimate change as the new baseline:** drift isn't always a problem to fix - a
  case or test can change on purpose. `--stage traceability-accept-baseline --issue <KEY>
  --external-case-id <id> --test-file <path>` is the explicit human sign-off for that: it re-fetches
  the case and re-hashes the test file from their current live state and records that as the new
  `IN_SYNC` baseline, the same way the original generation flow would have. It's the same
  operation as `--stage traceability-link` (see above) under a second, intent-revealing name -
  `upsertEntry` replaces an existing `(jiraKey, externalCaseId, testFilePath, testTitle)` entry in
  place rather than duplicating it, so running this on an already-tracked, currently-drifted entry
  is a genuine "accept," not a re-registration.
- **Removing a stale entry:** `drift-check` reports a missing test file as `ORPHANED_TEST` and a
  missing TMS case as `ORPHANED_CASE`, but it only ever reports - nothing removes the stale entry
  itself. That's what `--stage traceability-unlink --issue <KEY> --external-case-id <id> --test-file
  <path> [--test-title "<exact test name>"] [--force true]` is for: a legitimate file
  reorganization (a scenario moved into a shared multi-test file, a test deleted outright, a case
  retired in the TMS) leaves behind an entry that will otherwise show up as orphaned forever. It
  requires the exact same four identifying fields as `traceability-link` - not just `--test-file` -
  so there's no ambiguity about which entry gets removed; a typo in any of them fails loudly instead
  of silently removing the wrong one or doing nothing. As a further safety check, it refuses to
  remove an entry whose `testFilePath` still exists on disk unless `--force true` is passed, since
  that's the one case most likely to be a mistake (a typo'd `--external-case-id`, or a file that's
  only temporarily missing) rather than the genuinely-stale case this command is for. Before this
  stage existed, the only way to remove a stale entry was hand-editing `traceability/manifest.json`
  directly - exactly the kind of ad hoc, unreviewable edit to the audit trail this pipeline's
  traceability model exists to prevent. The Manifest Provenance Guardrail below is this command's
  detection-side counterpart: it fails CI on any `traceability/manifest.json` change whose commit
  doesn't explain itself, catching a hand-edit even when someone skips this command entirely.
- **Renaming an already-generated spec file:** the file's *initial* name is a human decision made
  before generation ever runs - it's whatever the plan's **File:** line says (see
  `test-generation.md` Section 1.4), and that line is free text you edit like anything else in
  `specs/<feature>.plan.md` before approving Gate 1. This stage is for *afterward*: once a test
  already exists and is linked in the manifest, and you decide it should be named differently. Use
  `npm run traceability:rename -- --test-file tests/<group>/<old-name>.spec.ts --new-path
  tests/<group>/<new-name>.spec.ts` (or the raw `--stage rename-spec-file` form above) - it moves
  the file *and* updates every manifest entry pointing at it (a shared multi-test file can have
  more than one) in the same operation, so the two never drift apart the way they did the first
  time this was done by hand (`mv` the file, forget the manifest, CI catches it days later as an
  "unlinked" test). It refuses to run if no manifest entry points at the old path at all - a
  never-linked file just needs a plain `git mv`. Content is untouched by a rename, so it never
  touches `testContentHash`. Like every other stage here, it only touches files on disk; you still
  `git add` and commit the result yourself, with a `Traceability-Stage: rename-spec-file` trailer
  (the stage's own console output prints the exact command) so the Manifest Provenance Guardrail
  passes.
- **Multiple scenarios sharing one spec file:** a spec file can group several scenarios under one
  `test.describe`, each its own `test(...)` (see `src/pipeline/shared/testBlocks.ts`) instead of
  the older one-file-per-scenario convention. Each scenario still gets its own traceability entry,
  hash, and healing/flaky tracking, keyed by `testTitle` in addition to `testFilePath` - editing one
  scenario in a shared file never registers as drift, or gets healed/quarantined, for its siblings.
  A file with only one test needs nothing extra; a file with more than one needs a `// scenario-id:
  <id>` comment directly above each `test(...)` so the pipeline can tell them apart (only used by
  the automated spec-driven flow - the manual `--test-file`-based stages above use `--test-title
  "<exact test name>"` instead, since they have no spec/scenario-id context to draw from).
- `.github/workflows/drift-check.yml` runs `drift:check` daily and on manual dispatch, uploads
  `manifest.json`/`report.json`/`report.md` as a build artifact, and commits them back to `master`.
  - **Commits via a dedicated GitHub App, not the default `GITHUB_TOKEN`.** This repo requires all
    changes to `master` go through a PR, and the default token can neither push directly nor open a
    PR itself ("Allow GitHub Actions to create and approve pull requests" is locked at the
    organization level, outside repo-admin control). A narrowly-scoped App (`Contents: read/write`
    only) is installed on the repo and added to the ruleset's bypass list instead - it doesn't ask
    Actions to open a PR at all, so that locked setting doesn't apply to it. The workflow mints a
    short-lived token from it via `actions/create-github-app-token`, checks out with that token,
    and commits/pushes directly, same as before the ruleset existed. Needs `APP_ID` and
    `APP_PRIVATE_KEY` configured as **GitHub Actions repository secrets** (App ID and the
    downloaded `.pem` private key from the App's own settings page).
  - Needs `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_PROJECT_KEY`, `QASE_API_TOKEN`, and
    `QASE_PROJECT_CODE` configured as **GitHub Actions repository secrets** (same values as your
    `.env`, which isn't committed) - the workflow won't run without them.
  - **Posts to Slack too**, via `DRIFT_CHECK_SLACK_WEBHOOK_URL` - a **separate** webhook/channel
    from `SLACK_WEBHOOK_URL` (pipeline health report's), by design, since drift alerts and the
    general health heartbeat are different audiences. Same fire-and-log-never-throw behavior
    (`src/pipeline/traceability/slackNotify.ts` - all-clear vs out-of-sync-count headline, every
    sync state's count, which Jira tickets (if any) got a new drift comment this run). Links to
    the self-hosted `traceability/report.html` on the same Pages site as the dashboard (reuses
    `PIPELINE_REPORT_PUBLIC_URL`, no separate URL to configure) - that specific page is only
    regenerated when `pipeline-report.yml` next runs (15 minutes later on the shared daily
    schedule), so it can be briefly stale immediately after this workflow posts.
- `npm run backfill:manifest` is a one-time seed for scenarios that already existed before this
  feature; new scenarios are recorded automatically by the hooks above.
- `npm run backfill:test-titles` is a one-time backfill for the `testTitle` field added to
  traceability entries / healing events / flaky events / quarantine entries for multi-test-per-file
  support (grouping several scenarios under one `test.describe` in a shared spec file - see
  `src/pipeline/shared/testBlocks.ts`). Dry-run by default (prints what it would change); pass
  `--apply` to write. Deterministic-only: a `testFilePath` that resolves to exactly one `test(...)`
  is backfilled automatically (every file predating this feature), one that resolves to zero or
  more than one is left alone and reported as unresolved rather than guessed. Already-set
  `testTitle` fields are skipped, so it's safe to re-run after manually resolving anything flagged.

## Team Usage

This pipeline works the same way for one person or several - each stage is already keyed by
`jiraKey`, and gates are per-ticket, not per-user. Running it with a team just needs a few
conventions on top, since nothing here provides real-time locking:

- **Everyone needs their own credentials, not shared ones.** Each person's own `.env` should have
  their own `JIRA_EMAIL`/`JIRA_API_TOKEN`, their own `QASE_API_TOKEN`, and - separately - their own
  dedicated `APP_TEST_USERNAME`/`APP_TEST_PASSWORD` test account on the app under test (see
  "Application under test" note in `.env.example`). Sharing the Jira/Qase tokens breaks
  attribution (comments and uploads all appear to come from one person); sharing the app test
  account means concurrent runs authenticate as the same session and can interfere with each
  other, and will corrupt shared state the moment a test mutates data (buys/cancels/edits
  something) rather than just reading it. CI (Jenkins or GitHub Actions) should get its own
  dedicated test account too, distinct from any team member's.
- **Gate approvals are attributed, so you can see who did what.** `requirementsClearedBy` /
  `scenariosApprovedBy` / `testCasesApprovedBy` are recorded alongside the existing `...At`
  timestamps in `traceability/manifest.json`, sourced from `PIPELINE_OPERATOR` (falling back to
  `JIRA_EMAIL` - see `src/pipeline/config/teamConfig.ts`'s `resolveOperator()`). Before starting
  work on a ticket, check whether it already has a workflow record in the manifest - if
  `requirementsClearedAt` is already set, someone's likely already on it. There's no enforced lock
  preventing two people picking up the same key, just this visibility.
- **Decide your own policy on self-approval.** The code enforces *that* Gates 1/2 were approved by
  someone, not *who* - it doesn't currently stop the person who generated the scenarios from also
  approving them. If you want a second-reviewer requirement (same reasoning as not self-merging
  your own PR), that's a team convention to adopt, not something this pipeline blocks for you yet.
- **A test automated outside the normal flow entirely is caught, not just self-approval within
  it.** Someone hand-writing and automating a test directly (against an existing TMS case, or none
  at all), or a manually-created TMS case that later gets automated, both leave a test with no
  `traceability/manifest.json` entry - invisible to `drift-check`, not just unreviewed. The
  Traceability Coverage Guardrail (see its own section below) flags this at PR time on any newly
  added test file; `--stage traceability-link` is the remediation command that registers it
  without needing a spec file or a `tms-upload` run record.
- **`traceability/manifest.json` and the cost/healing/flaky telemetry files will conflict when two
  people push around the same time**, since they're shared, committed, append-style JSON. Resolve
  these by keeping *both* sides' entries, not by blindly accepting one branch's version wholesale -
  unlike `pipelineReport/report.html`'s auto-generated timestamp line (where either side is
  genuinely fine to pick), losing a whole side here means losing another person's real workflow or
  case data.
- **Slack posts are CI-only by default** (`SLACK_NOTIFY_LOCAL`, see the Setup table above) -
  otherwise every team member's local `pipeline:report`/`drift:check` run before pushing would post
  to the same shared channel, and the signal stops meaning "the scheduled run's result" fast.

## Healing Telemetry

`healing/telemetry.jsonl` is an append-only event log - one JSON object per line, never rewritten
- recording every terminal outcome the Healer Agent reaches: `healed`, `escalated`, or
`passed_no_heal_needed`. It's history, not current state, so unlike the traceability manifest
there's nothing to overwrite; each pipeline run only ever adds lines.

- **Recording is final-outcome-only, not per-attempt.** One event per test, fired once it reaches
  a terminal state; `attemptNumber` records how many fix attempts it took (0 for
  `passed_no_heal_needed`, since no fix attempt was made). This was an open call in the spec,
  resolved this way because the outcome enum has no value for an interim failed attempt still
  being retried, and the Healer's retry bound was a soft prose constraint, not a formally numbered
  loop - attempt-level recording would've needed a 4th outcome value and a more invasive rewrite of
  already-working instructions.
- The Healer Agent classifies every failure into one of five categories
  (`locator_drift` / `ui_restructure` / `copy_change` / `real_regression` / `environment_issue`) as
  part of its existing diagnosis, then calls `healing-record` in the same operation as whichever
  terminal branch it's in: right after `traceability-update-baseline` for a legitimate heal, right
  after marking `test.fixme` for an escalation, or directly for a test that already passed with no
  fix needed. `jiraKey`/`externalCaseId` are looked up from `traceability/manifest.json` when
  available and omitted otherwise - both are optional on the event.
- `suite` is derived mechanically from the test file's path (first directory under `tests/`,
  `src/pipeline/telemetry/suite.ts`) - never typed by the agent.
- `npm run healing:report` (or `--stage healing-report`) reads the whole log and computes the
  overall healing rate (`healed / (healed + escalated)`), a category breakdown per suite per week
  (as a percentage of *categorized* events - `passed_no_heal_needed` has no category and is
  excluded from that denominator so it doesn't dilute it), week-over-week healing-rate trend per
  suite (real ISO 8601 weeks, Monday-start), and average attempts-to-heal. Writes
  `healing/report.json` (structured) and `healing/report.md` (human-readable), same dual-output
  pattern as the Traceability Agent.
- `.github/workflows/healing-report.yml` runs `healing:report` weekly (Monday) and on manual
  dispatch, and uploads `report.md` as a build artifact. No commit-back step and no secrets needed
  - the JSONL log is the real source of truth, appended to by real pipeline runs over time, and
  this job only ever reads it.
- The log will grow indefinitely; monthly rotation (`healing/telemetry-2026-08.jsonl`) is a
  reasonable future improvement once it's actually large enough to matter, not built preemptively.

## Flaky Test Quarantine

Genuinely separate from Healing Telemetry above, not another category folded into it. The
Healer's `environment_issue` failure category is a single-pass judgement call made *during*
diagnosis; flaky quarantine only fires on **actual evidence** - a test observed producing
different results across multiple runs with nothing changed. Detection is a custom rerun loop the
Healer drives itself (`npx playwright test <file>` run repeatedly, same mechanism locally and in
CI), not Playwright's native `retries`/flaky reporting - `playwright.config.ts` is untouched by
this feature.

- **`FLAKY_RERUN_COUNT`** (default 2, documented convention, same as `HEALER_MAX_ATTEMPTS` -
  neither is an enforced env var, both are prose bounds the Healer Agent follows): before
  diagnosing any failure, the Healer reruns the same test file, unmodified, this many more times
  (3 total observations including the original failure), one at a time, never in parallel, then
  calls `flaky-record` with the ordered results. See `.claude/agents/healer-agent.md` step 2.
- `npm run pipeline -- --stage flaky-record --test-file <path> --results fail,pass,fail [--issue <jiraKey>] [--external-case-id <id>] [--test-title "<exact test name>"]`
  parses the ordered results and calls the one piece of real decision logic in this feature,
  `decideFlaky()` (`src/pipeline/flaky/evaluateFlakiness.ts` - true unless every result is identical, pure,
  no I/O). Not flaky: prints that plainly and exits 0 with no side effects - the signal telling the
  Healer to proceed to normal diagnosis. Flaky: appends a `quarantined` event to
  `flaky/telemetry.jsonl`, upserts `flaky/quarantine.json`, and prints an instruction to tag the
  test's title with **`@quarantined`** - the stage never edits the test file itself, same split as
  `test.fixme()` in the Healer's escalation path. A quarantined failure never calls
  `healing-record` - it never entered the healing flow.
- **`--grep-invert @quarantined`** excludes quarantined tests from real runs, reusing the
  `@smoke`/`@regression`/`@critical` tag convention from `CLAUDE.md`. Currently added in exactly
  one place: `.claude/agents/healer-agent.md` step 1's discovery command
  (`npx playwright test --grep-invert @quarantined`). There is no CI workflow that runs the full
  suite yet (`.github/workflows/` only has drift-check, healing-report, assertion-integrity, and
  locator-priority) - add the same flag to any future workflow that runs the suite for real
  results.
- **Un-quarantining is manual and human-gated - nothing clears a quarantine automatically.** A
  human investigates the real cause, confirms stability by rerunning manually, removes the
  `@quarantined` tag from the test's title themselves, then runs
  `npm run pipeline -- --stage flaky-clear --test-file <path>`, which removes the entry from
  `flaky/quarantine.json` and appends a `cleared` event to `flaky/telemetry.jsonl` (reusing the
  evidence that originally justified the quarantine). Same shape as the human sign-off gate on the
  Excel review sheet elsewhere in this pipeline.
- Submitting a test management result for a quarantined test uses the existing `TmsResultStatus`
  value `'skipped'` with a comment referencing the quarantine
  (`'Quarantined as flaky - see flaky/quarantine.json'`) - no new status was added for this; see
  `.claude/agents/tms-agent.md`.
- Three files under `flaky/` (parallel to `healing/`'s telemetry/report split):
  - `flaky/telemetry.jsonl` - append-only event log, one JSON object per line, `quarantined` or
    `cleared` action per event, never rewritten (`src/pipeline/flaky/recordFlakyEvent.ts`).
  - `flaky/quarantine.json` - current-state snapshot of active quarantines only, keyed by
    `testFilePath` (`src/pipeline/flaky/quarantineStore.ts`) - same pattern as
    `traceability/manifest.json`, not an event log.
  - `flaky/report.json` / `flaky/report.md` - written by
    `npm run flaky:report` (or `--stage flaky-report`, `src/pipeline/flaky/flakyReport.ts`): total
    quarantined all-time, currently active (cross-referenced against `flaky/quarantine.json`, since
    a cleared entry no longer counts), a breakdown of currently-active quarantines by suite, and
    the average number of runs it took to detect flakiness across all-time quarantine events. Same
    dual-output convention as `healing/report.json`/`.md`.

## Prompt Versioning

A changelog per agent prompt file, so edits to `.claude/agents/*.md` are visible and confirmed to
actually get captured. This is a **pure git-log-derived report** - no custom hash-store, no
`version:` frontmatter field, no `promptVersions/manifest.json` content-hash system like
traceability's. Git already fully captures every edit to these files (SHA, author, timestamp,
message, diff) for free; the only real work is turning `git log` into a readable per-agent
changelog. `src/pipeline/promptVersions/`:

- **Scope: `.claude/agents/*.md` only** - the six pipeline agents (`jira-agent`, `planning-agent`,
  `excel-agent`, `tms-agent`, `generator-agent`, `healer-agent`). Not
  `.claude/skills/playwright-cli/references/*.md`, even though those also shape behavior - out of
  scope for this feature.
- `gitLog.ts` runs `git log --follow --numstat -- <path>` **once per agent file** via
  `execFileSync` (never a shell string, to avoid shell-injection risk on file paths, and never
  once against the whole `.claude/agents/` directory, which breaks rename-following). Never calls
  `git fetch`/`git pull` - only local refs/objects already in `.git/` are needed, and network
  calls have failed before in this sandboxed context (`could not read Username for
  'https://github.com'`). The parsing itself (`parseGitLogOutput`) is a pure function tested
  against fixture `git log` output, not just live against the real repo - it's the one piece of
  real logic in this feature.
- **A real gotcha, confirmed against this repo's actual history, not hypothetical**: one agent
  file was already renamed mid-project, `qase-agent.md` -> `tms-agent.md` (during the generic-TMS-
  provider work). Plain `git log --follow` still **misses this rename** even with `--follow`
  present, because git's rename detection defaults to a 50% similarity threshold and this rename
  rewrote most of the file's content along with renaming it - confirmed empirically at ~20-25%
  similarity (`git diff -M<pct>%` against the real commits). `gitLog.ts` passes an explicit
  `-M20%` to `git log --follow` for exactly this reason; without it, `tms-agent.md`'s changelog
  would silently stop at the rename and lose everything before it.
- `buildChangelog.ts` groups commits under each agent's **current** filename - `tms-agent.md`'s
  changelog includes its `qase-agent.md`-era commits, newest first, because `--follow` is already
  called against the current path.
- `report.ts` writes `promptVersions/report.json` and `promptVersions/report.md`, same dual-output
  convention as `healing/report.md`/`flaky/report.md`/`cost/report.md` - one `##` section per
  agent, a table of commits (short SHA, date, author, message, +ins/-del), newest first. No full
  diffs embedded; run `git show <sha> -- <path>` yourself for one. Unlike the telemetry-based
  reports, there's no append-only log to accumulate - git already is the log, so this regenerates
  fully from current history on every run.
- `npm run prompt-versions:report` (or `--stage prompt-version-report`).
- `.github/workflows/prompt-versions-report.yml` triggers on push to `.claude/agents/**` (plus
  manual dispatch), not on a schedule like drift-check/healing-report, and commits the regenerated
  report back with `[skip ci]`. **Critical, easy to miss**: `actions/checkout@v4` defaults to
  `fetch-depth: 1` (shallow clone) - `git log --follow` against a shallow clone sees almost
  nothing, so the checkout step sets `fetch-depth: 0` explicitly. Whoever next touches this
  workflow: don't remove that, or the report silently degrades to one commit per agent on every
  run.

## Assertion Integrity Guardrail

Unlike Traceability and Healing Telemetry, this is a **blocking CI gate**, not an informational
report: it fails the build if a pull request deletes or weakens a test assertion in
`tests/**/*.spec.ts` without an explicit, justified sign-off. It's AST-based (`ts-morph`), not
text diffing - `src/pipeline/assertionGuard/`:

- `astDiff.ts` - parses old (`git show <base-sha>:<path>`) and new (working tree) content into
  test blocks, matches tests old-to-new by title (unmatched titles are new/renamed tests, out of
  scope), and compares matched pairs for: total assertion count decreased; a **strict** matcher on
  a given locator/subject no longer present anywhere in the new version for that subject; a newly
  bare `test.skip`; a new `test.fixme` with no comment on the same/preceding line (bundled in as a
  rule-completeness check - `test.fixme` itself is fine, it's the sanctioned Healer escalation
  path); an assertion newly wrapped in a `try`/`catch` or `.catch()` that would swallow a failure.
- `matcherClassification.ts` - the strict/weak table, confirmed against the real distribution in
  the suite at build time (not guessed):

  | Strict | Weak |
  |---|---|
  | `toHaveText`, `toHaveValue`, `toContainText`, `toHaveCount`, `toBeChecked`, `toHaveURL`, `toHaveAttribute`, `toBe` | `toBeVisible`, `toBeAttached`, `toBeInViewport`, `toBeEnabled`, `toBeGreaterThan`, `toBeEmpty` |

- `suppression.ts` - the override: an inline comment on the line *immediately* preceding a flagged
  change (not two lines above, not "nearby") clears it:

  ```typescript
  // assertion-integrity: approved — <reason>
  await expect(page.getByTestId('refund-status')).toBeVisible();
  ```

  A reason is required - the bare tag alone doesn't match, so a suppression can't be copy-pasted
  without a real justification landing in git blame. It's deliberately scoped so **one comment can
  never suppress a whole file**: line-anchored findings need the comment on that exact line;
  a fully *deleted* assertion has no surviving line to anchor to, so it falls back to test-scoped
  (comment anywhere in that one test's body) - never file-wide.
- `checkAssertionIntegrity.ts` - the orchestrator and CLI entry point (`--stage assertion-check
  [--base-sha <sha>]`). Without `--base-sha`, it reads `pull_request.base.sha` from the event JSON
  at `GITHUB_EVENT_PATH` (how CI invokes it); pass `--base-sha` explicitly to run it locally against
  any commit.
- `.github/workflows/assertion-integrity.yml` runs on every `pull_request`, with **no `paths:`
  filter** - deliberately. GitHub Actions has a trap where a *required* status check that's
  path-filtered never reports any status on PRs that don't touch those paths, and branch protection
  then blocks those PRs forever waiting on a check that will never run. The job always runs instead;
  `checkAssertionIntegrity.ts` itself no-ops (0 findings, exit 0) when no spec files changed, so the
  practical effect is the same without the blocking-forever risk.
- **To actually make this a required check**, add it in your repo's Settings → Branches → branch
  protection rule → "Require status checks to pass" → select "assertion-integrity" once the
  workflow has run at least once on this repo (a GitHub branch-protection setting, not something a
  workflow file can set on its own).

## Locator Priority Guardrail

Mechanically enforces `CLAUDE.md`'s locator priority (`getByRole` > `getByLabel` > `getByTestId` >
`getByText`, CSS/XPath forbidden unless approved) - specifically the part of that rule a static
check *can* reliably enforce. It cannot reliably enforce "always pick the *best* of the four
allowed methods" (that needs the live app's DOM/ARIA structure, which a `.ts` file doesn't
contain) - that stays a human/agent judgment call, same as today. `src/pipeline/locatorGuard/`:

- **A real, previously-invisible bug got fixed alongside this**: `playwright.config.ts` had no
  `use.testIdAttribute` override, so Playwright was silently matching its default `data-testid`
  while `CLAUDE.md` specifies `data-test-id` (hyphenated) - meaning every `getByTestId()` call in
  the suite could have silently matched nothing. Fixed independently of the lint rule itself.
- `detectLocatorViolations.ts` flags `.locator(...)` and `page.$`/`$$`/`$eval`/`$$eval` calls
  **unconditionally**, matched by method name alone regardless of receiver or argument content -
  deliberately not trying to detect "does this string look like CSS", since that produces false
  negatives on selectors that don't look CSS-like but are. This accepts a false-positive risk
  (some unrelated object's same-named method) as the tradeoff for zero false negatives, the same
  philosophy the Assertion Integrity Guardrail uses for matching `expect(...)`.
- `checkLocatorPriority.ts` scans `LOCATOR_SCAN_ROOTS` - `src/ui/pages/**/*.ts` (locators'
  documented home, per the Page Object contract) **and** `tests/**/*.spec.ts` (recursive, so it
  covers `tests/ui`, `tests/api`, and anything added later without a code change) - confirmed from
  the real codebase that at least one spec file builds a locator directly, bypassing a page object,
  so scoping to page objects alone would have missed real cases. The scan roots are a single
  exported list rather than inlined literals, specifically so a future addition (e.g. `src/api/clients`,
  if API automation ever grows a UI-adjacent helper) is a one-line extension, not a hunt through the
  file. Unlike the Assertion Integrity Guardrail, this isn't a diff: a `.locator()` call either
  exists in the file right now or it doesn't, so there's no old/new comparison or `git show`
  involved - `npm run locator-check` (or `--stage locator-check`) just re-scans the whole tree
  every time.
- Suppression reuses the Assertion Integrity Guardrail's exact convention (line immediately above,
  reason required) rather than inventing a second pattern - generalized into
  `src/pipeline/shared/suppressionComment.ts` and parameterized by tag:

  ```typescript
  // locator-priority: approved — <reason>
  this.table = page.locator('.legacy-widget');
  ```

  A `locator-priority:` comment doesn't clear an `assertion-integrity:` finding or vice versa -
  confirmed with a test, not just assumed.
- `.github/workflows/locator-priority.yml` is its **own workflow file**, not an extra step in
  `assertion-integrity.yml` - GitHub treats each job as its own status check regardless of which
  workflow file it lives in, so combining them wouldn't reduce anything to configure, and this
  repo's own convention is already one file per check (`drift-check.yml` and `healing-report.yml`
  are two files despite being the same "informational" category). No `paths:` filter, same
  blocks-forever trap avoidance as `assertion-integrity.yml`. Needs the same manual step to
  actually become a *required* check in Settings → Branches.

**Why this is a `ts-morph` script and not a real ESLint rule, despite the initial lean toward
ESLint:** `@typescript-eslint/parser` has a hard runtime guard that refuses to run at all on this
project's `typescript@7.0.2` - not a peer-dependency version mismatch bypassable with
`--legacy-peer-deps`, an intentional block (confirmed empirically, not just from registry
metadata), with the whole ecosystem currently unable to parse TS 7 at all (tracked upstream:
`typescript-eslint/typescript-eslint#10940`). The only documented workaround is running a second,
separate TypeScript 6.x install side-by-side just for linting - real ongoing complexity, not a
small addition. Given that, the `ts-morph` script reuses tooling already proven compatible with
`typescript@7.0.2` by the Assertion Integrity Guardrail, and ships today.

## Scenario Quality Guardrail

Unlike the other three guardrails, this one runs **before any test file exists** - against the
scenarios in `specs/<feature>.plan.md`, right after generation and before a human is ever shown
them at Gate 1 (see `planning-agent.md`'s Gate 1 instructions). It exists because manual test case
quality was slipping through: real generated output had scenarios with a single step doing four
things at once, expected results crammed into one semicolon-chained sentence, preconditions copied
verbatim across every scenario in a spec ("User logged into the web portal" with no mention of what
data/subscription state that implies), and titles that repeated the same words between their
category prefix and the rest ("Student Login: Should Log In Successfully"). `src/pipeline/scenarioGuard/`:

- **Fully deterministic - no LLM, no model call.** Every check is plain string/regex logic against
  the parsed `Scenario[]` (`checkScenarioQuality.ts` calls `parseScenariosFromSpec` from the same
  `specParser.ts` the Excel Agent uses, so it's checking exactly what would be written to the
  sign-off sheet). `scenarioQualityRules.ts` holds the individual rule functions.
- **Blocking checks:** empty/malformed/duplicate scenario IDs; empty/duplicate titles, and titles
  that repeat words between their category prefix and the rest; empty, too-short, or
  copy-pasted-identical-across-every-scenario preconditions; steps that bundle multiple actions
  (multiple "and"/commas, or just long) into one step, or a single-step scenario whose expected
  result implies a multi-step flow; missing expected results, or ones with too many
  semicolon-chained clauses; every scenario in a spec sharing the same priority; vague,
  unobservable language ("works correctly", "successfully") in place of a concrete criterion;
  implementation details (locator syntax, SQL, raw HTTP paths, `data-test-id`) leaking into
  tester-facing text; and a scenario sharing zero keywords with the source Jira ticket's
  summary/description (word-relatedness uses simple prefix matching - `wordsRelated()` in
  `scenarioQualityRules.ts` - so e.g. "login" and "log", or "cancel" and "cancellation", still
  count as related without a real stemming library).
- **Warn-only checks** (heuristic, not treated as blocking - see the finding's `severity`):
  specific numeric/time/currency values that don't appear anywhere in the ticket text (possible
  invented business rule) and pairs of scenarios in the same spec with high word overlap (possible
  duplicate coverage). Both use plain word-overlap comparisons, not real semantic understanding, so
  false positives are expected - they're meant to prompt a second look during human review, not
  block progress on their own.
- Ticket-aware checks (traceability-to-ticket, invented-business-rule) need the source ticket's
  text, fetched via `jira.getIssue()` at check time. If that fetch fails (offline, ticket already
  moved, etc.) those two checks are skipped and the report says so explicitly - every other check
  still runs regardless, since none of them need network access.
- `npm run pipeline -- --stage scenario-quality-check --spec specs/<feature>.plan.md` - the
  Planning Agent runs this automatically before presenting scenarios at Gate 1 (fixing any blocking
  finding itself first); it can also be run manually against any spec file at any time.

## Traceability Coverage Guardrail

A **blocking CI gate**, same category as the Assertion Integrity and Locator Priority guardrails
above (a PR-time check on committed test files - unlike the Scenario Quality Guardrail just above,
which runs earlier, on scenarios, before any test file exists), for a different failure mode: a
test that was automated **outside** the normal Jira → scenarios → tms-upload → traceability-record
flow entirely, rather than a weakened assertion or a bad locator in something that did go through it.
Two real scenarios this catches: someone hand-writes and automates a test directly (against an
existing test-management case, or none at all), or a test case created manually in the TMS later
gets automated - both leave a test file with no entry in `traceability/manifest.json`, which means
`drift-check` never sees it; it's not "unchecked," it's structurally invisible. `src/pipeline/traceabilityGuard/`:

- `checkTraceabilityCoverage.ts` - finds **newly added** `tests/**/*.spec.ts` files in the PR
  (`git diff --diff-filter=A` against the base SHA - added only, not every changed file, so a
  pre-existing untracked file doesn't suddenly fail CI on an unrelated edit to it) and flags any
  `test(...)` inside them with no matching `(testFilePath, testTitle)` in
  `traceability/manifest.json`'s `entries` - per-test, not per-file, so a shared multi-test file
  with one unlinked scenario only flags that one, not its already-linked siblings. An entry with no
  `testTitle` (pre-migration, see the Multiple scenarios sharing one spec file note above) is
  treated as covering the whole file, same as this check's original all-or-nothing behavior.
- Suppression: `// traceability-coverage: approved — <reason>` anywhere in the file - file-scoped
  (suppresses every unlinked test in it), not per-test, since a human adding this comment is making
  one deliberate exemption call for the whole file. Use it for deliberately-standalone files never
  meant to go through the TMS (e.g. `tests/test-data-demo/`'s proof-of-concept spec).
- **The actual remediation command**, not just a report: `npm run pipeline -- --stage
  traceability-link --issue <KEY> --external-case-id <id> --test-file <path> [--test-title "<exact
  test name>"]` (`--test-title` only needed when the file has more than one test). Unlike `--stage
  traceability-record`, it needs no spec file and no `tms-upload` run record - just the three
  things that already exist in both bypass scenarios above (the Jira key, the TMS case id, the
  already-written test file). It fetches the case, hashes just that scenario's block the same way
  `buildEntriesForSpec` would have, and writes an `IN_SYNC` baseline entry - from that point on
  `drift-check` treats it exactly like a pipeline-generated entry.
- `.github/workflows/traceability-coverage.yml` - same no-`paths:`-filter, always-runs-and-no-ops
  pattern as the other two guardrail workflows, for the same blocks-forever-on-unrelated-PRs
  reason. Needs the same manual step to become a *required* check in Settings → Branches.

## Manifest Provenance Guardrail

A **blocking CI gate**, same category as the three guardrails above, for the opposite failure mode
from Traceability Coverage: not a test that's missing from `traceability/manifest.json`, but an
*unexplained edit* to the file itself - most often a hand-edit made outside every real
`traceability-*` stage (the exact workaround `--stage traceability-unlink` above exists to replace).
`traceability/manifest.json` is this pipeline's audit trail; `drift-check` and every `traceability-*`
stage trust its contents, so a change nobody can account for is a real integrity risk, not just messy
history. `src/pipeline/traceabilityGuard/checkManifestProvenance.ts`:

- Only activates when `traceability/manifest.json` actually changed in the PR (`git diff
  --name-only` against the base SHA) - a PR that doesn't touch the file passes trivially.
- When it did change, reads every commit in the PR's range (`git log <base>..HEAD`) and requires
  **at least one** commit message to carry a recognized marker (not every commit - in practice a
  manifest change is committed together with the feature work that caused it, in one descriptive
  commit, not a separate stage-only commit):
  - `Traceability-Stage: <stage>` - `<stage>` must be one of `traceability-record`,
    `traceability-link`, `traceability-unlink`, `traceability-accept-baseline`,
    `traceability-update-baseline`, `drift-check`, `rename-spec-file` exactly (an explicit
    allowlist, not a `traceability-*` pattern match, so a new stage needs a deliberate one-line
    addition here).
  - `Traceability-Manual: <reason>` - for a genuinely deliberate, reviewed hand-edit (e.g. a
    one-time data migration); requires a non-empty reason, same "state why, don't just suppress"
    shape as the `// <rule-tag>: approved — <reason>` convention used elsewhere in this pipeline,
    adapted to a commit message since JSON has nowhere to put an inline comment.
- Fix on failure: `git commit --amend` the offending commit to add one of the two lines above, then
  force-push.
- `.github/workflows/manifest-provenance-check.yml` - same no-`paths:`-filter,
  always-runs-and-no-ops pattern as the other guardrail workflows. Needs the same manual step to
  become a *required* check in Settings → Branches - **do this only after** any already-open PR that
  touches `traceability/manifest.json` has either merged or had its commit message amended with a
  marker, since this check applies retroactively to whatever's already in flight, not just new work.

## Spec File Consolidation Guardrail

A **blocking CI gate**, same category as the four guardrails above, for the multi-test-per-file
default itself: a Jira ticket's scenarios default to one shared spec file
(test-generation.md Section 1.4), generated together as sibling `test.describe` blocks. Ending up
with more than one file for one ticket is the exception, not the default shape - this guardrail
requires a stated reason on record whenever that happens, the same "state why, don't just suppress"
shape every other guardrail in this pipeline already uses.

**Why this one matters beyond this project's own agents:** unlike a prompt instruction in
`generator-agent.md` or `test-generation.md`, which only binds whichever tool actually reads those
files, this check reads `traceability/manifest.json` and PR commit history - the same audit trail
Traceability Coverage and Manifest Provenance already trust. It has no idea, and does not care,
whether a test file was generated by this project's own Generator Agent, by a teammate's
Antigravity/Gemini session, or written by hand. A `(jiraKey, testFilePath)` pair in the manifest is
a `(jiraKey, testFilePath)` pair regardless of its origin, so a PR from any tool is judged by the
identical rule - this is the practical answer to "how do we make Antigravity/Gemini follow the same
rules Claude does" for this specific behaviour: not by asking the other tool to read this project's
instructions (it may not, and there's no way to verify it did), but by blocking the PR itself if the
outcome doesn't match the rule, no matter who produced it. `src/pipeline/traceabilityGuard/checkSpecFileConsolidation.ts`:

- Snapshots every jiraKey's distinct `testFilePath` set in `traceability/manifest.json` twice -
  once at the PR's base SHA (`git show <base-sha>:traceability/manifest.json`), once at `HEAD` - and
  flags a jiraKey only when **this PR is the one that grows it** past one file (i.e. `HEAD` has more
  than one distinct file *and* introduces at least one that wasn't already there at the base SHA).
  Without that "grew" condition, every later PR that adds one more scenario to an
  already-split-and-already-explained ticket's existing files would be flagged again for a decision
  that was already made once.
- When a jiraKey is flagged, reads every commit in the PR's range (`git log <base>..HEAD`) and
  requires **at least one** commit message to carry, for that specific jiraKey:
  - `Spec-File-Split: <KEY>: <reason>` - colon-delimited rather than a dash, so a literal hyphen
    inside the reason text can never be mistaken for the field separator. A marker naming a
    different jiraKey than the one that's actually split doesn't count - same no-fuzzy-matching
    contract `findEntry`/`removeEntry` already hold themselves to elsewhere in this codebase.
  - A PR that splits more than one ticket needs its own marker for each - explaining one doesn't
    cover a sibling.
- Fix on failure: `git commit --amend` the offending commit to add the marker, then force-push.
  Example in the check's own failure report.
- `.github/workflows/spec-file-consolidation-check.yml` - same no-`paths:`-filter,
  always-runs-and-no-ops pattern as the other guardrail workflows. Needs the same manual step to
  become a *required* check in Settings → Branches.

## Policy-Driven Guardrails

Three more **blocking CI gates**, `src/pipeline/policyGuard/`, for the deterministic subset of
`AGENTS.md`'s rules (forbidden Playwright patterns, required test tags, forbidden committed
filenames). Unlike the five guardrails above, these don't hardcode their rules in TypeScript - they
read `policy.json` at the repo root, validated by `PolicySchema`
(`src/pipeline/types/schemas.ts`) via `loadPolicy()` (`src/pipeline/config/policyStore.ts`). The
point: adding "also forbid `id_rsa`" or "also require `@nightly`" is a one-line edit to
`policy.json`, not a code change to whichever guardrail cares about it - and there's exactly one
list to keep in sync with `AGENTS.md`'s prose, not one hardcoded copy per guardrail.

- **Secrets Guardrail** (`checkSecretsCommitted.ts`) - flags any newly-added file (anywhere in the
  repo, not just `tests/`) whose exact basename matches `policy.json`'s
  `forbiddenCommittedFilenames` (`.env`, `storage-state.json`, `credentials.json`, etc.). Exact
  basename match, not a prefix/glob, so `.env.example` never collides with `.env`. **This is the
  one guardrail in the whole pipeline with no suppression/override mechanism at all** - every other
  guardrail here accepts a `// <rule-tag>: approved — <reason>` comment for a genuine, reviewed
  exception; a committed credential has no legitimate exception, only a fix (remove it, and rotate
  it if it was ever actually pushed).
- **Forbidden Playwright Patterns Check** (`checkForbiddenPlaywrightPatterns.ts`) - flags any
  newly-*added line* (not the whole file - a pre-existing violation elsewhere in an already-shared
  spec file doesn't fail CI on an unrelated edit) in `tests/**/*.spec.ts` containing one of
  `policy.json`'s `forbiddenPlaywrightPatterns` (`page.pause()`, `page.waitForTimeout(`,
  `waitForSelector(` by default). Substring match, not a regex engine, so `policy.json` stays
  editable without thinking about regex escaping. No suppression here either - `AGENTS.md` states
  these as absolute ("ever"), unlike the locator-priority rule, which explicitly allows "approved
  in PR".
- **Required Test Tags Check** (`checkRequiredTags.ts`) - flags any *new* `test(...)` block whose
  `{ tag: [...] }` option contains none of `policy.json`'s `requiredTestTags` (`smoke`,
  `regression`, `critical` by default). "New" is determined by diffing each changed spec file's
  test blocks against its base-SHA version (`findNewTestBlocks`, matched by `scenario-id` marker or
  test title) - **deliberately not** the simpler "newly added file" scope the other guardrails use,
  because under this project's ticket-level shared-file default (see Multiple scenarios sharing one
  spec file above), most new scenarios land as one more test appended into an *already-existing*
  shared file, not a brand-new one; an added-files-only check would miss almost every real scenario
  added after a ticket's first. Suppression: `// required-tags: approved — <reason>` (file-scoped,
  same convention as Traceability Coverage) - for a genuinely non-scenario test like a seed test.
- `.github/workflows/secrets-check.yml`,
  `.github/workflows/forbidden-playwright-patterns-check.yml`,
  `.github/workflows/required-tags-check.yml` - same no-`paths:`-filter,
  always-runs-and-no-ops pattern as every other guardrail workflow. Each needs the same manual step
  to become a *required* check in Settings → Branches.

## CI Troubleshooting: Required Check Stuck on "Waiting for status to be reported"

**Symptom:** a PR shows "8 pending checks" / "Expected — Waiting for status to be reported" for
one or more of the required guardrails above, even though the Actions tab (or the PR's collapsed
"successful checks" list) shows all of them completed and green.

**This is a known GitHub platform bug, not a problem with the guardrails themselves or this repo's
configuration** - open on GitHub's own community forum since April 2022
([community discussion #26698](https://github.com/orgs/community/discussions/26698)), still
unresolved, no official fix. The workflows genuinely ran and passed; GitHub's ruleset status
aggregation on the PR page just fails to update to reflect it.

**If this happens:**

1. First, rule out the *other* (fixable) causes covered in that thread: a required check name that
   no longer matches an actual job name, a `paths:` filter that kept the workflow from running at
   all for this PR's changed files, a stale/out-of-date branch, or a merge conflict. None of these
   apply to this repo's 8 guardrail workflows today (no `paths:` filters, job names match the
   ruleset's required-check list) - but check first before assuming it's the platform bug.
2. Try a fresh push to force a re-run (`git commit --allow-empty -m "trigger checks" && git push`,
   then squash/rebase the empty commit back out before merging) or closing and reopening the PR.
   These sometimes clear it, sometimes don't.
3. If it's still stuck after that: manually verify, in the Actions tab, that all required checks
   actually completed successfully **against the PR's current/latest commit** (not a stale run).
   Once confirmed, use **"Merge without waiting for requirements to be met (bypass rules)"** from
   the merge button dropdown.

**This bypass is intentionally restricted to repository admins** (via the ruleset's Bypass list -
Settings → Rules → Rulesets → the branch ruleset → Bypass list) - it is not a blanket
team-wide override. Using it does not weaken or disable the guardrails for future PRs; it only
overrides GitHub's broken status display for the one PR you've personally verified is actually
green. It should never be used without that manual verification step - reflexively checking the
box "because it's stuck again" would defeat the entire point of having required checks. Every use
is recorded in the repo's audit log.

## Cost & Latency Accounting

Tracks cost/token usage/wall-clock time per agent per invocation, using Claude Code's own built-in
OpenTelemetry metrics (`CLAUDE_CODE_ENABLE_TELEMETRY=1`) rather than a hand-rolled token counter or
pricing table - Claude Code already computes `claude_code.cost.usage` in USD itself. `src/pipeline/costAccounting/`:

**The gotcha, confirmed empirically, not from docs:** Claude Code's `agent.name` telemetry
attribute collapses to `"custom"` for every user-defined subagent - verified by actually invoking
`jira-agent` and watching its telemetry, not by trusting the documentation's claim. It genuinely
cannot distinguish this project's six agents from each other on its own.

**A second discovery that only showed up under a real multi-agent spike, not a single-call test:**
`claude_code.cost.usage`/`claude_code.token.usage` are **cumulative counters that never reset**
(confirmed by watching the same series grow across ~30 consecutive export ticks), and **different
subagents sharing the same `(model, effort, query_source=subagent)` attributes land in the exact
same series** - a real spike showed `jira-agent` then `excel-agent` accumulate into one shared
counter, `agent.name: "custom"` for both, with the second call's cost simply added on top of the
first's. A single end-of-session read would give their *combined* cost with no way to split it
back apart.

**The design this forces:** since agents here run as nested subagent calls within one Claude Code
session (confirmed in this repo - there's no separate OS process per agent to wrap), attribution
can't come from a per-agent process wrapper. Instead:

- `scripts/run-with-cost-telemetry.sh` wraps the *whole session*, setting the telemetry env vars
  and capturing the console exporter's output to `data/<tenantId>/cost/raw/session-<timestamp>.log`
  (`TENANT_ID` env var, defaulting to `default`).
- `planning-agent.md` calls `npm run pipeline -- --stage cost-marker --agent <name> --event
  start|end` immediately before/after dispatching each of the other five agents - this *is* the
  attribution mechanism, not a generic wrapper. Markers are harmless no-ops if telemetry isn't on,
  so the Planning Agent calls them unconditionally.
- `parseAgentLog.ts` parses the raw log (`util.inspect`-style JS-object-literal text, not JSON -
  confirmed from a real capture; parsed via brace-matching + `new Function()`, since that format
  *is* valid JS syntax) and, for each marker-bounded interval, takes the delta between the last
  tick before the interval started and the first tick at/after it ended. This is what correctly
  separates two different subagents sharing one series - proven with a unit test that reproduces
  the exact real-spike scenario (two agents, one series, deltas `0.03` and `0.05`, not `0.03` and
  a wrong combined `0.08`).
- `costReport.ts` aggregates `cost/telemetry.jsonl` into total cost/time per agent per week,
  week-over-week trend, and flags any invocation costing >= 2x that **same agent's own historical
  median** (not a cross-agent comparison - a consistently pricier agent like the Healer shouldn't
  get flagged just for costing more than a cheap one like the Jira Agent).

**A second real gotcha, also only found by actually running this, not by reading code:**
`.claude/settings.local.json`'s permission allow-list didn't cover `npm run pipeline ...` at all
(only `npm install *`, `playwright-cli *`, `npm init *`) - in a non-interactive session there's no
human to approve an unlisted permission prompt, so every `cost-marker` Bash call was silently
denied and produced zero markers. Fixed by adding `"Bash(npm run pipeline *)"` to the allow-list.
This is exactly the kind of failure that looks identical to "the mechanism is broken" from the
outside (zero markers, zero events) but is actually a config gap - worth knowing about if you fork
this and it silently produces nothing.

**Verified end-to-end on real data, twice** (not just unit tests): a first spike confirmed the
`agent.name` gotcha and the raw log format; a second, after fixing the permission gap above,
proved the full chain for real - `markers.jsonl` got exactly the 4 expected lines
(`jira-agent`/`excel-agent` start+end), the raw log showed genuine `query_source: "subagent"`
activity (not just `"main"`), and `cost-record`/`cost-report` produced real, sensible numbers
(`jira-agent`: $0.033347/12.4s, `excel-agent`: $0.035061/13.0s) in the same ballpark as the first
spike's values for a similar trivial task.

There is no CI workflow for this feature (not asked for) - it's a manual/ad hoc tool: run
`scripts/run-with-cost-telemetry.sh` around a real pipeline session, then `npm run cost:record
-- --log <path>` and `npm run cost:report` afterward.

**Per-ticket cost:** every cost event above is agent-scoped but not, by default, ticket-scoped -
`cost/telemetry.jsonl` has no idea which Jira ticket a given `jira-agent` dispatch was actually
working on. `--stage cost-marker` takes an optional `--issue PROJ-123` alongside its existing
`--agent`/`--event` flags (`planning-agent.md` passes it on every real ticket dispatch - see its
own instructions); that value rides along through `markers.jsonl` → `parseAgentLog.ts`'s
`pairMarkers`/`buildCostEvents` → `CostEventSchema.jiraKey` on the resulting event, with no change
to `cost-record`'s own invocation. An event recorded before this field existed, or from a
non-ticket-scoped dispatch, simply has no `jiraKey` - same as always.

`--stage cost-report --issue PROJ-123` filters `cost/telemetry.jsonl` down to just that ticket's
events before aggregating, and writes its own `cost/report-<key>.json`/`.md` (via
`buildIssueReportPaths`) rather than overwriting the shared aggregate `cost/report.json`/`.md` -
running a scoped report never clobbers the numbers everyone else relies on. Without `--issue`,
`cost-report` behaves exactly as before (the full aggregate, unfiltered).

**Slack:** `cost-report` (aggregate or `--issue`-scoped) posts a summary to Slack after writing the
report files - total cost/wall-clock, cost per agent (collapsed across weeks, sorted highest
first), and any runaway-invocation flags. Own webhook/channel
(`COST_REPORT_SLACK_WEBHOOK_URL`, see `.env.example`), same "different audience" reasoning and same
CI-only-by-default gating (`SLACK_NOTIFY_LOCAL`) as every other Slack integration in this project.
Fire-and-log like the others - a missing webhook or a Slack outage never fails the stage itself,
since the report files are already written by the time the post is attempted.
`src/pipeline/costAccounting/slackNotify.ts`.

## Pipeline Health Report

A single dashboard aggregating the domains above (cost, healing, flaky, prompt versioning) plus
traceability, so "is the pipeline healthy" is one command instead of five. `src/pipeline/pipelineReport/`:

- `npm run pipeline:report` (or `--stage pipeline-report`) reads each domain's *own*
  already-written report/state files - it does not re-run drift-check, cost-record, etc. itself,
  since several of those make live Jira/TMS calls or have side effects that shouldn't fire just
  because someone wants a health snapshot.
- Writes `pipelineReport/report.json` (machine-readable) and `pipelineReport/report.html` (a
  self-contained, styled dashboard meant to be opened directly in a browser - deliberately HTML
  rather than the `.md` convention used elsewhere, since GitHub doesn't render `.html` inline
  anyway and this one's meant to look like a dashboard, not a diffable doc).
- Computes `attentionFlags`: a runaway cost invocation, healing rate under 50%, any active flaky
  quarantine, or traceability that's missing/stale/out-of-sync. Empty array = all green.
- **Slack notification on every run**, not just when something's flagged (a quiet heartbeat is the
  point - silence elsewhere would mean nobody knows the job even ran). Set `SLACK_WEBHOOK_URL` in
  `.env` (see the env var table above) to enable it; if unset, the report files are still written,
  the Slack step just logs that it's skipped. A failed Slack post (bad webhook, Slack outage) is
  logged as a warning, never thrown - the run reporting on pipeline health shouldn't itself fail
  because of a notification side effect. See `src/pipeline/pipelineReport/slackNotify.ts`.
- **The Slack message's report link, and the dashboard's own "Full X report" sub-links, both only
  work if `PIPELINE_REPORT_PUBLIC_URL` is set** - a bare local path (`pipelineReport/report.html`)
  isn't something a teammate reading Slack can open, so without it the Slack message just names
  the path as plain text instead of linking it, and the dashboard's sub-links fall back to
  relative `../cost/report.md`-style paths that only resolve when `report.html` is opened from a
  real repo checkout (see `deriveSiteRoot`/`writeSubReportPages` in `pipelineReport.ts`).
- **Sub-reports are self-hosted, not linked into the repo.** Each domain's own `report.md` (cost,
  healing, flaky, traceability, prompt versioning) gets rendered into a matching `report.html` -
  via a small dependency-free markdown renderer (`src/pipeline/shared/markdownToHtml.ts`, styled
  to match the dashboard via `src/pipeline/shared/reportPageStyle.ts`) - and published to the same
  Pages site as `pipelineReport/report.html` itself, at `<site-root>/<domain>/report.html`. This
  is deliberate: linking sub-reports into the (private) repo would mean anyone without repo access
  hits a GitHub login wall the moment they click past the dashboard, even if the dashboard itself
  is public. Best-effort per domain - `writeSubReportPages()` silently skips any domain whose
  `report.md` doesn't exist yet (only `drift-check.yml`, `healing-report.yml`, and
  `prompt-versions-report.yml` run on a schedule; `cost:report`/`flaky:report` are manual/local-only
  today - see their own sections above), so a sub-link with nothing to point at just isn't rendered
  as a card yet rather than the whole run failing.
- **`.github/workflows/pipeline-report.yml`** (daily at 6:15am, 15 minutes after `drift-check.yml`
  so traceability is same-day fresh; also `workflow_dispatch`): runs `pipeline:report` (which
  posts to Slack and writes the sub-report HTML pages above), uploads everything as a build
  artifact, commits it back to `master`, stages `pipelineReport/` plus each domain folder into one
  combined tree (`pages-dist/`, matching the URL structure the dashboard's links assume), then
  publishes that to GitHub Pages via `actions/upload-pages-artifact` + `actions/deploy-pages`.
  - **One-time manual setup required** (can't be done from a workflow file alone): in the repo's
    **Settings > Pages**, set **Build and deployment > Source** to **GitHub Actions**, and set
    **Visibility** to whichever you want (see below).
  - **Pages visibility is a real choice, not just a technical setting.** The dashboard only ever
    shows aggregate metrics (cost totals, healing rate, etc.), never code, credentials, or
    customer data - but it's still a disclosure decision (search-engine-discoverable, reveals
    AI-automation spend/maturity to anyone with the link) versus requiring GitHub login. This repo
    currently has it set to **Public**. Either way, `PIPELINE_REPORT_PUBLIC_URL` needs setting
    **once** as a repo Actions **variable** (not Secret - it isn't sensitive), since a private
    Pages site is served from a randomized subdomain GitHub assigns
    (`https://<random-words>.pages.github.io`) that can't be predicted/computed in the workflow,
    and even a public site's predictable `https://<org>.github.io/<repo>` URL isn't worth
    re-deriving in-workflow when a variable is simpler:
    1. After the first successful run of this workflow, find the real URL - either in the run's
       **Deploy to GitHub Pages** step output, or under **Settings > Pages**.
    2. Go to **Settings > Secrets and variables > Actions > Variables tab** > **New repository
       variable**.
    3. Name: `PIPELINE_REPORT_PUBLIC_URL`, value: that URL with `/report.html` appended (e.g.
       `https://your-org.github.io/agentic-qa-pipeline/report.html`).
    Until this variable is set, the Slack message falls back to naming the local file path as
    plain text, and the dashboard's sub-links fall back to relative `.md` paths (same as any run
    with no public URL configured).
  - Also needs a `SLACK_WEBHOOK_URL` **repository secret** (Settings > Secrets and variables >
    Actions) - separate from your local `.env`, same value.
  - **Commits via a dedicated GitHub App, not the default `GITHUB_TOKEN`** - same App, same
    `APP_ID`/`APP_PRIVATE_KEY` secrets, and same reasoning as `drift-check.yml` above (the default
    token can't push directly or open a PR here; the App is bypass-listed on the ruleset instead).
    Even without this, the Slack notification and the *hosted* Pages report would still always be
    current either way - neither depends on the commit step, both are regenerated fresh on every
    run - but the committed copy in git history would otherwise lag until someone pushed it
    manually.

## Scrum Master Automation Program

A 7th agent (`src/pipeline/scrum/`, `.claude/agents/scrum-master-agent.md`) doing deterministic
Scrum reporting - sprint snapshots, VCS/PR activity, and a standup digest - built up one stage at a
time (Phase 1 of the Technical Document's phase table). Config lives at
`config/tenants/<tenantId>/scrum.json` (`ScrumConfigSchema`): board IDs, the story-points custom
field, standup delivery (channel vs. DM), and this tenant's VCS provider/branch convention. Every
stage is gated the same way every other stage is - `assertStageAllowed()` against
`capabilities.json`'s `scrumCeremony`/`scrumDevStatus` flags - so a tenant that hasn't opted in
gets a clear rejection instead of a stage silently running.

**Current state:** the two Jira/GitHub clients (`agileClient.ts` - current-sprint snapshot only,
not full burndown; `vcsClient/` - a provider-agnostic interface with a GitHub adapter) are both
built. `--stage dev-status`, `--stage sprint-status`, and `--stage standup-digest` are all wired
up. `standup-digest` now also delivers - a per-assignee Slack DM - gated by `scrum.json`'s
`standupDigest.dm` flag (see its own subsection below); channel-mode delivery is still deferred to
a future PR. All three now also run on a schedule via
`.github/workflows/scrum-ceremony-report.yml` (weekday mornings), completing Phase 1's ceremony
reporting.

Phase 2 has started: `--stage blocker-scan` is also now real (see its own subsection below) - the
first stage in this agent's whole module tree that *writes* anything (Jira comments, Slack
messages) rather than only reporting or DM-ing a digest. It is deliberately **manual-CLI-only for
now** - `scrum-ceremony-report.yml`'s cron does not run it - until it's been run against real data
and its cross-run re-escalation behavior (see that subsection) has been revisited.

Phase 2's second and final duty, `--stage groom-check-fetch` / `--stage groom-check-flag`
(backlog-groom-check), is also now real (see its own subsection below) - a genuinely different
shape from every stage above, since the actual "is this ticket clear" judgment happens in a live
agent session, never a deterministic function. Like blocker-scan, it is manual-only and never
cron-wired - here there isn't even a single deterministic command that performs the whole duty to
wire in.

Phase 3 has started: `--stage burndown-report` (see its own subsection below) is the first Phase 3
duty, and fully deterministic - no live judgment step like backlog-groom-check, no write/escalation
side effect like blocker-scan. It reuses `agileClient.ts` completely unchanged (the same
current-sprint snapshot `sprint-status` already fetches), reshaped into a completed/remaining-work
view per active sprint - **not** a historical burndown chart or a real committed-vs-actual trend
line; see that subsection for why.

Phase 3's second and final duty, `--stage retro-notes-fetch` / `--stage retro-notes-post`
(retro-notes), is also now real (see its own subsection below), completing Phase 3. Same shape as
backlog-groom-check: two deterministic bookends, the actual retrospective synthesis happens in a
live agent session, and it is manual-only and never cron-wired - same reasoning as
backlog-groom-check, restated in that subsection rather than re-derived here.

### `--stage dev-status`

```
npm run dev:status
# or: npm run pipeline -- --stage dev-status
```

Reports every open pull request and every branch with no open PR, for this tenant's configured
`GITHUB_REPO`, matched to a Jira ticket key via each branch name. Writes
`data/<tenantId>/devStatus/report.json` and `report.md` (same dual JSON+Markdown convention as
`cost-report`/`healing-report`).

**Branch-to-ticket matching (`matchBranchToTicket()` in
`src/pipeline/scrum/stages/devStatus.ts`):** looks for `JIRA_PROJECT_KEY` followed by a dash and
digits, anywhere in the branch name, case-insensitively - e.g. branch `fix/proj-123-widget` with
`JIRA_PROJECT_KEY=PROJ` links to `PROJ-123`. This is the one convention any real tenant actually
has today (`scrum.json`'s `vcs.branchKeyConvention: "lowercase ticket key anywhere in branch
name"`); that field is free text for a human maintaining the config to read, not a mini-DSL this
function parses at runtime - a tenant needing a genuinely different convention (a required prefix
position, a non-Jira key shape) needs a code change here, not just a config edit.

**Unlinked activity is surfaced, not hidden.** A PR or branch whose name matches no ticket key
still appears in the report - under its own `unlinkedPullRequestCount` (JSON) / "unlinked" label
(Markdown) rather than being silently dropped. A `PROJ`-key-less PR could be a harmless chore
branch or a real process gap (a ticket-linked PR that just got misnamed); this report shows it
either way and leaves that judgment to whoever reads it, rather than guessing on the team's behalf.

**Branches without an open PR** excludes any branch that's currently a PR's `baseBranch` (i.e. the
repo's trunk, typically `master`/`main`) - without this exclusion, trunk would show up in *every*
run as "a branch nobody opened a PR for," which is never meaningful. This is a heuristic (there's
no dedicated "what's the default branch" lookup wired in yet), so a repo with literally zero
currently-open PRs would have nothing to exclude by, and its trunk branch would appear in that
edge case - a known, narrow limitation rather than an extra API call to close a gap that only
bites when a repo has no open PRs at all.

`.github/workflows/scrum-ceremony-report.yml` now runs this stage (alongside `sprint-status`
and `standup-digest`) on a weekday-morning cron - see that workflow's own header comment for the
GitHub App auth pattern and the `GITHUB_TOKEN`-is-a-reserved-secret-name wrinkle specific to this
stage's `vcsClient/` credential.

### `--stage sprint-status`

```
npm run sprint:status
# or: npm run pipeline -- --stage sprint-status
```

Current-sprint snapshot (points grouped by status right now, per assignee) for every board in this
tenant's `scrum.json` `boardIds` - **not** a burndown/velocity view; see `agileClient.ts`'s own doc
comment for why that's out of scope until Phase 3. `boardIds` and `storyPointsField` come from
`scrum.json` (via `scrumConfigStore.ts`'s `loadScrumConfig()`), not env vars - these are per-tenant
ceremony config, not connection identifiers, unlike `GITHUB_REPO`/`JIRA_PROJECT_KEY` above. Writes
`data/<tenantId>/sprintStatus/report.json` and `report.md`.

**Every active sprint gets its own section - never just the first one found.**
`AgileClient.getActiveSprints(boardId)` can return more than one sprint for boards that run
overlapping sprints (e.g. a maintenance sprint alongside a feature sprint); collapsing to "the"
active sprint would silently misreport that board. Same "surface it, don't guess or drop it"
reasoning as `dev-status`'s unlinked-activity handling above. Each `(board, sprint)` pair is one
report section, keyed by `boardId` alongside the sprint's own id/name.

**`storyPointsField` unset is a real, surfaced state, not a crash.** `scrum.json`'s
`storyPointsField` is optional (no guessed default - see `ScrumConfigSchema`'s own comment on why a
wrong guess would silently misreport point totals). When it's unset, every issue's `storyPoints`
comes back `null` and the report's own top-level `storyPointsField` field is `null` too - so a
reader can tell "this tenant hasn't configured a story-points field yet" apart from "every issue
in this sprint genuinely has zero/no points set," rather than a wall of nulls looking like an
empty backlog.

### `--stage burndown-report`

```
npm run pipeline -- --stage burndown-report --tenant <id>
```

Phase 3's first duty, and the smallest of the two Phase 3 duties (`--stage retro-notes`, not yet
built, is expected to be the agent-reasoning one). Fully deterministic, no design forks: reuses
`agileClient.ts`'s existing `getActiveSprints`/`getSprintIssues` completely unchanged (the same
fetch `sprint-status` already does), and reuses `sprint-status`'s own per-sprint categorization
(`buildSprintStatusReport()`) rather than re-deriving it, reshaping each `(board, active sprint)`
section into a completed-vs-remaining burndown view.

**Not a historical burndown chart, and not a real committed-vs-actual trend line.** See
`agileClient.ts`'s own doc comment: the committed/completed/carried-over deltas Jira's own UI shows
live come from an undocumented/deprecated Greenhopper endpoint this project does not depend on, and
this stage doesn't persist day-over-day snapshots to approximate one either - both would be a real
design fork this duty deliberately does not take on. What it reports instead is the honest
point-in-time signal the public Agile REST API can actually support: total, completed, and
remaining story points/issues for each currently active sprint, right now.

**One JSON+Markdown pair per (board, active sprint) pair - not one combined report.** Unlike
`sprint-status`'s single `report.json` holding every section, this stage writes
`data/<tenantId>/scrum/burndown-<sprintId>.json`/`.md` - one pair per sprint, keyed by the sprint's
numeric Jira id (globally unique, filesystem-safe by construction, no slugifying needed), the same
per-scope-file reasoning as `cost-report`'s own `--issue`-scoped `report-<key>.json`. A board with
zero currently-active sprints simply contributes no file, same as it contributes no section to
`sprint-status`'s own report.

**`storyPointsField` unset is surfaced, not guessed - same as `sprint-status`.** When
`scrum.json`'s `storyPointsField` is unset, every story-point figure in the report is `0`, but
`percentComplete` is `null`, not `0%` - so a reader can tell "this tenant hasn't configured a
story-points field" apart from "this sprint is genuinely at 0% points-complete." The same
distinction applies when a configured field simply totals 0 points (nothing estimated yet).

**Gated by its own capability flag.** `capabilities.json`'s `scrumBurndown` (default `true`, same
opt-out-not-opt-in default every flag here uses) gates this stage independently of
`scrumCeremony`/`scrumDevStatus`/`scrumBlockerScan`/`scrumGroomCheck` - same per-duty-gets-its-own-
gate precedent every Phase 2 duty already established.

### `--stage standup-digest`

```
npm run standup:digest
# or: npm run pipeline -- --stage standup-digest
```

Writes `data/<tenantId>/standupDigest/report.json` and `report.md`, the same dual JSON+Markdown
convention as every other stage here. Groups every issue from every active sprint on every board in
`scrum.json`'s `boardIds` (the same fetch as `sprint-status`, reused as-is) by Jira assignee - an
assignee working across more than one board's sprint gets one combined entry, not one per board,
since the point of a standup digest is "what is this person doing", not "what's happening on this
board that this person happens to touch". Each assignee's issues are split into three buckets: not
started, in progress, and done this sprint (by `statusCategory`, same mapping as `sprint-status`),
plus a fourth "unknown status" bucket for anything Jira didn't categorize - surfaced rather than
silently folded into one of the other three.

**There is deliberately no "blocked" bucket.** Jira's `statusCategory` only distinguishes
new/indeterminate/done/unknown - a status literally named "Blocked" is still `indeterminate` to
Jira - so the only way to guess "blocked" from data this pipeline already fetches would be a
status-name text match (e.g. anything containing "block"), which isn't confirmed to match how any
real tenant's workflow actually names a blocked state. `scrum.json`'s `blockerEscalation` config
already reserves a shape for a real blocked/idle signal (`idleDaysThreshold`, `relatedRecipients`)
for Phase 2's `blocker-scan` - a deliberately more rigorous, config-driven signal (idle time, not a
guessed status-name match). Shipping a guessed heuristic here that Phase 2 might later contradict
would be worse than not having the bucket yet.

**Delivery is wired - DM-only, one Slack DM per assignee.** The Jira account migration (personal ->
the client company account) is now confirmed live, so `agileClient.ts`'s
`SprintIssueSnapshot.assigneeEmail` can be trusted for real accounts - this stage builds an
assignee -> email map from the same fetched issue data (`buildAssigneeEmailMap()`) and, when
`scrum.json`'s `standupDigest.dm` is true, sends each assignee their own digest via
`sendTicketSummaryDm()` (the same Slack Bot API DM helper `ticket-summary` already uses).
**Channel-mode delivery is still deferred to a future PR** - `standupDigest.channel` continues to
be read and echoed into the report's `configuredDelivery` field, but posting to a channel is a
genuinely different Slack call (no per-person lookup) that isn't implemented yet; the pure
`planStandupDigestDelivery()` always returns `skipped-not-configured` when `dm` is false, even if a
channel is also configured. An issue whose assignee has no `assigneeEmail` (still a real
possibility per `agileClient.ts`'s own doc comment - e.g. private contact-information visibility)
is skipped with a clear log line and a `skipped-no-email` delivery outcome, never thrown. Every
assignee in the written report carries a `delivery` field (`sent` / `skipped-unassigned` /
`skipped-not-configured` / `skipped-no-email` / `failed`, with an optional human-readable `detail`)
recording exactly what happened for them on that run.

### `--stage blocker-scan`

```
npm run blocker:scan
# or: npm run pipeline -- --stage blocker-scan
```

Phase 2's first duty, and the first stage in this whole agent that writes anything at all - a Jira
comment on the ticket, and/or a Slack message - rather than only building a report or sending a
digest DM. **Manual-CLI-only for now** - deliberately not wired into
`scrum-ceremony-report.yml`'s cron (see the trust-boundary note below). Writes
`data/<tenantId>/blockerScan/report.json` and `report.md`, same dual JSON+Markdown convention as
every other stage here.

Flags every current-sprint issue (same fetch as `sprint-status`/`standup-digest`, reused as-is,
across every board in `scrum.json`'s `boardIds`) whose Jira `updated` timestamp is older than
`scrum.json`'s `blockerEscalation.idleDaysThreshold` (default 3) **and** whose `statusCategory` is
not `done` - both design decisions below were made explicit before building, at the user's own
request:

- **Idle days = calendar days, not business days.** Plain `floor((now - updated) / 1 day)`,
  weekends included. `ScrumBlockerEscalationSchema` has no business-day/holiday/timezone
  configuration surface, so business-day math would need a schema change out of scope for this PR.
- **"Blocked" = pure idle time, any non-`done` status - no status-name guessing.** This is the
  same "surface it, don't guess" reasoning `standup-digest`'s own "no blocked bucket" decision
  already used (see that subsection above) - a status literally named "Blocked" is still
  `indeterminate` to Jira's `statusCategory`, so this stage doesn't try to text-match a status
  name; any sufficiently idle non-done ticket is flagged regardless of its literal status.

**Escalation, per flagged issue:**

- **The assignee** always gets a Jira comment (`buildBlockerEscalationComment()`, plain text -
  idle days, last-updated timestamp, threshold, status, assignee) - this is the assignee's only
  escalation channel. The assignee is deliberately never a configurable recipient (see
  `ScrumEscalationRecipientSchema`'s own comment) - Jira's own notification system reaches them
  once the comment posts. An unassigned issue skips this with a clear log line, not a comment
  addressed to nobody.
- **Each configured `relatedRecipients[]` entry** (`scrum.json`'s `blockerEscalation`) gets
  whichever of its own `channels[]` this stage supports today - `slack-dm` (via
  `sendTicketSummaryDm()`, targeting the recipient's `target` email) and `slack-channel` (a direct
  webhook POST to `BLOCKER_SCAN_SLACK_WEBHOOK_URL`, gated the same CI-only-by-default way every
  other shared-channel Slack post in this pipeline is - see `SLACK_NOTIFY_LOCAL` above). Anything
  else (`teams`, `email`, a typo) throws a clear "channel not supported yet" error up front, before
  any fetch or delivery is attempted - `ScrumEscalationChannelSchema.channel` is intentionally an
  open string precisely so adding a real channel later needs zero schema change, just a new case
  here.
- **`slack-channel` is one fixed tenant-wide webhook, not real per-recipient routing.** A Slack
  incoming webhook is bound to the one channel it was created for - a `relatedRecipient`'s
  configured `target` (e.g. a channel name) is echoed into the message for human context but does
  **not** select the destination; every recipient configured with `channel: 'slack-channel'` posts
  to the same physical channel. Genuine per-recipient channel routing would need the Slack Bot
  API's `chat.postMessage(channel: target)` instead of a webhook - noted as a possible future PR,
  not built here.

Every attempt (`sent` / `skipped-not-configured` / `failed`, per recipient/channel) is recorded
onto the flagged issue's `escalations` array before the report is written, so the persisted
JSON/Markdown always reflects what actually happened - same "surface it, don't guess or drop it"
convention as `standup-digest`'s own `delivery` field.

**No cross-run dedup yet - a known, flagged spam risk.** Every run re-escalates every
currently-flagged issue from scratch; a ticket that stays idle past the threshold gets a fresh
Jira comment and Slack ping on every single run. This is fine for a manually-triggered stage run
occasionally, but **must** be resolved (tracking which tickets were already escalated, and when,
across runs) before this stage is ever wired into a cron schedule - that is exactly why it stays
manual-CLI-only in this PR.

**Gated by its own capability flag.** `capabilities.json`'s `scrumBlockerScan` (default `true`,
same opt-out-not-opt-in default every flag here uses) gates this stage independently of
`scrumCeremony`/`scrumDevStatus` - a tenant can keep ceremony reporting on while keeping this
write-capable stage off, or vice versa, following the same "write actions get their own gate"
precedent `jiraWorkflowActions` already set elsewhere in this pipeline.

### `--stage groom-check-fetch` / `--stage groom-check-flag`

```
npm run pipeline -- --stage groom-check-fetch --tenant <id>
# ...then, after a live judgment pass over the fetched report...
npm run pipeline -- --stage groom-check-flag --issue <KEY> --gaps-file <path>
```

Phase 2's second and final duty (backlog-groom-check), and a genuinely different shape from every
other stage in this program. **This is not a new automated pipeline stage that judges tickets
itself.** `requirementGate.ts`'s `buildRequirementGapComment()` (the formatter behind Gate 0 in
`planning-agent.md`) is a pure formatter only - the real clarity judgment happens entirely inside
a live Claude Code/Cowork session's own reasoning, and this codebase has zero
direct-Anthropic-API-call infrastructure anywhere (no `@anthropic-ai/sdk`, no `ANTHROPIC_API_KEY`).
So this duty reuses that exact mechanism rather than inventing a new one: two small deterministic
stages bookend a live judgment step that only `scrum-master-agent.md`'s own instructions describe.

**`--stage groom-check-fetch`** reuses the same `agileClient.ts` `getActiveSprints`/
`getSprintIssues` fetch loop as `sprint-status`/`standup-digest`/`blocker-scan`, then calls
`jiraClient.ts`'s existing `getIssue()`/`extractDescription()` per ticket for its full description,
issue type, and status - no client changes needed, both already exist and are already used by the
Jira Agent. Writes `data/<tenantId>/groomCheck/report.json`/`report.md`: one clean data source for
the live judgment step to read, instead of looping raw API calls inline itself.

**How the QA-vs-dev rubric is applied - checked against real data, not assumed.** The Technical
Document's Duty Breakdown reframes Gate 0's clarity check per ticket type: "can scenarios be
generated from this" for a QA-shaped ticket, "can a developer start building from this" for a
dev-shaped one. Before building this, the real SCRUM project's issue-type/label/component data was
checked directly (rather than assuming a convention) - every real ticket in this tenant's project
is issue type "Task" (the project's full issue-type list is Epic/Subtask/Task/Story/Feature/
Request/Bug, no dedicated QA type), no labels are set on any ticket, and no components are
configured at all. **There is no mechanical signal today that would let a deterministic rule split
QA vs dev tickets** - so `groom-check-fetch`'s report carries `issueType`/`status`/`description`
through unfiltered, and the live judgment step (not this stage) decides which lens applies by
reading each ticket's actual content, the same live-judgment-not-pattern-matching principle Gate 0
itself already uses for requirement clarity. If a tenant's config ever does carry a real, confirmed
QA/dev convention, that becomes a future additive config field to defer to - not something to
speculatively build now against unconfirmed data.

**`--stage groom-check-flag --issue <KEY> --gaps-file <path>`** posts whatever gap strings the live
judgment step decided on as a Jira comment (`jiraNotify.ts`'s `CommentPoster`/`addComment`, the same
mechanism `blocker-scan` already uses), mirroring `flag-requirement-gaps`' own file-based mechanism
(a JSON array of strings, same leading-UTF-8-BOM handling) closely. Unlike Gate 0, there is no
manifest-recorded gate and nothing downstream this blocks - a missing or empty `--gaps-file` simply
means nothing gets posted, the same fire-and-log posture `blocker-scan`'s own escalation comment
already uses, not a three-gate workflow record.

**No cron wiring, not even as a future toggle.** Unlike `blocker-scan` (fully deterministic, and a
plausible future cron candidate once its dedup gap closes), there is no single command that
performs this whole duty end-to-end - the judgment step requires a live session. Neither stage is
added to `scrum-ceremony-report.yml`.

**Gated by its own capability flag.** `capabilities.json`'s `scrumGroomCheck` (default `true`, same
opt-out-not-opt-in default every flag here uses) gates both stages independently of
`scrumCeremony`/`scrumDevStatus`/`scrumBlockerScan`.

### `--stage retro-notes-fetch` / `--stage retro-notes-post`

```
npm run pipeline -- --stage retro-notes-fetch --tenant <id>
# ...then, after a live retrospective synthesis over the fetched report...
npm run pipeline -- --stage retro-notes-post --sprint-id <id> --notes-file <path>
```

Phase 3's second and final duty (retro-notes), and the same shape as backlog-groom-check: two
deterministic bookends around a live judgment step, not a new automated pipeline stage that
synthesizes the retro itself. This codebase still has zero direct-Anthropic-API-call infrastructure
anywhere (no `@anthropic-ai/sdk`, no `ANTHROPIC_API_KEY`), and building one for retro-notes
specifically would re-decide that same parked "how agentic should this get" question piecemeal -
exactly what the groom-check-fetch/-flag design already avoided. So this duty reuses that same
mechanism: `scrum-master-agent.md`'s own "Retro notes" instructions describe the live synthesis
step; this program only provides the fetch and the post.

**`--stage retro-notes-fetch`** reuses the same `agileClient.ts` fetch loop as every other stage
here (via `sprint-status`'s own `buildSprintStatusReport()` categorization, not re-derived a third
time) for the sprint/ticket half, and `dev-status`'s existing `buildDevStatusReport()` for the VCS
half (open PRs and branches with no open PR, already matched to ticket keys) - no new client
methods needed, both already exist and are already used elsewhere in this program. Writes
`data/<tenantId>/retroNotes/report.json`/`report.md`: one clean data source for the live
synthesis step to read.

**QA telemetry is confirmed deferred, not silently omitted.** Before building this, the real
candidates already in this codebase were checked directly: `healingReport.ts`/`flakyReport.ts` both
bucket events by ISO week, not by sprint, and traceability's drift-check data is a point-in-time
consistency snapshot with no time dimension at all - neither correlates cleanly to "this sprint"
without inventing a brand-new sprint-date-range filter this codebase doesn't have anywhere today.
Wiring either in as a guessed convention would be exactly the kind of unconfirmed assumption this
program's other stages (standup-digest's no-guessed-"blocked"-bucket, blocker-scan's
no-status-name-matching, groom-check-fetch's QA-vs-dev rubric) have already declined to ship. So
`retro-notes-fetch` only wires in the VCS half today, and this is a confirmed, flagged decision -
not a silent gap - a future addition once a real sprint-scoped QA signal exists.

**`--stage retro-notes-post --sprint-id <id> --notes-file <path>`** is a dumb poster - it reads the
live-synthesized notes text from `--notes-file` (raw text, not JSON; same leading-UTF-8-BOM
handling as `--gaps-file`), wraps it with a minimal standard header (sprint id, generated
timestamp), and writes it to `data/<tenantId>/scrum/retro-<sprintId>.md`. **File only, confirmed
with a real decision rather than defaulted to silently:** unlike backlog-groom-check's Jira-comment
posting, a sprint retro has no single ticket to attach to, so there is no Jira comment and no Slack
message - just this one file, keyed by sprint id the same way `burndown-report` keys its own
per-sprint files.

**No cron wiring, not even as a future toggle.** Same reasoning as backlog-groom-check: there is no
single command that performs this whole duty end-to-end - the synthesis step requires a live
session. Neither stage is added to `scrum-ceremony-report.yml`.

**Gated by its own capability flag.** `capabilities.json`'s `scrumRetro` (default `true`, same
opt-out-not-opt-in default every flag here uses) gates both stages independently of
`scrumCeremony`/`scrumDevStatus`/`scrumBlockerScan`/`scrumGroomCheck`/`scrumBurndown`.

## AI Queue: Story Drafting (`--stage draft-story`)

Phase C of `docs/planning/AI-Assisted Scrum and SDLC Console - Development Plan.docx` - drafts a
user story (title, description, acceptance criteria) from a Jira Epic and queues it for a Product
Owner to review, rather than registering anything as a real ticket automatically.

```bash
npm run pipeline -- --stage draft-story --issue EPIC-123
```

`--issue` here takes an Epic key, same flag every other stage uses for a ticket key - an Epic is
just another Jira issue, so the existing `JiraClient` already reads one with no new adapter.
`--model` (optional, defaults to Haiku 4.5) overrides which model drafts it - same
`requirementGate/headlessJudge.ts` `MODEL_PRICING` table `--stage flag-requirement-gaps-headless`
and `--stage ask` already use, so this stage's cost shows up in `cost-report` for free.

**Requires two things this CLI didn't need before:** `ANTHROPIC_API_KEY` (already required by
`flag-requirement-gaps-headless`/`ask`) and a running backend (`backend/`, `npm run dev` -
`BACKEND_API_URL` + `BACKEND_PROJECT_ID`, see `.env.example`). This is the first CLI stage that
calls `backend/` directly over HTTP rather than only writing a flat file - see
`src/pipeline/queueClient/queueClient.ts`'s header comment for why that's a deliberate exception to
this project's usual "CLI writes JSON, a separate script migrates it later" pattern. If either is
unset, the stage fails with a clear, actionable error naming which one - it does not silently skip,
since (unlike Slack/email notifications) there is nowhere else for a drafted story to go.

**What actually happens:** one real Anthropic API call drafts the story; a real `CostEvent` is
recorded (`agent: "draft-story"`); the draft is `POST`ed to the backend's
`POST /api/projects/:projectId/queue` as a `SUGGESTED` item (`sourceStage: "stories"`) - visible via
`GET /api/projects/:projectId/queue` or the AI Queue dashboard
(`GET /api/projects/:projectId/queue/dashboard?organizationId=<id>`, see `backend/README.md`).
Nothing is written back to Jira by this stage. Turning an *approved* queue item into a real Jira
ticket is Phase D (Tickets auto-registration) of the same dev plan - not yet built.

**Gated by its own capability flag.** `capabilities.json`'s `storyDrafting` (default `true`, same
opt-out-not-opt-in default every flag here uses) gates this stage independently of
`scenarioGeneration` and every scrum duty above - drafting a new story and calling a new external
system (the AI Queue backend) are a different concern from generating test scenarios.

## AI Queue: Sprint Plan, velocity half (`--stage draft-sprint-plan`)

Phase C's other half of the same dev plan - **velocity only**. Capacity/availability (Tempo
integration, or a manual capacity input) is explicitly not built yet, pending a decision on which
approach to take; this stage only answers "what does this board's own recent completed-points
history support," never "what does the team actually have available this sprint."

```bash
npm run pipeline -- --stage draft-sprint-plan
```

No `--issue`/`--board-id` flag - like `sprint-status`/`burndown-report`, it loops over every board
in `scrum.json`'s `boardIds`. `--model` (optional, defaults to Haiku 4.5) overrides the narration
model, same convention as `draft-story`.

**What actually happens, per configured board:** (1) fetches the board's last 6 CLOSED sprints
(`AgileClient.getClosedSprints()`, new) and computes average velocity by reusing
`buildSprintStatusReport()`'s own categorization - no point-summing logic is re-derived
(`src/pipeline/scrum/stages/velocityReport.ts`); (2) finds every not-yet-started ("future") sprint
already drafted on that board in Jira, and deterministically - **no LLM, in plain code** -
selects which of its issues fit inside the velocity-derived point budget, greedily, in Jira's own
order (`src/pipeline/scrum/stages/sprintPlanCandidates.ts`); (3) makes one real Anthropic call
whose only job is to narrate that already-computed selection in prose - it is explicitly instructed
never to recompute or re-derive any number itself, the same "don't ask the LLM to do arithmetic"
lesson `askEngine.ts`'s own real bug history established
(`src/pipeline/scrum/stages/draftSprintPlanNarrative.ts`); (4) queues the result as a
`NEEDS_SESSION` AI Queue item (`sourceStage: "sprint-plan"`) - a heavier review bar than
`draft-story`'s `SUGGESTED`, since a sprint plan needs the team to confirm, not just one Product
Owner. A board with no velocity yet (unconfigured `storyPointsField`, or no closed sprints found)
or no future sprint drafted is skipped with a clear log line, not silently guessed at. This stage
never writes to Jira.

**Gated by its own capability flag.** `capabilities.json`'s `sprintPlanning` (default `true`), same
per-duty-gate precedent as `storyDrafting`.

## AI Queue: Release Summary (`--stage release-summary`)

Phase E of the same dev plan - "Release Stage." Deliberately built last, and deliberately the most
conservative stage in this whole program, per the source deck's own "highest caution" label:
**read-only, always.** This stage never sets a Jira fixVersion, never transitions an issue, and
never talks to a deploy tool - it only summarizes and reports.

```bash
npm run pipeline -- --stage release-summary --fix-version "2026.09"
```

**What actually happens:** a plain JQL search (`JiraClient.searchByFixVersion()`, core REST API
v3) fetches every issue tagged with the given `fixVersion`; each is bucketed into the same
four-category status breakdown (To Do / In Progress / Done / Unknown) every other scrum stage in
this pipeline already uses; a JSON+Markdown report is written
(`data/<tenantId>/releaseSummary/<slugified-fix-version>.json`/`.md`); the result is queued as a
`NEEDS_SESSION` AI Queue item (`sourceStage: "release"`) for a real Release Owner to sign off on via
the dashboard. A `fixVersion` with **zero** issues found is explicitly reported as **not** ready
(not a false clean bill - almost always means the name was mistyped), and a `fixVersion` with any
issue not yet Done is reported not ready with the concrete list of what's outstanding, not just a
count.

There is deliberately no `fileJira*`-style resolve action for this `sourceStage`, unlike
`stories`/`defects` - Release has nothing to file. A plain Approve/Reject/Dismiss on the AI Queue
dashboard *is* the entire owner sign-off action this stage supports; nothing this pipeline does can
turn that approval into an actual release.

**Gated by its own capability flag.** `capabilities.json`'s `releaseSummary` (default `true`), same
per-duty-gate precedent as every AI Queue stage above.

## Slack Notifications

Two separate Slack surfaces, deliberately kept apart from the Pipeline Health Report's Slack posts
above (different audience, different trigger, different mechanism):

- **Merge Notify - automatic, one line, no setup per person.**
  `.github/workflows/merge-notify.yml` triggers on every merged pull request
  (`pull_request: types: [closed]`, gated on `github.event.pull_request.merged == true` so a
  closed-without-merging PR stays silent) and posts `PR #X merged into <branch>: <title> (by
  <author>)` to whichever channel `MERGE_NOTIFY_SLACK_WEBHOOK_URL` points at. Its own webhook, not
  a reuse of `SLACK_WEBHOOK_URL` - a merge-ping fires far more often than the daily health report
  and would otherwise drown it out, same "different audience" reasoning as
  `DRIFT_CHECK_SLACK_WEBHOOK_URL`. If the secret is unset, the workflow step logs that it's
  skipping and exits cleanly - it never fails a PR merge.
- **Ticket Summary - manual, on-demand, DMs the person who ran it.**
  `npm run pipeline -- --stage ticket-summary --issue PROJ-123` gathers one ticket's Gate 0/1/2
  status, TMS run/case data, and run/heal telemetry from local pipeline state only
  (`traceability/manifest.json`, `output/tms-run-<key>.json`, `healing/telemetry.jsonl` - no writes,
  safe to run as often as you like), prints a human-readable summary to the console, then attempts
  to also DM it to you in Slack via `src/pipeline/ticketSummary/`. Uses the **Bot API**
  (`users.lookupByEmail` + `conversations.open` + `chat.postMessage`), not an incoming webhook - a
  webhook always posts to the one fixed channel it was created for, with no way to address a
  specific person, which is the entire point of this command.
  - Requires a Slack App (created once by a workspace admin) with the `users:read.email`,
    `im:write`, and `chat:write` bot scopes, installed to the workspace, with its Bot User OAuth
    Token (`xoxb-...`) shared team-wide as `SLACK_BOT_TOKEN` - same distribution model as the
    shared Qase account. `im:write` is easy to miss since it's not needed for the lookup or the
    final post, only for `conversations.open` itself (opening a new DM channel with someone the
    bot hasn't messaged before) - a Slack App with only `users:read.email` + `chat:write` will
    resolve the right person but then fail with `conversations.open failed: missing_scope`. See
    `SLACK_USER_EMAIL` above for how it finds which Slack account is yours.
  - Fire-and-log like every other Slack integration in this project: a missing token or a failed
    lookup/post never fails the stage - the summary is always printed to the console regardless,
    with a console warning explaining why the DM didn't send.

## Test Management Provider Abstraction

This framework was originally hardcoded to Qase specifically. It's now behind a provider-agnostic
interface, with Qase moved entirely behind it. This task built the abstraction and the Qase
adapter; it does **not** add a second adapter (TestRail/Zephyr/Xray) - that's deliberate, not a
gap. The provider a given run actually uses is tenant-scoped, not global - see Multi-Tenant
Foundations above for `resolveTmsProvider()` and per-tenant capability config.

- `src/pipeline/testmgmt/types.ts` - the `TestManagementClient` interface (`getCase`, `createCase`,
  `bulkCreateCases`, `createRun`, `setActiveRun`, `submitResult`), using **string** case/run ids
  throughout, not Qase's native numbers, since not every provider uses numeric ids.
- `src/pipeline/testmgmt/qaseAdapter.ts` - wraps the existing `QaseClient` (its axios logic, severity
  mapping, and Qase status handling are all unchanged, internal to `qaseClient.ts`) behind
  `TestManagementClient`. Qase's numeric ids are converted to/from strings at this adapter boundary
  only - `qaseClient.ts` itself still works in native numbers.
- `src/pipeline/testmgmt/index.ts` - `getTestManagementClient()` picks the adapter by
  `resolveTmsProvider()` (a tenant's `config/tenants/<id>.json` `integrations.tms.provider`,
  falling back to the global `TMS_PROVIDER` env var - default `qase` - for a tenant with no
  capabilities file yet, so nothing breaks with zero config changes); any other value throws a
  clear error today, since no second adapter exists yet.
- **Qase's real result-status vocabulary is `passed | failed | blocked | skipped | invalid`**,
  and `invalid` (the test case itself is broken, not the app under test) doesn't map cleanly onto
  other providers. The canonical `TmsResultStatus` **drops it** (`passed | failed | blocked |
  skipped`) rather than keeping a vague generic `'other'` value - `invalid` is only still
  reachable through the deprecated `--stage qase-submit-result` CLI path (see the stage list
  above), which maps it to `blocked` with a note appended to the comment before it reaches the
  generic client.
- `traceability/manifest.json`'s `qaseCaseId`/`qaseCaseHash`/`qaseCaseUpdatedAt` are now
  `externalCaseId`/`externalCaseHash`/`externalCaseUpdatedAt` (id stringified), plus a new
  `tmsProvider` field recording which provider that entry's case actually lives in.
  `output/qase-run.json` is now `output/tms-run.json`, with an added `provider` field.
  `scripts/migrateQaseToTms.ts` migrated the real, already-existing data (6 manifest entries, 1 run
  record) in place - a shape migration only, verified by hand afterward against the originals
  (same values, renamed fields, stringified ids).
- `.claude/agents/qase-agent.md` is now `tms-agent.md`, talking about "the configured test
  management provider (`TMS_PROVIDER`)" generically while keeping the real operational detail
  (bulk-upload-then-createRun, the immediate `traceability-record` follow-up, Qase rate-limit
  caution) unchanged.

## TMS Case Organization: Suites & Sub-suites

Cases used to all land in one flat list regardless of feature - `qaseClient.ts` never sent a
`suite_id` at all. `--stage tms-upload` now files every case into a two-level Suite > Sub-suite
structure automatically:

- **Suite** (top level) = the source Jira ticket's summary, fetched live via `jira.getIssue()` at
  upload time. One suite per ticket.
- **Sub-suite** (nested under it) = the scenario's own `specs/<feature>.plan.md` `### N. <group
  name>` heading (e.g. "Student Login", "My Subscriptions") - already-existing spec structure,
  parsed into `Scenario.suite` by `specParser.ts`, so nothing new needs authoring. Carried through
  the Excel sign-off sheet's new **Suite** column so a human's edits during review still land in
  the right place.
- Resolution is find-or-create, not always-create: `src/pipeline/testmgmt/suiteResolver.ts` (pure,
  unit-tested logic - no live Qase credentials needed to test it) checks a live suite list before
  creating anything, and `qaseClient.ts` caches resolved suite ids for the life of one upload so a
  batch of scenarios sharing a sub-suite only resolves it once.
- A fetch failure when getting the ticket summary isn't fatal to the upload - cases still get
  created, just with no `suite_id`, same as before this feature existed (see the warning
  `stageTmsUpload` logs in that case).
- **Existing cases created before this feature** (KAN-1) aren't touched automatically -
  `scripts/migrateCasesToSuites.ts --issue KAN-1` is a one-off, run-once-per-ticket migration that
  reads the case's `test.describe('<name>', ...)` name straight from the committed test file (not
  the originating spec, which may since have been deleted) as the sub-suite, and `PATCH`es the
  case's `suite_id` retroactively.

### One-off suite reorganization scripts

For reorganizing suites/cases *after* they already exist in Qase - a different job from
`migrateCasesToSuites.ts` above, which only backfills `suite_id` on pre-existing cases into the
automatic ticket-based structure. These are plain `npx tsx` scripts, no AI involved required to run
them - anyone on the team with a `.env` pointed at the right `QASE_API_TOKEN`/`QASE_PROJECT_CODE`
can run them directly.

- **`scripts/listQaseSuites.ts`** - prints every suite's exact `id` / `title` / `parent` as Qase
  has it stored. Run this first whenever a title-matching script below errors with "No suite
  titled ... exists" - Qase titles must match character-for-character (case, punctuation,
  whitespace), and this is faster than eyeballing a truncated title in the UI.
  ```
  npx tsx scripts/listQaseSuites.ts
  ```
- **`scripts/moveAutomatedCasesToSuite.ts`** - moves every case this pipeline has automated (i.e.
  every `traceability/manifest.json` entry for the active `TMS_PROVIDER`) into one flat target
  suite, across as many or as few Jira tickets as you like. Provider-agnostic: skips cleanly with a
  message if the configured provider has no suite concept.
  ```
  npx tsx scripts/moveAutomatedCasesToSuite.ts --dry-run                       # preview, no changes
  npx tsx scripts/moveAutomatedCasesToSuite.ts --suite "Some Suite"            # all tickets
  npx tsx scripts/moveAutomatedCasesToSuite.ts --suite "Some Suite" --issue KAN-7 --issue KAN-8
  ```
- **`scripts/moveSuiteUnderParent.ts`** - re-parents an already-existing suite (found by exact
  title match, no fuzzy matching) under a different top-level suite (found-or-created by title).
  Throws rather than silently creating anything if `--suite` doesn't match an existing title
  exactly - a typo'd suite name should fail loudly, not leave a confusing empty suite behind.
  ```
  npx tsx scripts/moveSuiteUnderParent.ts --suite "<exact existing title>" --parent "<exact or new title>"
  ```

Both `--suite`/`--parent`/`--issue` flags are required for anything beyond the two suites this
framework originally moved (the flags have no built-in mapping to "the next thing to reorganize" -
each run needs to be pointed at the real Qase titles explicitly).

## Adapter SDK

Four provider-agnostic interfaces, one per external dependency category, so this pipeline's core
logic never depends on a specific issue tracker, test management provider, test runner, or CI
host. `TestManagementClient` (above) was the first of these and proved the pattern - every
interface below follows its exact shape: a pure interface (`types.ts`), one adapter class per real
provider wrapping that provider's own raw client unchanged, and a factory (`index.ts`) that picks
the configured adapter and returns the interface type, never a concrete class, so call sites can't
accidentally depend on provider-specific behavior.

| Interface | File | Real adapters today | Selected by |
|---|---|---|---|
| `RequirementsSource` | `src/pipeline/requirements/types.ts` | `JiraAdapter` (`jiraAdapter.ts`, wraps `jira/jiraClient.ts`) | Only one provider exists - `getRequirementsSource()` has no switch yet |
| `TestManagementClient` | `src/pipeline/testmgmt/types.ts` | `QaseAdapter`, `TestinyAdapter` | `TMS_PROVIDER` env var / tenant `integrations.tms.provider` - see Test Management Provider Abstraction above |
| `TestRunner` | `src/pipeline/testRunner/types.ts` | `PlaywrightTestRunner` | Only one provider exists by design - the roadmap this was built against explicitly says "Playwright only, do not attempt Cypress/Selenium in this phase" |
| `CIProvider` | `src/pipeline/ci/types.ts` | `GithubCIProvider`, `GitlabCIProvider` | `CI_PROVIDER` env var, defaults to `github` |

- **`RequirementsSource`** - `getRequirement(key)`, `createBug(bug)`, `addComment(key, text)`,
  `getTransitions(key)`, `transitionRequirement(key, transitionId)`. `JiraAdapter` collapses
  `JiraClient`'s two-call `getIssue()` + `extractDescription()` into one `getRequirement()` call;
  the other four methods pass straight through. `getRequirementsSource()`
  (`src/pipeline/requirements/index.ts`) always returns a `JiraAdapter` today - add a `switch` on a
  new env var there (same shape as `CI_PROVIDER` below) when a second requirements source exists.
- **`TestRunner`** - `runFile(path, options)` / `runSuite(dir, options)`, both returning a
  `TestRunSummary` (`results: TestCaseResult[]`, `passed`, `failed`, `durationMs`).
  `PlaywrightTestRunner` shells out to `npx playwright test <target> --reporter=json`
  (`execFileSync`, same process-spawning pattern every guardrail check already uses - see CI
  Troubleshooting above) and parses Playwright's own real `JSONReport` shape
  (`src/pipeline/testRunner/parseJsonReport.ts`, checked field-for-field against the installed
  `node_modules/playwright/types/testReporter.d.ts`, not guessed). Playwright's JSON reporter
  exits non-zero when any test fails; the runner reads the report off the thrown error's own
  `stdout` rather than treating a failing test run as a script failure.
- **`CIProvider`** - `runGuardrailChecks(baseSha)` returns a `GuardrailCheckResult[]` covering the
  same 8 required checks `--stage verify-guardrails-locally` already runs (CI Troubleshooting
  above) - both `GithubCIProvider` and `GitlabCIProvider` call the exact same
  `runGuardrailChecks()` function (`src/pipeline/ci/guardrailRunner.ts`) for this, since the checks
  themselves have no GitHub/GitLab dependency at all. `reportCheckStatus(sha, result)` is where the
  two adapters actually differ - it posts to each host's own commit-status API:
  - `GithubCIProvider` → GitHub's Statuses API (`POST /repos/:repo/statuses/:sha`, via
    `GithubClient.createCommitStatus()`) - `state: success | failure`.
  - `GitlabCIProvider` → GitLab's Commit Status API (`POST /projects/:id/statuses/:sha`, via
    `GitlabClient.createCommitStatus()`) - `state: success | failed` (note: `failed`, not GitHub's
    `failure` - a real difference between the two hosts' own vocabularies, not a typo).
  - **Neither adapter's `reportCheckStatus` has been verified against a live host.** GitHub's
    adapter is unverified specifically on whether its check-name strings match this repo's real
    branch-protection required-check context strings (no network egress from the environment this
    was built in to confirm against Settings → Rules). GitLab's adapter is unverified more
    broadly - this repo has no GitLab remote, project, or account at all, so only the HTTP request
    *shape* has been confirmed real (a local test server caught and fixed a real double-URL-encoding
    bug in the project-id path segment before it shipped - see `gitlabClient.ts`'s doc comment).
    Confirm both against a real host before depending on either to replace a manual status check.

### Adding a fifth adapter

Same five steps regardless of which interface:

1. Add the new provider's credentials to `src/pipeline/config/env.ts` (one var per credential,
   following the existing `<PROVIDER>_TOKEN` / `<PROVIDER>_BASE_URL` naming already used by every
   adapter above).
2. Write a raw client for that provider's actual API (own file, e.g. `gitlabClient.ts`) - no
   knowledge of this pipeline's interfaces, just that provider's real wire format.
3. Write an adapter class implementing the relevant interface, wrapping the raw client from step 2
   - convert that provider's native shapes/vocabulary to the interface's canonical ones at this
   boundary only (e.g. `GitlabCIProvider` mapping `passed` to GitLab's `failed` instead of GitHub's
   `failure`), never further upstream.
4. Add the new adapter to that interface's factory (`index.ts`) - either a `switch` (matching
   `getTestManagementClient()`/`getCIProvider()`) if a selector env var already exists, or add one
   if this is the category's first-ever second adapter.
5. Test what's actually testable without live credentials: unit tests against a fake raw client
   (every adapter above has one - `FakeQaseClient`, `FakeJiraClient`, `FakeGitlabClient`, etc.) for
   the adapter's own translation logic, plus, for anything HTTP-based, a real local test server to
   confirm the actual request shape (path, headers, query/body params) is correct - cheap, real,
   and (per `GitlabCIProvider`'s own experience above) catches bugs a fake client's mocked
   `.post()` call never would.

## Page Object Contract

Any application this framework targets needs a `LoginPage` (or equivalent) exposing
`login(username, password): Promise<void>`, since `src/ui/fixtures/authenticated.ts` depends on
exactly that shape to log in before every authenticated test. Porting this framework to a new app
means: a new `.env` (`APP_BASE_URL` and that app's test credentials) plus a fresh Generator Agent
run to produce that app's real `src/ui/pages/*` page objects for its actual login flow - no framework
code changes needed. The app side (page objects, fixtures, generated specs) is already generic;
this is documentation of an existing implicit contract, not a new abstraction.

## Test Data via API

Generic, application-independent infrastructure for seeding test data through an app's REST API
instead of its UI, with guaranteed cleanup - built and proven against a free, live, purpose-built
practice app (**Restful-Booker-Platform**, `automationintesting.online`), not against the client application
Global, which stays blocked (see below).

**What's actually generic here, and what isn't - don't try to abstract the wrong part.** A booking
isn't a bank account isn't a subscription, so unlike the Test Management Provider Abstraction
above, there's no single interface whose methods mean the same thing across applications. What
*is* generic is the contract and the fixture-wiring plumbing, mirroring the Page Object Contract
above (`src/ui/fixtures/authenticated.ts` only requires whatever `LoginPage` exists to expose
`login(username, password)`, nothing app-specific):

- **`src/api/testData/types.ts`** - `TestDataFactory<T>`: `entityName`, `create(overrides?)`,
  `cleanup(entity)`. Application-independent by construction - says nothing about what `T` is or
  how create/cleanup talk to the app's API.
- **`src/ui/fixtures/withTestData.ts`** - `withTestData(factory)` turns any `TestDataFactory<T>` into
  a Playwright fixture function: create, then `use()`, then **`cleanup()` in a `finally` block** -
  structurally guaranteed, no per-app factory implementation can accidentally skip it. This is the
  actual reusable piece of this feature. Unit-tested with a fake factory (no live network) for the
  create/use/cleanup ordering, including that cleanup still runs when the test body throws, and
  that a `create()` failure never calls `cleanup()` on an entity that was never made.
- **`src/api/testData/booking.ts`** - `RestfulBookerBookingFactory implements TestDataFactory<Booking>`
  is the first concrete per-app implementation - **a template for the next app's factory, not
  something to generalize further.** Uses `axios` (matching `src/pipeline/jira/`'s and `src/pipeline/testmgmt/`'s
  existing client convention), authenticated via dedicated `RBP_AUTH_USERNAME`/`RBP_AUTH_PASSWORD`
  test credentials in `.env` (this practice app's own published demo credentials - never a real
  application session). Every created booking's `firstname` carries a `TEST-` tag so an orphaned
  record is identifiable and safe to hand-delete if a specific `cleanup()` call ever fails.
- **`src/ui/fixtures/testData.ts`** - `export const test = baseTest.extend({ booking:
  withTestData(bookingFactory) })`. **Deliberately extends Playwright's own base test, not
  `src/ui/fixtures/base.ts`** - `base.ts`'s `page` fixture navigates to `APP_BASE_URL` (the client app
  Global) unconditionally, which would be wrong here: this infra is application-independent by
  design, and its first concrete use targets a different app entirely. A test-data fixture meant
  to be reused across apps can't hard-wire one app's navigation.
- **`tests/test-data-demo/booking-visible-in-ui.spec.ts`** - the real proof, not a unit test in
  isolation: requests the `booking` fixture, searches availability for that exact booking's
  dates/room on the real homepage, and confirms the booked room drops out of the results (the real
  UI signal this app offers - it has no guest-name booking list in its own UI; booking data is
  only readable via the authenticated API). Teardown deletes it via the API once the test finishes.
  **Deliberately untagged** (`@smoke`/`@regression`/`@critical`) - it targets a third-party app,
  not this repo's own regression suite, so it never runs as a side effect of
  `npm run test:regression`/`test:critical`; run it directly:
  `npx playwright test tests/test-data-demo/booking-visible-in-ui.spec.ts`.

**Two real gotchas, confirmed empirically against the live API, not assumed from its docs/source:**

- **The deployed API's auth doesn't match its own published source.** The platform's Java source
  (`AuthController.java`) sets the token as an HttpOnly cookie; the live deployment does not - no
  `Set-Cookie` header at all. `POST /api/auth/login` returns `{"token": "..."}` in the JSON body,
  and the client is responsible for attaching it itself as a `Cookie: token=<value>` header on
  subsequent authenticated requests (confirmed working this way live). The create-booking response
  shape has similarly drifted from its own `CreatedBooking.java` model (flat, not nested).
  `booking.ts` was built against the real observed behavior, not the published source.
- **The platform does lose booking data over time - confirmed, not assumed.** The original
  investigation question was whether this platform auto-resets like the older, separate
  `restful-booker.herokuapp.com` (documented ~10-minute reset). It isn't scheduled or 10 minutes
  here specifically, but it's real: a sentinel booking created during investigation and never
  touched again was gone (404) roughly 15-20 minutes later, alongside other evidence of an
  id-reuse/reseed event in the same window. **This is exactly why `withTestData`'s `finally`-block
  teardown matters**: every test's own create -> verify -> cleanup cycle completes in seconds, well
  inside that window, so it never depends on - or gets confused with - the platform's own data
  loss. Confirmed by running the real test 5 times in a row and checking, via a follow-up API call
  (not just trusting the DELETE response), that no `TEST-`-tagged bookings were left behind.

**For whoever implements this against a real application next - carry this forward, don't let it
get lost just because the first implementation happened to target a safe practice sandbox:** the
original client test-data investigation's core safety concern was a client that creates
data but never cleans it up making the problem worse over time on a *production* system. Before
pointing a new `TestDataFactory<T>` at any real application, add an explicit
production-vs-staging safety gate (e.g. refuse to run unless a `TEST_DATA_ALLOW_PROD`-style env
var or an explicit staging base URL is set) - that question didn't apply to
Restful-Booker-Platform (a free public practice app with no real users or money behind it), but it
absolutely applies the moment `T` is something that costs money or affects a real user.

## Test Data via Purchase-Gated Packages: Manual, Not Automated

The six agents above all operate against a single pre-seeded, fixed test account
(`APP_TEST_USERNAME`/`APP_TEST_PASSWORD`) rather than creating fresh test data per run. Extending
that to purchase-gated packages (e.g. `UG_Automation_SAT`, package_id `20`, ₹1,000) was
investigated and **rejected** - both routes that could have automated it are blocked, for
independent reasons, and this isn't expected to change:

- **Direct API route - blocked by PCI-compliant client-side tokenization.** There is no JSON
  REST endpoint that accepts card details. Purchasing on the student panel
  (`packages/index.php` → `button[onclick="buyNow(20)"]`) POSTs only
  `{mode: "buy_now", package_id: 20}` (no card data) to the app's own
  `packages/api/checkout_create_order.php`, which returns an order id. Everything after that runs
  inside Razorpay's own hosted checkout iframe (`iframe.razorpay-checkout-frame`, sourced from
  `api.razorpay.com`): the card number, CVV, expiry, and cardholder name are submitted directly
  to `api.razorpay.com/v1/standard_checkout/payments/create/ajax`, confirmed from a real captured
  request body (`card[number]=...&card[cvv]=...`) - never to `app.example.com`. This is the
  standard PCI-DSS pattern (same category as Stripe.js/Braintree.js): the merchant's server never
  touches raw card data, so there is no endpoint to call directly even in principle.
- **UI-automation route (driving the real hosted checkout via Playwright) - independently
  blocked by bot/fraud-detection infrastructure**, not by the tokenization above. The merchant
  account itself is in Razorpay **test mode** (`key_id=rzp_test_T8F7eRqynRSPh8`, visible "Test
  Mode" banner), so a correctly-completed test-card payment (`4111 1111 1111 1111`, Razorpay's own
  published test Visa) should resolve in a few seconds. The payment request's own payload carries
  a `user_risk_providers_token` referencing **Sardine** (device fingerprinting) and
  **`stripe_radar`** (Stripe used here purely as a third-party risk-scoring signal, not as a
  payment processor), and is immediately followed by requests to `r.stripe.com/b` (Stripe Radar
  beacon) and a `collector-pxvl48pwoc.px-cloud.net` endpoint (a PerimeterX/HUMAN-style bot
  detection collector). Under Playwright automation, checkout stalls indefinitely on
  "Authenticating Payment" (confirmed stuck past 40s of polling, with `My Invoices & Purchases`
  search afterward showing no `UG_Automation_SAT` invoice was ever created - the stall is real,
  not just a slow UI update). The identical flow, same account, same test card, completes
  normally end-to-end in a manual, non-automated browser - isolating Playwright/CDP-driven
  automation itself, not the card or the merchant config, as what the fraud layer is reacting to.

**Conclusion: purchase-gated test data creation cannot be safely automated here, by either
route, and stays a manual step.** This is consistent with, not a departure from, how the rest of
this pipeline already works - the six existing agents all assume a pre-seeded fixed test account
rather than creating data per run. There is no purchase fixture for the client app in this repo,
deliberately - building one against a payment flow that stalls unpredictably under automation
would produce a flaky-by-design test, not a real improvement. `src/api/testData/` now exists (see
"Test Data via API" above), but its first, and so far only, concrete implementation targets a
different, safe practice app - not this blocked flow. If a future need for fresh purchase-gated
packages does come up, provision them by hand (as `UG_Automation_SAT` itself was) rather than
re-attempting either route above from scratch.

## Deviations from the spec

- **`src/pipeline/specs/specParser.ts` is a new module**, needed because scenario content now comes from a
  human-readable `specs/<feature>.plan.md` file (written by the Planning Agent) instead of a JSON
  blob from a generator function. It maps the plan's numbered steps and `- expect:` bullets onto
  the existing `Scenario` shape, including real per-scenario `**Precondition:**` and `**Priority:**`
  lines (group-level baseline with an optional scenario-level override for each - see
  `test-generation.md` section 1.4) rather than the flat `Seed: <path>`/hardcoded-`medium`
  placeholders this parser originally shipped with. A scenario with no `**Priority:**` line
  anywhere (its own or its group's) still defaults to `medium`, and can always be adjusted by hand
  in the sign-off sheet either way.
- **`QaseClient.submitResult` has no `runId` parameter**, matching the spec's listed signature
  `submitResult({caseId, status, comment})` exactly. Internally the client remembers the run id
  returned by the most recent `createRun()` call and uses it for subsequent submissions.
- **`src/playwright/testRunner.ts`, `failureParser.ts`, and `healer.ts` were deleted**, not just
  the `ai/` import removed from them. Their whole purpose was a bulk `--reporter=json` run feeding
  an LLM-based classify/patch loop; that's superseded entirely by the Healer Agent's interactive
  `--debug=cli` / `playwright-cli attach` workflow (skill Section 3), which needs no supporting TS
  module. Keeping a gutted version around with the LLM calls stripped out would just be dead code.
- **Env vars are validated lazily, per-client** (`requireEnv` in `src/pipeline/config/env.ts`) rather than
  all upfront, so a single stage (e.g. `--stage jira`) can be debugged without also configuring
  Qase credentials.
- **The Traceability Agent lives at `src/pipeline/traceability/`, not `agents/traceabilityAgent.ts`**,
  matching this repo's actual convention (`src/pipeline/jira/`, `src/pipeline/testmgmt/`, etc.) rather than a
  standalone `agents/` directory, which doesn't otherwise exist here.
- **The "Generator Agent hook" became a TMS Agent hook** (Qase Agent at the time this decision was
  made; the agent was later renamed - see Test Management Provider Abstraction above). Generation
  happens *before* case ids exist in this pipeline's real order (Plan → Generate → Excel sign-off →
  review → TMS upload → Healer), so a manifest entry can't be created at generation time. It's
  created immediately after `tms-upload` instead - the first point where jiraKey + externalCaseId +
  testFilePath are all known together.
- **`specs/<feature>.plan.md`'s `**File:**` line is now parsed** into an optional
  `Scenario.testFilePath`, needed to link a scenario to its generated file. Excel-sourced scenarios
  don't have it (no such column in the sign-off sheet), so it's optional, not required.
- **No "both orphaned" sync state.** If a test file's on-disk copy and its Qase case are *both*
  missing, `checkDrift` reports `ORPHANED_TEST` (see the comment in `traceabilityAgent.ts`) since
  the spec's six states don't include a combined case.
- **`healer-agent.md` had no classification step and no handling for passing tests before this
  feature.** Diagnosis was "your own reasoning" with no structured output, and tests that passed on
  the initial run were never mentioned again in the instructions at all. Both were added (see the
  Healing Telemetry section above) - there was nothing to record telemetry about otherwise.
- **Healing telemetry recording is final-outcome-only**, per the resolved open call above, not
  once-per-attempt as literally suggested in one framing of the spec.
- **The strict/weak matcher table extends the starting proposal** with `toBe` (strict),
  `toBeGreaterThan` and `toBeEmpty` (weak) - 48% of real assertions in the suite used one of these
  three, none of which were in the original two-bucket list.
- **`src/pipeline/assertionGuard/suppression.ts` is a fourth module**, not in the original 3-file list, so
  the line-scoped-vs-test-scoped suppression logic isn't buried inside the orchestrator.
- **A fully deleted assertion falls back to test-scoped suppression**, not line-scoped, since a
  deleted line has nothing left in the new file to anchor a "line immediately preceding" comment
  to. One consequence: a single test-scoped comment clears every deletion-type finding in that
  test, not just one specific deletion, since there's no line left to disambiguate between them.
- **`test.fixme` missing-comment only flags when the fixme is newly introduced**, not for a
  pre-existing uncommented fixme that a PR leaves untouched - matching the literal "a *new*
  `test.fixme`" wording rather than a blanket retroactive completeness check.
- **No `paths:` filter on `assertion-integrity.yml`**, to avoid GitHub's required-path-filtered-
  check-blocks-forever trap - see the Assertion Integrity Guardrail section above.
- **Option A (real ESLint custom rule) was abandoned for Option B (`ts-morph` script)** after
  installing `eslint`/`@typescript-eslint/parser`/`@typescript-eslint/utils` and empirically
  confirming `@typescript-eslint/parser` hard-refuses to run on `typescript@7.0.2` - not a peer
  range that `--legacy-peer-deps` could paper over. Those three packages were uninstalled again;
  `package.json` has no ESLint dependency.
- **`src/pipeline/shared/` is a new top-level directory**, holding `suppressionComment.ts` - the
  line-immediately-above-with-required-reason convention generalized and parameterized by tag, so
  the Locator Priority Guardrail could reuse it instead of duplicating
  `src/pipeline/assertionGuard/suppression.ts`'s logic. That existing file was left untouched rather than
  refactored to use the shared version, since it's already shipped and tested.
- **`.github/workflows/locator-priority.yml` is a separate workflow file**, not an additional step
  in `assertion-integrity.yml`, per the reasoning in the Locator Priority Guardrail section above.
- **The wrapper is session-level (`scripts/run-with-cost-telemetry.sh`) plus orchestrator hooks
  (`planning-agent.md`'s `cost-marker` calls), not a `scripts/run-agent.sh <agent-name>` per-agent
  process wrapper** as the spec's literal shape suggested - confirmed this project's six agents run
  as nested subagent calls within one session, not separate OS processes, so there's no process
  boundary to wrap individually.
- **`parseAgentLog.ts` does delta computation between marker-bounded snapshots**, not a single
  end-of-session read, because `claude_code.cost.usage`/`token.usage` are cumulative counters that
  share one series across *different* subagents with the same `(model, effort)` - discovered from a
  real multi-agent spike, not assumed from the metric names.
- **`src/pipeline/shared/isoWeek.ts` is a new shared module**, extracting `isoWeekKey()` out of
  `healingReport.ts` (which now re-exports it) since `costReport.ts` needed the identical logic a
  third time.
- **`.claude/settings.local.json` needed a permission fix** (`"Bash(npm run pipeline *)"` added to
  the allow-list) discovered by a live end-to-end run producing silently-zero markers - not
  something inspecting the code would have caught, since the marker-writing code itself was
  correct throughout.
- **No CI workflow for Cost & Latency Accounting** - not requested in the spec's build order,
  unlike the other three telemetry/guardrail features.
  
