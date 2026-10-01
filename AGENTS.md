# Project rules for AI agents

You are working in a Playwright TypeScript automation project. Follow these rules for every code
change - regardless of which AI tool you are (Claude Code, Antigravity, Codex CLI, Cursor, GitHub
Copilot, or a human contributor). This file is the single, canonical source of truth for this
project's engineering rules; tool-specific files (`CLAUDE.md`, etc.) import it rather than
restating it, specifically to avoid two copies of the rules quietly drifting apart over time.

**Enforcement status matters more than wording here.** A rule written in this file is a request -
any tool reading it can still get it wrong, skip it under pressure, or simply not read this file
at all. Rules marked ✅ below are also mechanically enforced by a CI guardrail on every pull
request (see `policy.json` and `src/pipeline/*Guard/`), which checks the *result* in the PR diff,
not which tool produced it - a PR from any of the tools listed above is judged identically, and
cannot merge if it fails. Rules marked 🕐 are planned but not yet enforced. Rules with no mark are
judgment calls that don't reduce to a mechanical check and stay a PR-review responsibility.

## Stack

- Playwright 1.56+ with TypeScript
- Node 22+ (Node 20 reached end-of-life April 2026 - no more security patches. Node 22 is
  Maintenance LTS through April 2027; Node 24 Active LTS is preferred for new setups)
- Test runner: @playwright/test
- Reporter: Allure + built-in HTML
- CI: GitHub Actions, sharded

## Folder structure

UI and API automation are kept in separate, parallel trees under `src/` and `tests/` so it's
always clear which domain a file belongs to. `src/pipeline/` is the orchestration/agent
infrastructure (Jira, TMS, Excel, traceability, guardrails, telemetry) - not test code, and never
holds UI/API automation code.

- `src/ui/pages/` — UI Page Object classes (one file per page)
- `src/ui/fixtures/` — UI fixtures extending base test (browser/`page`-based)
- `src/ui/testData/` — UI-specific static test data
- `src/api/clients/` — API request-wrapper classes (the API equivalent of a page object - one per
  resource/endpoint group)
- `src/api/fixtures/` — API fixtures extending base test (Playwright's `request` fixture - no
  browser needed for pure API tests)
- `src/api/testData/` — API-specific test-data factories
- `tests/ui/` — UI spec files, mirror the app's URL structure
- `tests/api/` — API spec files, mirror the API's resource/endpoint structure
- `tests/data/` — JSON/CSV test data shared across UI and API where genuinely shared
- `specs/` — Planner output (Markdown plans)

When adding a genuinely new domain folder (not UI, not API), ask before creating it rather than
inventing a third top-level convention. 🕐 (planned: flag any new top-level folder under `src/`/
`tests/` outside this list)

## Coding conventions

- Import test from the relevant domain's base fixture - `src/ui/fixtures/base.ts` for UI tests,
  `src/api/fixtures/base.ts` for API tests - never from `@playwright/test` directly
- Use `test.describe` per feature area
- One logical assertion group per test
- Use `test.step` for readability when a flow has more than 3 actions
- File names: kebab-case (`add-to-cart.spec.ts`) 🕐

## Locator priority (STRICT — do not deviate)

1. `getByRole` with accessible name
2. `getByLabel` for form fields
3. `getByTestId` (attribute is `data-test-id`)
4. `getByText` only for genuinely static UI text
5. CSS / XPath — forbidden unless approved in PR

✅ Enforced: Locator Priority Guardrail (`src/pipeline/locatorGuard/`).

## Page Object contract

- One class per page, extends `BasePage`
- Constructor takes `page: Page` only
- All locators declared as `readonly` in constructor
- Action methods return `Promise<void>` OR the next page object
- No `expect()` calls inside page objects — assertions belong in tests 🕐 (planned: flag `expect(`
  inside `src/ui/pages/**`, `src/api/clients/**`)
- No business logic in tests — put it in page objects or helpers

## Assertion rules

- Web-first assertions only (`expect(locator).toBeVisible()`) ✅ Enforced: Assertion Integrity
  Guardrail (`src/pipeline/assertionGuard/`).
