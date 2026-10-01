# Run prompt — one end-to-end pass for KAN-1 (paste into Claude Code)


## PROMPT START

Before doing anything else, read `CLAUDE.md` and every agent definition under
`.claude/agents/` (jira-agent.md, planning-agent.md, excel-agent.md,
qase-agent.md, generator-agent.md, healer-agent.md) plus
`.claude/skills/playwright-cli/references/test-generation.md`. Confirm you've
read all of them, then run one full pipeline pass for Jira ticket **KAN-1**:

1. **Jira Agent** — fetch KAN-1 (summary, description, acceptance criteria).

2. **Planning Agent** — using KAN-1's content plus live exploration of
   `https://app.example.com/auth/login` (via `APP_BASE_URL`), write
   `specs/<feature>.plan.md` per the skill's Plan section. **Stop and show me
   the spec for review before continuing** — do not proceed to test-case
   generation until I confirm it.

3. **Excel Agent** — once I approve the spec, convert its scenarios into a
   `.xlsx` sign-off sheet and **stop and show it to me for review**. Only
   after I confirm, hand off to **Qase Agent** to upload the reviewed
   scenarios as test cases into Qase under the **DEMO** project
   (`QASE_PROJECT_CODE=DEMO` in `.env` — add it if it isn't already there).

4. **Generator Agent** — for every scenario in the approved spec, generate a
   real Playwright TypeScript test under `tests/<group>/<scenario>.spec.ts`
   per the skill's Generate section, following the project's existing Page
   Object Model conventions (reuse `src/pages`, don't restate POM guidance
   that's already documented elsewhere in the skill/agent files — just follow
   it). Run each generated test and confirm it's stable — not flaky, not a
   one-off pass — before moving to the next scenario.

5. **Healer Agent** — for any test that fails or is flaky, diagnose and fix
   per the skill's Heal section. If a failure turns out to be a real app bug
   (confirmed with me per the skill's 3.4/3.5 rule, not assumed), stop
   healing that one and hand it to:

6. **Jira Agent** — file a bug for each confirmed-real failure, linked back
   to KAN-1 (mention KAN-1 in the description or as a linked issue), and
   submit a `failed` result for the matching case in **Qase Agent**. For
   every scenario that ends up passing stably, submit a `passed` result to
   Qase instead.

7. Once every scenario has either a passing, stable automated test or a
   filed Jira bug with a `failed` Qase result, use **Jira Agent** to check
   KAN-1's available transitions and move it to whatever transition
   represents "done"/"ready for review" in this project's workflow — if more
   than one transition could plausibly apply, list the options and ask me
   which one instead of guessing.

8. Along the way, fix `tests/fixtures.ts` (or wherever the seed `base.ts`
   fixture lives) so the seed navigates to `APP_BASE_URL` and completes login
   using `APP_TEST_USERNAME` / `APP_TEST_PASSWORD` from `.env`, so every
   generated scenario starts from an authenticated state rather than the bare
   login page — this is the seed every Plan/Generate/Heal session attaches to,
   per the skill's seed-fixture pattern.

Pause at the two review checkpoints in steps 2 and 3 — everything else can run
straight through, but tell me what you're about to do at each major step
rather than going silent until the end.

