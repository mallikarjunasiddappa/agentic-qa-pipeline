import path from 'node:path';

/**
 * Resolves which tenant the current CLI invocation runs as. Precedence: --tenant flag, then
 * TENANT_ID env var, then the hardcoded 'default' tenant - so every existing CI guardrail, cron
 * job, and doc example that calls `npm run pipeline -- --stage ...` with neither set keeps
 * working unchanged, landing on 'default'. Pure function (no direct process.env/argv reads) so
 * it's testable without env mocking - same pattern as teamConfig.ts's resolveOperator().
 */
export function resolveTenantId(cliTenant?: string, envTenantId?: string): string {
  return cliTenant || envTenantId || 'default';
}

// Filesystem-and-git-safe tenant id: lowercase alphanumeric + hyphens, must start with an
// alphanumeric. This string becomes a literal data/<tenantId>/ path segment - rejecting anything
// else up front (like ".." or a path separator) means a typo'd --tenant never silently writes
// outside data/, it fails loudly instead.
const TENANT_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export function assertValidTenantId(tenantId: string): void {
  if (!TENANT_ID_PATTERN.test(tenantId)) {
    throw new Error(
      `Invalid tenant id "${tenantId}" (from --tenant or TENANT_ID) - must match ` +
        `${TENANT_ID_PATTERN.source} (lowercase alphanumeric and hyphens, starting with a ` +
        'letter or digit). This value becomes a literal data/<tenantId>/ path segment.',
    );
  }
}

let currentTenantId: string | undefined;

/**
 * Set once in main(), immediately after parseArgs() and before any stage branch runs - every
 * tenant-scoped path in this pipeline is resolved through getTenantId()/tenantDataPath() below,
 * so nothing reads or writes a real path until this has been called for a real CLI invocation.
 */
export function setTenantId(tenantId: string): void {
  assertValidTenantId(tenantId);
  currentTenantId = tenantId;
}

/**
 * Falls back to 'default' when unset rather than throwing - keeps every existing unit test that
 * imports a path-constant function (e.g. MANIFEST_PATH()) working without needing to call
 * setTenantId() first in test setup, consistent with "nothing should require --tenant/TENANT_ID
 * to be set" extended to programmatic/test contexts too. Real CLI runs always set it explicitly
 * in main(), immediately after parseArgs() and before any stage handler runs.
 */
export function getTenantId(): string {
  return currentTenantId ?? 'default';
}

/** Only for tests that need to reset state between cases. */
export function resetTenantIdForTests(): void {
  currentTenantId = undefined;
}

/** The single choke point every tenant-scoped path constant routes through. */
export function tenantDataPath(...segments: string[]): string {
  return path.join('data', getTenantId(), ...segments);
}
