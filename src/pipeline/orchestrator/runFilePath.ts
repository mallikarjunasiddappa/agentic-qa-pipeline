import { env } from '../config/env';
import { tenantDataPath } from '../config/tenantContext';

/**
 * Per-ticket run file path - "output/tms-run-<jiraKey>.json" - instead of the single shared
 * "output/tms-run.json" every ticket used to overwrite. That shared name meant uploading a second
 * ticket silently clobbered the first ticket's run/case mapping, leaving --stage tms-submit-result
 * unable to resolve the first ticket's cases even though they still existed in the TMS - same
 * class of bug buildScenarioFileName (excelWriter.ts) already fixed for the Excel sign-off sheet.
 *
 * Split into its own module (rather than living inline in pipeline.ts) purely so it can be
 * imported for unit testing without pulling in pipeline.ts's module-level `main()` call.
 */
export function buildRunFilePath(jiraKey: string): string {
  const slug = jiraKey
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return tenantDataPath(env.OUTPUT_DIR, `tms-run-${slug}.json`);
}
