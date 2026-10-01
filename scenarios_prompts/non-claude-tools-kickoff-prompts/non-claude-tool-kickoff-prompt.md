# Kickoff prompt for non-Claude tools (Antigravity, Cursor, Codex CLI, etc.)

Claude Code auto-loads `CLAUDE.md` (which imports `AGENTS.md`) at the start of every session, so a
Claude Code teammate gets this repo's rules automatically. Other tools don't - so paste the prompts
below at the start of a session before asking your AI tool to do anything on this repo. This gets
you to the same starting point a Claude Code session gets for free.

Two parts: a **framework preamble** (paste once, at the start of any session) and a **per-ticket
prompt** (fill in and paste for each new Jira ticket you automate).

---

## Framework preamble (paste once per session)

```
Before doing anything else, read these files in full and follow them exactly - they are this
repo's rules, not suggestions, and CI will block your pull request if you don't:

1. AGENTS.md (repo root) - the coding rules: locator priority, assertion rules, page object
   contract, forbidden patterns, folder structure. Non-negotiable.
2. .claude/agents/planning-agent.md, jira-agent.md, excel-agent.md, tms-agent.md,
   generator-agent.md, healer-agent.md - read all six. Ignore the YAML frontmatter at the top of
   each file (name/description/tools - that's Claude Code's own subagent registration, not part
   of the instructions); the body of each file describes that pipeline stage's responsibilities
   and applies to you the same way it applies to Claude.
3. .claude/skills/playwright-cli/references/test-generation.md - the actual plan/generate/heal
   process: how to structure a spec file, the shared-spec-file-per-ticket default (every scenario
   for one Jira ticket goes in one file unless there's a real reason to split), and the
   `// scenario-id:` marker every multi-test file requires.

Do not use a Playwright MCP server, or any browser-automation MCP tool, for this repo. This
project drives Playwright directly through the `playwright-cli` CLI and the `npm run pipeline`
CLI, deliberately, so every step is inspectable and goes through this pipeline's own traceability
and CI guardrails. Automating a test through an MCP Playwright integration bypasses all of that
and will not be accepted - if you don't have playwright-cli / npm run pipeline available in your
environment, stop and ask rather than substituting a different tool.

Everything you do funnels through `npm run pipeline -- --stage <name> ...` commands - Jira fetch,
Excel sign-off, TMS upload, traceability record/link, test generation, healing. These are plain
CLI commands, not Claude-specific - run them the same way regardless of which tool you are.

This pipeline has three human approval gates enforced in code, not just as a convention:
- Gate 0: `--stage approve-requirements` (after `--stage flag-requirement-gaps`)
- Gate 1: `--stage approve-scenarios` (before Excel/TMS sign-off can run)
- Gate 2: `--stage approve-test-cases` (before test generation can run)
Do not skip ahead of a gate by generating the next stage's output yourself "to save time" - the
CLI stage itself refuses to run until the corresponding gate has actually been approved
(`assertGateApproved` in pipeline.ts), so working around it just means the next stage will error
out anyway. Stop and wait for me to run the approval command myself.
```

---

## Per-ticket prompt (fill in and paste for each new ticket)

```
Ticket: <JIRA-KEY> - <short summary>
Spec/scenario file: <path, e.g. specs/<feature>.plan.md - create it if it doesn't exist yet>

Start at: <Planning / Jira / Excel / TMS / Generate / Heal - whichever stage we're at>

Do not proceed past this stage until I explicitly confirm it:
- After scenarios are drafted, stop and show them to me. Do not run Excel sign-off or TMS upload
  until I confirm and run `--stage approve-scenarios` myself (Gate 1).
- After test cases are in the Excel sign-off sheet, stop and show me. Do not run TMS upload or
  test generation until I confirm and run `--stage approve-test-cases` myself (Gate 2).

When generating tests: follow test-generation.md's default - every scenario for this ticket
lands in one shared spec file (multiple test.describe blocks, one per group, each scenario
marked with `// scenario-id: <id>`) unless there's a real, stated reason to split it across more
than one file. If you do split it, say why in your summary to me before I commit - CI will block
the PR without an explanation either way (Spec File Consolidation Check).
```

---

## Why this exists

Every rule referenced above is enforced by a CI guardrail that runs on any pull request regardless
of which tool produced it (`src/pipeline/*Guard/`, wired into GitHub Actions - see README.md's
guardrail sections). Skipping this kickoff prompt doesn't mean you can skip the rules - it just
means you'll find out about a violation from a failing check instead of up front. Pasting these
prompts first just saves the failed-check-and-retry cycle.