- No `page.waitForTimeout` — ever ✅ Enforced: Forbidden Playwright Patterns check
  (`policy.json` → `forbiddenPlaywrightPatterns`, `src/pipeline/policyGuard/`).
- No `waitForSelector` — use locator auto-waiting ✅ Enforced: same check as above.
- Custom timeouts only when justified in a code comment

## When adding a new test

- UI: mirror the app URL structure inside `tests/ui/`. API: mirror the API's resource/endpoint
  structure inside `tests/api/`
- Reuse existing page objects (UI) or API clients (API) — do not create parallel infra
- Load test data from `tests/data/` or the relevant domain's `testData/`, not inline
- Tag tests with `@smoke`, `@regression`, or `@critical` as appropriate ✅ Enforced: Required Test
  Tags check (`policy.json` → `requiredTestTags`, `src/pipeline/policyGuard/`).
- Spec file naming is your call, not a fixed convention: it's whatever the plan's **File:** line
  says (`specs/<feature>.plan.md`, default `tests/<feature>/<feature-name>.spec.ts`) - edit that
  line before approving Gate 1 if you want a different name. If a file already exists and is
  linked in `traceability/manifest.json` and you want to rename it *afterward*, never `mv`/`git mv`
  it by hand - that silently breaks the manifest's `testFilePath` link and the Traceability
  Coverage guardrail will only catch it later, in CI. Use `npm run traceability:rename --
  --test-file <old-path> --new-path <new-path>` instead: it moves the file and updates every
  matching manifest entry together, then prints the exact commit command (with the required
  `Traceability-Stage: rename-spec-file` trailer) to run afterward. See README's Traceability
  section for details.

## Forbidden

- Do not skip or comment out failing tests to make CI green 🕐
- Do not use `page.evaluate` unless there is no MCP tool alternative
- Do not commit `.env`, credentials, `storage-state.json`, or auth tokens ✅ Enforced: Secrets
  Guardrail (`policy.json` → `forbiddenCommittedFilenames`, `src/pipeline/policyGuard/`) - this is
  the one hard block in this whole rulebook with no suppression/override mechanism at all,
  deliberately, given the severity of a committed credential.
- Do not modify `playwright.config.ts` without asking 🕐
- Do not add new npm dependencies without asking 🕐
- Do not use `page.pause()` in committed code ✅ Enforced: same Forbidden Playwright Patterns
  check as `page.waitForTimeout`/`waitForSelector` above.

## When you (the agent) are unsure

- Ask a clarifying question before generating code
- Prefer a smaller, focused change over a big refactor
- If a required file does not exist, ask before creating it

## Git workflow

- Every CI guardrail in `.github/workflows/` triggers on `pull_request` only (none has a `push`
  trigger) - a direct push to `master` runs none of them, including the manifest-provenance and
  spec-file-consolidation checks. Land non-trivial changes through a PR against `master`, not a
  direct push.
- Whenever an agent hands off push/PR instructions to a human, always include a ready-to-use PR
  title and summary alongside the exact push command - don't make the person ask for it
  separately.

## Known environment issues

Standing, already-diagnosed issues - treat them as known characteristics to work around, not
something to re-diagnose from scratch each time they show up.

**Environment vs. tool - read (and write) every item below this way.** These are properties of
*where an agent runs*, not of *which tool it is*. The same tool behaves differently in a restricted
cloud sandbox than on a developer's own machine, so a rule phrased as "agents can't do X" is almost
always really "agents *in environment Y* can't do X." Before you conclude a limitation applies to
you, decide it from YOUR OWN environment - a quick probe, or simply knowing you run locally with the
repo's `.env` - never from a blanket sentence. When you ADD or EDIT an item here, name the environment
it applies to and give the capability check, not a flat prohibition (see the egress and TS-toolchain
items for the shape). A blanket rule that was really environmental has already caused repeated,
needless blocking - an in-IDE agent refusing a Jira stage it could have run.

### Local file reverts / stale `.git` locks (repo owner's machine)

On the repo owner's machine, something (suspected: Cisco Secure Endpoint, an IT-managed EDR
agent - confirmed present via Windows Security, not something the local user can disable)
intermittently reverts recently-written files back to older content and leaves stale
`.git/index.lock` or `.git/HEAD.lock` files behind ("File exists" errors with no real git process
running). This is not a bug in pipeline code - confirmed by tracing the actual manifest-writing
logic and finding it correct; the file was reverting to content no command in the session had
produced.

