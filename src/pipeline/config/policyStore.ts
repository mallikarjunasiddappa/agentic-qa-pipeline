import fs from 'node:fs';
import path from 'node:path';
import { Policy, PolicySchema } from '../types/schemas';

export const POLICY_PATH = path.join('policy.json');

/**
 * Loads and validates policy.json - the deterministic-rules config the policy-driven guardrails
 * (checkSecretsCommitted.ts, checkForbiddenPlaywrightPatterns.ts, checkRequiredTags.ts) read
 * instead of hardcoding their forbidden-pattern/required-tag/forbidden-filename lists inline. A
 * missing file is a hard error, not a silent empty-policy fallback - unlike traceability/
 * manifest.json (which legitimately starts out empty on a brand-new repo), a missing policy.json
 * almost always means it was accidentally deleted or the repo was checked out wrong, and a
 * guardrail silently passing everything because its rules "loaded empty" would be exactly the kind
 * of quiet failure this whole guardrail architecture exists to avoid.
 */
export function loadPolicy(policyPath: string = POLICY_PATH): Policy {
  if (!fs.existsSync(policyPath)) {
    throw new Error(
      `${policyPath} not found - the policy-driven guardrails (secrets, forbidden Playwright ` +
        'patterns, required test tags) have no rules to check without it. If this repo genuinely ' +
        "has none of those rules yet, create one with `{ \"policyVersion\": 1 }\` explicitly " +
        '(all three rule lists default to empty) rather than leaving the file absent.',
    );
  }
  const raw = JSON.parse(fs.readFileSync(policyPath, 'utf-8'));
  return PolicySchema.parse(raw);
}
