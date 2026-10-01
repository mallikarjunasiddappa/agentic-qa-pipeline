# Thin wrapper. The real, cross-platform setup lives in setup-merge-drivers.mjs and also runs
# automatically on `npm install` (see the "postinstall" script in package.json). Kept for manual
# re-runs: .\scripts\setup-merge-drivers.ps1
$ErrorActionPreference = "Stop"
Set-Location (git rev-parse --show-toplevel)
node scripts/setup-merge-drivers.mjs