Until this gets an IT-side exclusion (blocked as of this writing - no reachable IT contact), work
around it rather than debug it fresh each time:

- Batch multi-step edits into a single script/write instead of several small sequential ones.
- Chain write -> `git add` -> `git commit` -> `git push` into one command line with no pauses.
- Treat "pushed and independently re-verified against the remote" as the only safe checkpoint -
  not a command's success output, and not local state, which isn't trustworthy on this machine
  until the root cause is fixed.
- On a lock error, don't restart the whole sequence - clear the stale lock file and retry just the
  commit/push step.

### GitHub-side issue: required PR checks stuck at "Expected - Waiting for status to be reported"

On this repo, the 8 required status checks (Assertion Integrity, Locator Priority, Traceability
Coverage, Manifest Provenance, Spec File Consolidation, Secrets Guardrail, Forbidden Playwright
Patterns, Required Test Tags) sometimes never transition off "Expected - Waiting for status to be
reported" on a PR, even though their workflow files are byte-identical to `master`'s (branch drift
ruled out by direct diff) and their required-check names in Settings -> Rules match the real job
names exactly (typo/mismatch ruled out by direct inspection). Confirmed reproducible identically
across at least three separate PRs. This is a GitHub-side issue, not a bug in this repo's workflow
config or guardrail logic - treat it as a known, currently-unfixable characteristic. A support
ticket was recommended; check whether it's been filed/resolved before assuming this workaround is
still needed.

Until resolved, verify locally before merging via GitHub's "Merge without waiting for requirements
to be met (bypass rules)":

```
npm run verify-guardrails-locally -- --base-sha <PR's merge-base with master>
```

Runs all 8 required checks in-process (`pipeline.ts`'s `verify-guardrails-locally` stage) against
the given base SHA and prints one pass/fail summary - reuses the exact same check functions each
individual `--stage <check>` case already calls, so it can never silently drift from what CI
itself checks. Get the base SHA via `git merge-base master <branch>`. Only bypass-merge once every
one of the 8 shows PASS here - this is a substitute for GitHub's broken status reporting, not a
shortcut past the actual guardrails.

### Network egress to Jira/TMS/Anthropic depends on WHERE you run (not on which tool you are)

Some `--stage` commands call external hosts: Jira (`jira`, `jira-transition*`, `groom-check-fetch`,
`sprint-status`, `standup-digest`, `blocker-scan`, `dev-status`, `burndown-report`, `retro-notes-*`,
`settings-update`'s Jira-touching paths), a TMS provider (Qase/Testiny), or the Anthropic API
(`flag-requirement-gaps-headless`, and any future headless Generator/Healer stage). Whether *you* can
run them yourself depends on your execution environment:

- **Restricted cloud sandboxes have NO egress to these hosts.** Claude Code's cloud environment and
  Cowork's sandbox route nowhere near Jira/Qase/Anthropic, so these stages hang indefinitely with no
  error - a fixed characteristic of those sandboxes that retrying, changing flags, or waiting never
  fixes. If you are in one, you cannot run these stages: hand off the exact command to the repo owner
  to run on their machine, and continue once they paste real output back. Say so up front, before
  attempting the call.
- **An agent running on a developer's own machine CAN run them.** An in-IDE agent (Antigravity,
  Cursor, Codex CLI, Copilot) or a local Claude Code run executes in the developer's own shell, with
  the repo's `.env` credentials and normal network - so it should run these stages itself and NOT
  pre-emptively hand off. This is a real, repeated failure mode: an in-IDE agent read the old blanket
  wording here and refused a `--stage jira` it could have run, blocking the human for nothing.

Decide which case you are in from your own environment - by knowing you run locally with the repo's
`.env`, or by making one real call and seeing - never from a blanket assumption. Rule of thumb: hand
off ONLY when your own environment genuinely cannot reach the host.

### A 4xx from Jira/TMS is NOT an egress problem - the request reached the host

Egress (above) is about *never reaching* the host. Its opposite is reaching the host and getting an
HTTP status back: an authenticated 401, a 403, or a 404. These are credential/permission/data
problems, and they must never be reported as "no egress" or handed off as if the network were
unreachable - the network plainly worked. `JiraClient` now throws a `JiraApiError` that says which
case it is (`classifyJiraFailure` in `src/pipeline/jira/jiraClient.ts`); read its `message`, do not
re-guess from a raw stack. When a `--stage jira` run fails:

- **404 "Issue does not exist or you do not have permission to see it."** The issue key may be wrong,
  OR - far more often - the account behind `JIRA_EMAIL` in `.env` lacks *Browse* permission on that
  issue's project (Jira returns 404, not 403, to hide existence from users who can't see it). Being
  able to see other tickets is not enough: a different project, or issue-level security, can hide
  this one. Fix: confirm the key; open the ticket in a browser *as the `.env` account*; if that
  account can't see it, have a project admin grant it access - do not touch the pipeline code.
