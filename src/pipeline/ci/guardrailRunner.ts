import { checkAssertionIntegrity } from '../assertionGuard/checkAssertionIntegrity';
import { checkLocatorPriority } from '../locatorGuard/checkLocatorPriority';
import { checkTraceabilityCoverage } from '../traceabilityGuard/checkTraceabilityCoverage';
import { checkManifestProvenance } from '../traceabilityGuard/checkManifestProvenance';
import { checkSpecFileConsolidation } from '../traceabilityGuard/checkSpecFileConsolidation';
import { checkSecretsCommitted } from '../policyGuard/checkSecretsCommitted';
import { checkForbiddenPlaywrightPatterns } from '../policyGuard/checkForbiddenPlaywrightPatterns';
import { checkRequiredTags } from '../policyGuard/checkRequiredTags';
import { GuardrailCheckName, GuardrailCheckResult } from './types';

export interface GuardrailCheckDefinition {
  name: GuardrailCheckName;
  run: () => { exitCode: number; report: string };
}

/**
 * The real 8 checks, same functions and same names as pipeline.ts's own 'verify-guardrails-locally'
 * stage (src/pipeline/orchestrator/pipeline.ts) - imported from the same modules, not
 * reimplemented, so this can never silently drift from what that stage (and CI itself) actually
 * checks. Built as a function (not a static array) since every check but checkLocatorPriority()
 * needs baseSha closed over at call time.
 */
export function buildRealGuardrailChecks(baseSha: string): GuardrailCheckDefinition[] {
  return [
    { name: 'Assertion Integrity Check', run: () => checkAssertionIntegrity(baseSha) },
    { name: 'Forbidden Playwright Patterns Check', run: () => checkForbiddenPlaywrightPatterns(baseSha) },
    { name: 'Locator Priority Check', run: () => checkLocatorPriority() },
    { name: 'Manifest Provenance Check', run: () => checkManifestProvenance(baseSha) },
    { name: 'Required Test Tags Check', run: () => checkRequiredTags(baseSha) },
    { name: 'Traceability Coverage Check', run: () => checkTraceabilityCoverage(baseSha) },
    { name: 'Spec File Consolidation Check', run: () => checkSpecFileConsolidation(baseSha) },
    { name: 'Secrets Guardrail', run: () => checkSecretsCommitted(baseSha) },
  ];
}

/**
 * Runs a list of guardrail check definitions and maps each to a GuardrailCheckResult - same
 * try/catch-per-check behavior as pipeline.ts's 'verify-guardrails-locally' stage (a thrown error,
 * e.g. an invalid baseSha git can't resolve, must not take down the whole run - the entire point
 * is a full picture across all 8, so one check's crash still surfaces as that one FAIL rather than
 * hiding the other checks' real results behind an uncaught exception).
 *
 * Takes `checks` as a parameter (defaulting to the real 8 via buildRealGuardrailChecks) so this is
 * directly unit-testable with fake check definitions, without needing a real git repo/base SHA.
 */
export function runGuardrailCheckDefinitions(checks: GuardrailCheckDefinition[]): GuardrailCheckResult[] {
  return checks.map((check) => {
    try {
      const { exitCode, report } = check.run();
      return { name: check.name, passed: exitCode === 0, report };
    } catch (err) {
      return {
        name: check.name,
        passed: false,
        report: `THREW: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  });
}

export async function runGuardrailChecks(baseSha: string): Promise<GuardrailCheckResult[]> {
  return runGuardrailCheckDefinitions(buildRealGuardrailChecks(baseSha));
}
