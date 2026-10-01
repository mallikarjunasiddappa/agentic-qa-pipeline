#!/usr/bin/env bash
# Starts a Claude Code session with cost/token telemetry enabled, capturing the raw console
# exporter output to data/<tenantId>/cost/raw/session-<timestamp>.log for later parsing.
#
# This wraps the whole session, not one agent - confirmed (see README's Cost/Latency Accounting
# section) that this project's six agents run as nested subagent calls within one Claude Code
# session, not as separate OS processes, so there is no per-agent process to wrap individually.
# Per-agent attribution instead comes from planning-agent.md's cost-marker calls around each
# subagent dispatch, correlated against this log by `--stage cost-record`.
#
# TENANT_ID env var, defaulting to 'default' - mirrors resolveTenantId()'s env-var-then-default
# fallback (tenantContext.ts), minus the --tenant CLI flag precedence, since this is a standalone
# bash wrapper with no arg parser of its own. Was a bare repo-root cost/raw/ before the Phase -1
# tenant migration moved every other cost-telemetry path (MARKERS_LOG_PATH,
# COST_TELEMETRY_LOG_PATH) under data/<tenantId>/ - that repo-root path was never updated to
# match, so it silently wrote outside .gitignore's data/*/cost/raw/*.log rule (a real risk: a
# careless `git add -A` could commit raw session logs that were never meant to be tracked) and,
# for anyone other than the 'default' tenant, into the wrong tenant's directory entirely.
set -euo pipefail

TENANT_ID="${TENANT_ID:-default}"
mkdir -p "data/${TENANT_ID}/cost/raw"
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
log_file="data/${TENANT_ID}/cost/raw/session-${timestamp}.log"

echo "Cost telemetry -> ${log_file}"
# Piping claude's own stdout into `tee` makes claude see a non-tty stdout, which makes it drop
# into non-interactive `--print` mode and immediately error out with no prompt given. On
# Windows/Git Bash, `winpty` (ships alongside Git for Windows) gives the wrapped process a real
# pseudo-console so it still detects an interactive tty even though its combined output is also
# being captured to a file. On Linux/macOS this problem generally doesn't occur the same way, so
# only reach for winpty when it's actually on PATH.
CLAUDE_RUNNER=(claude)
if command -v winpty >/dev/null 2>&1; then
  CLAUDE_RUNNER=(winpty claude)
fi

CLAUDE_CODE_ENABLE_TELEMETRY=1 \
  OTEL_METRICS_EXPORTER=console \
  OTEL_METRIC_EXPORT_INTERVAL=1000 \
  "${CLAUDE_RUNNER[@]}" "$@" 2>&1 | tee "${log_file}"

echo ""
echo "Session ended. Record cost events for the agents that ran with:"
echo "  npm run pipeline -- --stage cost-record --log ${log_file}"