- **401 Unauthorized.** `JIRA_EMAIL` and `JIRA_API_TOKEN` don't form a valid pair - a stale/revoked
  token, or a token generated by a different account than the email. Regenerate the token at
  id.atlassian.com -> Security -> API tokens for the *same* account named in `JIRA_EMAIL`.
- **403 Forbidden.** Authenticated, but the account lacks permission for that specific action (e.g.
  transitioning or commenting). Grant the permission to that account.

Only a failure with *no HTTP response at all* (a hang, `ECONNREFUSED`, `ETIMEDOUT`, `ENOTFOUND`, a
proxy error) is the egress case from the previous section. If you got a status code, you reached
Jira - diagnose the credentials/permissions, never the network.

### The TS toolchain needs `node_modules` built for the OS it runs on

`tsx`/esbuild loads a native binary matched to the platform `node_modules` was installed on. Running
the TS toolchain (`npm run typecheck`, `npm run test:unit`, `npm run pipeline -- --stage ...`) from a
Linux shell against a `node_modules` installed on Windows - e.g. a cloud sandbox that mounts a Windows
checkout, this repo's Cowork setup - fails with an esbuild "installed for another platform" error.
This is environmental, not a code bug: an agent running natively on the developer's own machine
(matching OS) runs all of it normally. Never run `npm install`/`npm ci` inside a mounted checkout to
"fix" it - that overwrites the owner's native binaries. If you are the cross-platform case, hand the
toolchain command to the owner (same pattern as egress above); reading and editing source is always
fine.

## Scrum Master Automation Program

Planned across four docs in `docs/planning/` - read the Continuity Log first, every session; it is
the index, not the implementation spec.

`docs/planning/` is gitignored from *this* repo but is, as of August 21, 2026, its own separate
private git repo, initialized in place at that same path with its own remote - not just
local-only scratch space. Treat edits there like any other tracked work: commit with a real
message and push to that private remote, the same "don't leave local state as the only copy"
standard applied everywhere else in this project. No PR requirement and no CI guardrails there
(it's docs-only, low-stakes) - a direct commit + push to its `main` is fine.

- `Project Decisions and Continuity Log.docx` - **read this first.** Current-state snapshot and
  standing decisions - tells you what's done, what's in flight, and where to look next. Not itself
  the source of truth for architecture or build order.
- `Scrum Automation Option 1 - Technical Document and Plan of Action.docx` - **the implementation
  reference.** Architecture, phased build spec, duty breakdown, and open questions. This is the
  doc to build against for "how does X work" or "what does Phase N deliver" questions.
- `Scrum Master Solo Work Split Plan.docx` - task-level ownership (Primary vs. Helper) and
  sequencing - who does what, not what to build.
- `Issue Tracker Abstraction Future Plan.docx` - narrow reference, not active work. Read only when
  a real client needs a non-Jira issue tracker (Azure DevOps, Linear, etc.); records the naming
  decision already locked into `scrum/config.json` to keep that switch cheap.

`Scrum Master Automation Plan.docx` (the original 7th-agent proposal) is superseded by the
Technical Document above - historical only, moved to `docs/planning/archive/`.

Keep the Continuity Log's "Current State Snapshot" updated as work lands - it going stale has
already cost a round of unnecessary re-verification once.
