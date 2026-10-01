# Spec (DRAFT v3): LLM Manual-Tester Agent — Persona Exploration + Ticket-Driven Verification

> **Status:** design of record — Phase 1 shipped (PR open). Reuses the existing pipeline
> (playwright browser driving, Jira agent, Planning agent, traceability, capability gating, cost
> telemetry) rather than starting a parallel system.
> **Author:** Mallikarjuna · **Date:** 2026-09-30 · **Rev:** v3.2
> **v3 changes:** adds **Mode B — ticket-driven manual verification**; adds the **verify → automate**
> lifecycle (both modes feed one scripted-regression bridge); desktop-web framing (not mobile);
> prod/staging payment split; test account resolved.
> **v3.1:** no staging env exists → signup persona parked, payment-through-renewal out of scope;
> renewal persona unblocked (package available on prod); Mode B first target = **SCRUM-76**.
> **v3.2:** promotion **records the scenario from the passed run's trace** (steps + real elements +
> live-confirmed assertions) instead of re-exploring the app; the Generator only hardens locators +
> pins data (§6, §11 Phase 2).

---

## 1. Why this exists

The six-agent pipeline generates **scripted, governed regression tests from a known requirement** —
it guards what we already expected. This agent covers the rest of what a human QA does by hand:

- **Mode A — Persona exploration:** emergent, goal-driven wandering of the live app to surface
  friction and bugs no script was written for (no oracle — discovery).
- **Mode B — Ticket-driven verification:** read a Jira ticket, execute its acceptance criteria live
  in the browser, judge pass/fail against those criteria, and write findings back to the ticket
  (the ticket **is** the oracle — verification).

Both are the runnable form of "LLM as a manual tester," and both hand their results to the *same*
scripted pipeline — a confirmed bug becomes a regression test, and a **passed** ticket verification
is promoted into a regression test too. That feedback loop (§6) is the differentiator.

**Thesis:** one system that runs governed regression *and* LLM manual testing — with manual results
hardening into regression — is rarer and more defensible than either alone.

---

## 2. Two modes, one agent

Same module, same browser driving, same evidence capture, same Jira agent, same human gate, same
traceability. Only the **input frame** and the **output** differ.

| | **Mode A — Persona** | **Mode B — Ticket-driven** |
|---|---|---|
| Input frame | "You are a hurried parent…" | "Verify Jira KAN-XX's acceptance criteria" |
| Oracle | none — emergent | the ticket's acceptance criteria |
| Best at | discovering unknown friction / bugs | confirming a specific requirement, live |
| Output | filed bug (gated) | Jira **comment** + linked bug (gated) |
| Determinism | non-deterministic (different path each run) | bounded by the ticket's steps |
| Feeds regression via | confirmed bug → §6 | **pass → §6**, or fail-bug → §6 |

---

## 3. Where it sits (reuses, never re-implements)

A new agent alongside the existing seven (`.claude/agents/manual-tester-agent.md`), owning a new
`src/pipeline/dogfood/` module. It reuses:

- **playwright browser driving** — same attach/snapshot/click mechanic Generator and Healer use.
- **Planning agent** — turns a ticket's acceptance criteria into an executable step path (Mode B).
- **Jira agent** (`jiraClient.ts`) — reads tickets, `createBug`, and a **new `addComment`** method
  (small addition; auth already wired via `JIRA_*` in `.env`). The agent never calls Jira directly —
  it hands findings to the Jira agent (one-client-per-system rule).
- **Healer's evidence capture** — console + screenshots on any odd/failing step.
- **Traceability manifest** — a filed finding, a ticket comment, and any regression test synthesised
  from either, all link back to the session that produced them.
- **Capability gating / cost markers / tenant config** — identical patterns to every other stage.

