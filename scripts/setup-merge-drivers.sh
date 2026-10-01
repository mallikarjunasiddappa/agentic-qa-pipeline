#!/usr/bin/env bash
# Thin wrapper. The real, cross-platform setup lives in setup-merge-drivers.mjs and also runs
# automatically on `npm install` (see the "postinstall" script in package.json). Kept for manual
# re-runs: bash scripts/setup-merge-drivers.sh
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
exec node scripts/setup-merge-drivers.mjs
