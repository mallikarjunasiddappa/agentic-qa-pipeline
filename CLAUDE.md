@AGENTS.md

The engineering rules above apply to you exactly as written - they are not Claude-specific
suggestions, they are this repo's one canonical rulebook, also read natively by Antigravity,
Codex CLI, and Cursor. Do not treat anything in this file as looser or advisory just because it
arrived via import.

## Claude Code specifics

Everything else this repo needs any tool to know - git workflow, the two known environment issues,
the Scrum Master Automation Program's doc index - now lives in `AGENTS.md` itself (moved there
Aug 25, 2026: none of it was actually Claude-specific, and leaving it here meant Antigravity/
Codex/Cursor contributors on this repo would never see it). This section is genuinely
Claude-Code-only:

- The six-agent pipeline (Planning, Jira, Generator, Excel, TMS, Healer) and the
  plan/generate/heal workflow are defined in `.claude/agents/*.md` and
  `.claude/skills/playwright-cli/references/*.md` - read those before dispatching or acting as one
  of these agents.
- Cost/latency telemetry markers (`npm run pipeline -- --stage cost-marker ...`) bracket every
  agent dispatch - see `planning-agent.md` and the README's Cost & Latency Accounting section.

Work is currently solo-led (Primary = repo owner). Tasks marked "Helper" in the Scrum Master Work
Split Plan (`docs/planning/`) are deferred until a second contributor joins - not delegated
automatically.