**Runs on the owner's machine, not the agent sandbox** — needs the live app, a real browser, and
Jira egress, none of which the sandbox has (known env issue #3).

---

## 4. Mode A — Persona-driven exploration

### 4.1 Starter personas (desktop web app)

Three personas for Phase 1, in `config/tenants/<tenantId>/personas.json` (zod-validated, loaded like
`scrum.json`). Each is a *prompt frame* — the agent behaves as this user, pursues their goals, and
reacts with their habits/blind spots, not a script. **All run in a desktop browser** (the app is a
web app tested on laptop; the "hurried" traits describe impatience, not a phone).

1. **`browsing-student`** — exploring test types, papers and packages with no fixed goal; low
   commitment, easily distracted. Best for dead-ends and navigation friction. **Lowest-risk — pure
   read/browse, ideal first persona, needs no package on the account.**
2. **`first-time-onboarding`** — new user signing up and finding their way around. Surfaces onboarding
   friction and unclear first-run labels. **PARKED — no staging exists.** Signup on prod would create
   real accounts and trigger live Twilio SMS + SendGrid email, so this persona is out of Phase 1 scope
   until a staging env exists (see §10).
3. **`hurried-parent-renewal`** — desktop browser, low patience, wants to renew a child's package
   fast, skims labels, expects Amazon-like flows. Exercises the renewal flow **up to (never through)
   the payment gateway.** **Unblocked — package renewal is available on the prod test account;** a
   near-expiry package is ideal but not required to exercise the funnel.

```jsonc
{
  "id": "hurried-parent-renewal",
  "displayName": "Hurried parent renewing a test-prep package",
  "goals": ["renew my child's package before it expires", "reach checkout quickly"],
  "context": "Desktop browser, low patience, skims labels, expects Amazon-like flows",
  "habits": ["clicks the first plausible button", "abandons if a step is unclear", "doesn't scroll below the fold"],
  "blindSpots": ["ignores fine print", "misses secondary nav"],
  "startUrl": "https://app.example.com/...",
  "account": "APP_TEST_USERNAME (env ref only; never inline secrets)",
  "outOfBounds": ["no payment submit", "no account deletion", "no admin areas"]
}
```

### 4.2 The exploration loop (one session)

1. **Load** persona + tenant config; open the app at `startUrl` as the seeded test account (§10).
2. **Explore, in character** — pursue each goal the way the persona would. Bounded by a **step budget
   (~40 interactions)**, a **time-box (~10 min)**, and the `outOfBounds` hard stops.
3. **Log friction** as a structured `FrictionEvent` per confusion / error / dead-end / label mismatch
   / console error / broken state. Snapshot + console each time.
4. **Self-critique (trust calibration)** — before filing, re-check each event: "real product defect,
   a persona misunderstanding worth noting but not filing, or my own misread?" Only reproducible
   defects pass. The noise gate.
5. **Human confirmation gate (§7)** — filing requires a recorded human approval.
6. **File** each approved finding via the Jira agent; record the Jira key.
7. **Emit the coverage record** (§8); for confirmed defects, promote to a regression test (§6).

---

## 5. Mode B — Ticket-driven manual verification

The mode that has an **oracle**, so it can judge *correctness*, not just usability.

### 5.1 The verification loop (one ticket)

1. **Read the Jira ticket** — description + acceptance criteria (Jira agent; `JIRA_*` already in env).
2. **Derive the manual steps** — Planning agent turns the AC into an executable path
   ("as a student, do X, expect Y").
3. **Execute it live** in the desktop browser on the test account.
4. **Compare actual vs the ticket's expected** — per acceptance criterion: met or not?
5. **On a deviation** — capture evidence (screenshot + console), and draft a **bug**: ticket ref,
   numbered repro, **expected (from the AC) vs actual**, severity.
6. **Human confirmation gate (§7)** — present the drafted **Jira comment + bug**; a human approves.
7. **Write back to Jira** — post the approved **comment on the ticket** and/or file a linked bug.
8. On **PASS**, hand the **recorded trace** — the exact steps taken, the real elements interacted
   with, and the live-confirmed assertions — to §6 for promotion (this is what lets the pipeline
   *record* the scenario rather than re-explore the app).

### 5.2 The two guards that keep it trustworthy

- **App-wrong vs ticket-stale.** The nastiest failure is a vague/outdated AC where the app is
  actually fine and the agent files a false bug. So the self-critique step asks: *"is the app
  genuinely violating the AC, or is the AC ambiguous / am I misreading it?"* When the AC is too vague
  to judge, the output is a **comment flagging the ambiguity**, not a bug.
- **Every Jira write is human-gated (§7).** No auto-posting of comments or bugs — ever.

---

## 6. The lifecycle: verify → automate (the bridge — both directions)

A scripted regression test is the destination for **both** modes, from **both** outcomes:

- **A confirmed bug** (Mode A or B) → once fixed → a regression test that guards against its return.
- **A passed ticket verification** (Mode B) → the verified, oracle-backed flow is promoted directly:
  the agent already has the steps, the AC-as-assertions, the selectors, and evidence of the correct
  end state.

Both routes emit a `specs/<feature>.plan.md` scenario in the exact format the **Generator agent**
consumes; the scenario **auto-opens Gate 1** (scenario approval), so it enters the *same* governance
every generated test goes through. One review flow, whether a test came from a requirement, from
exploration, or from a passed verification.

**Record from the trace, don't re-explore (the key efficiency).** Because a passed Mode-B run already
*drove the app down the real path*, promotion consumes its **recorded trace** — the exact steps, the
**real elements** it interacted with, and the **assertions it confirmed live** — instead of
re-exploring the app to work out how to drive it. The scenario is *recorded from a proven run*, and
its expected results ship **already verified**, not assumed-until-first-run the way a requirement-only
generation is. What remains is cheap and targeted, not exploration: the Generator **hardens the
recorded elements into stable locators** (getByRole → getByLabel → getByTestId → getByText; no
CSS/XPath) and the **test data is pinned**. So the Generator's job shrinks from "explore + generate"
to "harden + assert" — and Gate 1 review still applies.

**Determinism caveat on "pass → automate":** a manual/exploratory pass can take incidental paths, so
promotion **pins it down** — fixed test data, stable selectors, exact AC-derived assertions — and the
pinned test still passes **Gate 1 human review** before it becomes a permanent gate. Flaky or
data-dependent flows are not auto-promoted blind.

> **Worked example — practice test + result:** the *journey* of finding and taking a practice paper
> is Mode A (persona) — usability and breakage. "Answered X → score is **exactly** Y" is **not** a
> persona job; it needs an oracle. Mode B (a ticket whose AC states the expected score) or a scripted
> test using the app's own **`correct_answer` / `test_questions`** answer-key tables provides that
> oracle. Verify once with an oracle, then automate the correctness check.

Exploration/verification finds it once; the pipeline guards it forever.

---

## 7. Human confirmation — non-negotiable

Every side effect on a real system is **human-gated, code-enforced** (like Gates 0–2 in the pipeline):

- Filing a **bug** (Mode A or B).
- Posting a **Jira comment** (Mode B).
- Promoting a finding/verification into a **scripted regression test** (Gate 1).

The agent **drafts**, presents, and waits for a recorded approval; only then does it write. Filing
stages throw without the approval, exactly like `excel-write` / `tms-upload`. No silent writes to
Jira or the test suite.

---

## 8. Coverage intelligence

Each session emits a structured coverage record (`data/<tenantId>/dogfood/session-<id>.json`): routes
visited, goals/criteria completed vs abandoned, where friction clustered, which tickets verified.
Aggregated over sessions this becomes a **coverage graph** — what personas and tickets actually
exercise vs the app's real surface — the core of the exploratory-coverage-intelligence idea, and
something scripted suites can't produce.

---

## 9. New stages (mirroring existing conventions)

Gated by a new `manualTesting` capability flag; all cost-marked; none cron-wired initially. Add each
to `STAGE_CAPABILITY_MAP` (the exhaustiveness test enforces this — learned on suite-health).

**Mode A**
- `--stage dogfood-run --persona <id>` — one exploration session; writes friction log + coverage
  record. No side effects beyond local files (and bounded in-app actions, §10).
- `--stage dogfood-approve --session <id>` — record the human filing approval (the Gate).
- `--stage dogfood-file --session <id>` — file approved findings via the Jira agent.

**Mode B**
- `--stage ticket-verify --ticket <KEY>` — read ticket, execute AC live, write pass/fail + evidence
  to a local session record. No Jira write yet.
- `--stage ticket-verify-approve --session <id>` — record the human approval for the Jira write.
- `--stage ticket-verify-comment --session <id>` — post the approved comment / file the bug via the
  Jira agent (throws without the approval).

**Both**
- `--stage promote --session <id> --item <id>` — emit a `specs/*.plan.md` scenario (from a confirmed
  bug or a passed verification) and open Gate 1 (§6).

---

## 10. Safety & guardrails — PRODUCTION target (read twice)

Running against **production** (`app.example.com`) raises the stakes; guardrails are not optional.

- **Seeded, disposable test account only** — `APP_TEST_USERNAME` from the pipeline `.env`, by
  reference; credentials never inlined (Secrets Guardrail).
- **`outOfBounds` is a hard stop, enforced in code** — no payment submission (stop at the gateway),
  no deletes, no admin, no destructive actions. Renewal goes *up to* payment, never through it
  (same boundary the repo already respects).
- **No card entry, ever.** The agent never types card details or completes a real payment. On prod,
  renewal is therefore verifiable only as a **pre-payment funnel** (find → select → reach checkout),
  not as a completed purchase.
- **No staging exists — money and account-creation flows are out of scope.** There is no staging env
  or Razorpay test mode, so full renewal *through* payment **cannot be automated safely**, and
  `first-time-onboarding` signup **stays parked** (running signup on prod would create real accounts
  and trigger the app's **live Twilio SMS + SendGrid email** — not acceptable). Renewal is therefore
  a **pre-payment funnel on prod, indefinitely**, until a staging env exists.
- **Profile edits are careful.** Editing the *shared* test account's profile can disturb other
  pipeline tests — prefer read/verify, or edit-and-revert, or a dedicated account before enabling
  profile mutation.
- **Filing and all Jira writes are human-gated (§7).**
- **Adversarial self-critique before filing** — the noise filter for both modes.
- **Be gentle on prod** — modest pacing; honour the same rate-limit courtesy the Qase client uses.

| Environment | Renewal persona can… | Signup persona | Payment |
|---|---|---|---|
| **Production** (the only env) | funnel up to the payment screen (no card, no submit) | ✗ parked | ✗ never |
| **Staging + Razorpay test mode** | *does not exist — full renewal / signup / payment automation is blocked until one is built* | — | — |

---

## 11. Phased build

- **Phase 1 (MVP):**
  - Mode A: persona schema + `dogfood-run` + gated `dogfood-approve` / `dogfood-file`. Personas:
    **`browsing-student`** (no package) and **`hurried-parent-renewal`** (renewal funnel — package
    available on prod). `first-time-onboarding` excluded (no staging).
  - Mode B: `ticket-verify` + gated `ticket-verify-approve` / `ticket-verify-comment` + `addComment`
    on the Jira agent. **First target: SCRUM-76.**
  - Proves both loops end to end against the existing test account.
- **Phase 2:** `promote` (the verify→automate bridge → Gate 1), for both bugs and passed
  verifications. The `promote` stage consumes the manual session's **recorded trace** (steps + real
  elements + live-confirmed assertions) — so it *records* the scenario directly rather than
  re-exploring the app; the Generator then only hardens locators + pins data (§6). This means the
  `ticket-verify` session must **capture the trace** during the live run (an implementation add for
  Phase 2). More tickets and personas as they prove out.
- **Phase 3:** cross-session coverage graph + report (json+md+html, same writer pattern as the other
  stages) — the exploratory-coverage-intelligence core.

---

## 12. Decisions — resolved & remaining

**Resolved (2026-09-30):**
- Target: **production**, desktop web (`https://app.example.com/auth/login`), guardrails
  per §10. Money/account-creation flows → staging.
- **Test account: `APP_TEST_USERNAME` (`test-user@example.com`)** already in the pipeline `.env`,
  read by reference (password never printed/inlined) — the same account the rest of the pipeline uses.
- Starter personas: **browsing-student, hurried-parent-renewal** on prod (**renewal is available on
  the prod test account** — persona unblocked); **first-time-onboarding parked — no staging exists.**
- **No staging environment** → payment-through-renewal and signup automation are out of scope until
  one is built; renewal stays a pre-payment funnel on prod.
- **Mode B first ticket: SCRUM-76** (`your-team.atlassian.net/browse/SCRUM-76`).
- **Mode B (ticket-driven verification)** added, with gated Jira comment/bug writes.
- **Human confirmation required** for every bug, every Jira comment, and every promoted regression
  test.
- Synthesised tests **auto-open Gate 1** (§6); "pass → automate" pins data/selectors/assertions first.
- Defaults: step budget ~40 interactions, time-box ~10 min per session (tune after first runs).

**Still to confirm before Phase 1 build:**
- That **SCRUM-76 has usable acceptance criteria** for Mode B to verify against (needs a look at the
  ticket — a vague AC means Mode B can only comment, not pass/fail).
- Concrete **prod start URLs** per persona / per verified flow.
- Whether the prod package is **near-expiry** (nice-to-have for the renewal persona; not blocking).
