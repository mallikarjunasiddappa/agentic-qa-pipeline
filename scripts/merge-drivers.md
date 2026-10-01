# Traceability manifest & telemetry — automatic merge

**TL;DR:** `data/**/traceability/manifest.json` and the append-only `data/**/*.jsonl`
telemetry logs used to throw a merge conflict on almost every parallel PR. They now
**merge automatically**. Each developer runs a **one-time setup** after cloning (or once now,
on an existing clone).

## Why they always conflicted

`manifest.json` is a single, pretty-printed JSON array that:

- **every branch appends to** — `traceability-record` / `traceability-link` add entries at the
  end of the same array, and
- **drift-check rewrites in place** — `syncState` / `lastCheckedAt` on existing entries change
  on `master` independently of your branch.

Git merges **lines**, not **JSON**, so two branches touching the tail of the same array (or the
same entry's drift fields) collide every time. The `.jsonl` telemetry logs (`cost`, `flaky`,
`healing`, `markers`) are append-only and collide the same way.

## The fix

A JSON-aware git **merge driver** (`scripts/merge-manifest.mjs`) that merges `manifest.json`
by **entry identity** instead of by line:

- **Union** — every entry from *both* sides is kept. No one's case data is ever lost.
- **Newer wins** — when the *same* entry (same jiraKey + externalCaseId + testFilePath +
  testTitle) differs on both sides, the one with the more recent timestamp is taken. Drift state
  is recomputed on the next `drift-check` anyway.
- **Fail-safe** — if either side isn't valid JSON, the driver exits non-zero and git falls back
  to normal `<<<<<<<` conflict markers. It never writes malformed JSON.

The `.jsonl` logs use git's built-in **`union`** driver — both sides' lines are kept.

Both are wired up in `.gitattributes` (committed, shared by everyone).

## One-time setup (required, per clone)

`.gitattributes` is shared, but a merge driver's *definition* lives in each clone's local
`.git/config`, so every developer runs this once:

**Windows (PowerShell):**

```powershell
.\scripts\setup-merge-drivers.ps1
```

**macOS / Linux:**

```bash
bash scripts/setup-merge-drivers.sh
```

That's it. From then on, `git pull` / `git merge` resolve these files automatically. (`node`
must be on your PATH, which it already is for this repo.)

## How to know it worked

```bash
git check-attr merge data/default/traceability/manifest.json
#   -> manifest.json: merge: manifest-merge
git config --get merge.manifest-merge.driver
#   -> node scripts/merge-manifest.mjs %O %A %B %P
```

## Verified

- Unit-tested: shared-entry reconciliation (newer wins), both-sides-append union, duplicate
  entries preserved (no false dedup), broken-JSON fallback, empty base.
- End-to-end: a real `git merge` that previously conflicted now completes with **0 conflict
  markers**, all entries from both branches present.

## Longer-term recommendation (team decision)

The merge driver removes the pain, but the deeper cause is the **pretty-printed JSON array**
format. If the pipeline stored the manifest as **JSONL** (one entry per line, append-only) —
like the telemetry logs already are — the built-in `union` driver alone would handle it, with no
custom script. That's a pipeline change worth considering when someone next touches the
traceability writer; the merge driver is the pragmatic fix until then.

## Files

| File | Purpose |
|---|---|
| `scripts/merge-manifest.mjs` | The JSON-aware merge driver |
| `scripts/setup-merge-drivers.ps1` / `.sh` | One-time-per-clone registration |
| `.gitattributes` | Routes manifest → driver, `*.jsonl` → union (committed) |

## Automatic `Traceability-Stage` trailer (prepare-commit-msg hook)

`manifest.json` is also guarded by the **Manifest Provenance** check: any commit that changes it
must carry a `Traceability-Stage: <stage>` trailer explaining which pipeline stage produced the
change. That used to be a manual step everyone forgot, so almost every "recorded a new test" PR
got blocked on it.

It is now automatic:

- When the pipeline runs a manifest-mutating stage (`traceability-record`, `traceability-link`, …)
  it records the stage name in `.git/TRACEABILITY_LAST_STAGE`
  (`src/pipeline/traceability/manifestStageMarker.ts`).
- A `prepare-commit-msg` hook (`scripts/hooks/prepare-commit-msg`) stamps
  `Traceability-Stage: <stage>` onto any commit that stages `manifest.json` and does not already
  carry a trailer. It skips merges, and if it cannot tell (a rare hand-edit) it warns instead of
  blocking.

The hook is installed by the **same one-time setup** as the merge drivers — the setup scripts now
also set `git config core.hooksPath scripts/hooks`, so there is nothing extra to run. The CI
Manifest Provenance check is unchanged: this removes the toil, not the protection.

## Now automatic on `npm install`

You no longer need to remember the one-time setup above. `package.json` has a `postinstall` script
that runs `scripts/setup-merge-drivers.mjs` on every `npm install` / `npm ci`, so a fresh clone is
configured automatically (merge drivers + the prepare-commit-msg hook). The manual command still
works if you ever want to re-run it:

```bash
npm run setup:git      # or:  node scripts/setup-merge-drivers.mjs
```

It is safe to run repeatedly and is a no-op outside a git work tree.
