import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { RECOGNIZED_MANIFEST_STAGES } from '../traceabilityGuard/checkManifestProvenance';

/**
 * The prepare-commit-msg hook (scripts/hooks/prepare-commit-msg) stamps the
 * `Traceability-Stage:` trailer that the Manifest Provenance guardrail requires. For the hook to
 * know WHICH stage to name, the orchestrator drops the stage here whenever it runs one of the
 * manifest-mutating stages. The marker lives in .git/ (per-clone, untracked) and the hook consumes
 * it on the next commit that stages manifest.json.
 *
 * Best-effort by design: outside a git work tree (CI checkouts, unit tests) or for a stage that
 * never touches the manifest, this is a no-op, and a missing marker simply means the committer adds
 * the trailer themselves (exactly today's behaviour) - the CI guard is unchanged either way.
 */
export const MANIFEST_STAGE_MARKER_FILE = 'TRACEABILITY_LAST_STAGE';

export function recordManifestStageMarker(stage: string, gitDirOverride?: string): void {
  if (!(RECOGNIZED_MANIFEST_STAGES as readonly string[]).includes(stage)) return;

  let gitDir = gitDirOverride;
  if (!gitDir) {
    try {
      gitDir = execFileSync('git', ['rev-parse', '--git-dir'], { encoding: 'utf8' }).trim();
    } catch {
      return; // not a git work tree - nothing to stamp against
    }
  }
  try {
    writeFileSync(join(gitDir, MANIFEST_STAGE_MARKER_FILE), `${stage}\n`, 'utf8');
  } catch {
    // best-effort: a missing marker just falls back to the manual trailer + the CI guard
  }
}
