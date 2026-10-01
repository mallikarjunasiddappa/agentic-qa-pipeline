// No top-level import of @azure/identity or @azure/keyvault-secrets, deliberately - both are
// real, non-trivial SDKs to load (measured ~9s and ~2s respectively on a cold require() in this
// environment), and every tenant not on 'azure-key-vault' would otherwise pay that cost on every
// single pipeline invocation, since env.ts (which every stage imports transitively) imports this
// module. Loading is deferred to AzureKeyVaultSecretsProvider.getClient()'s first real call
// instead, via a lazily-created require() (see that method) - so a deployment where every
// tenant is still on the 'env-file' default (true for both real tenants today) never touches
// the Azure SDK at all.
//
// require(), not a dynamic import(): @azure/identity's dependency chain includes at least one
// CommonJS-only package whose named exports Node's native ESM loader cannot statically resolve
// (observed: "the requested module 'https-proxy-agent' does not provide an export named
// 'HttpsProxyAgent'") when pulled in via a real dynamic import() under this project's ESM
// runtime. require() (obtained via node:module's createRequire, since this file is itself an ES
// module with no ambient require) sidesteps that interop check entirely - Node's CJS loader just
// reads whatever the module actually exports at runtime, same as it always has for every other
// require() in this codebase's dependency graph.
//
// This provider only ever calls one method on the real SecretClient, so it's typed against a
// minimal structural interface rather than the SDK's own SecretClient type. That sidesteps a
// real dual-package hazard: @azure/keyvault-secrets ships separate ESM and CommonJS builds whose
// SecretClient declarations both carry a private #client-ish field, and depending on where a
// dynamic import()'s type is resolved from (a static `import type`, a `typeof import(...)` type
// query, or the value position inside an async function), TypeScript can pick different
// (structurally incompatible, "private property" mismatch) declaration files for what is
// actually the same class at runtime. A structural interface has no private members, so it's
// satisfied by either declaration and by the real runtime instance alike.
interface MinimalSecretClient {
  getSecret(secretName: string): Promise<{ value?: string }>;
}

/**
 * Per-tenant secrets backend abstraction - the Secrets-manager fix (per-tenant credential
 * isolation). Every tenant's Jira/Slack/email/GitHub credentials used to live together in one
 * flat .env file (env.ts's resolveTenantEnv()/requireTenantEnv(), the <KEY>__<TENANT> override
 * pattern) - a single compromised .env exposed every tenant's credentials at once, with no
 * per-tenant access control and no audit trail of who read what.
 *
 * This interface lets a tenant's credential resolution be swapped onto a real secrets manager
 * without env.ts (or any of its 8 real callers - emailClient.ts, jiraClient.ts, pipeline.ts,
 * agileClient.ts, vcsClient/githubClient.ts, vcsClient/index.ts, qaseClient.ts, and env.ts itself)
 * ever hardcoding one vendor's SDK - the same "no hardcoded provider logic" rule this project
 * already applies to TMS/VCS (see schemas.ts's TmsIntegrationSchema.provider and
 * ScrumVcsConfigSchema.provider, both open strings the code never gatekeeps).
 *
 * Which provider a tenant uses is config/tenants/<id>.json's integrations.secrets.provider (see
 * schemas.ts's SecretsIntegrationSchema, capabilityStore.ts's resolveSecretsProvider()) - an open
 * string, validated against the real registry at the point of use (selectSecretsProvider() below),
 * not gatekept in the schema. Defaults to 'env-file' - today's exact single-flat-.env behavior -
 * for every tenant that hasn't opted in, so no existing tenant's credential resolution changes and
 * no migration is forced.
 *
 * A real secrets-manager call is inherently async (network I/O) - resolveTenantEnv()/
 * requireTenantEnv() (env.ts) were a plain synchronous process.env read before this change, so
 * this is a genuine signature change that ripples through all 8 real callers, not a drop-in swap.
 * See env.ts's doc comments on both functions for the full picture.
 */
export interface SecretsProvider {
  /**
   * Resolves one secret for one tenant. Returns undefined (never throws) when the secret simply
   * isn't configured for this tenant on this provider - "not found" is a normal, expected outcome
   * every caller already handles (env.ts's resolveTenantEnv()/requireTenantEnv() decide what
   * "missing" means: silently fall through, or throw a loud, actionable error). A provider should
   * only throw for a genuine operational failure (network error, auth failure, malformed
   * response) - never to signal "the key doesn't exist here."
   */
  getSecret(tenantId: string, key: string): Promise<string | undefined>;
}

/**
 * Env var name for a tenant-specific override of <key> - tenant id uppercased, hyphens replaced
 * with underscores (env var names can't portably contain hyphens; see tenantContext.ts's
 * TENANT_ID_PATTERN for why a hyphen is the only special character a tenant id ever has). E.g.
 * tenant "acme-corp" -> JIRA_API_TOKEN__ACME_CORP.
 *
 * Exported (not just an EnvFileSecretsProvider-private helper) so env.ts's requireTenantEnv() can
 * reuse the exact same computation when building its "missing secret" error message for the
 * env-file provider, rather than a second, driftable copy of the same string-building logic.
 */
export function envFileTenantKey(key: string, tenantId: string): string {
  return `${key}__${tenantId.toUpperCase().replace(/-/g, '_')}`;
}

/**
 * Wraps today's exact single-flat-.env behavior - the default for every tenant that hasn't opted
 * into a real secrets manager, so no existing tenant's credential resolution changes and no
 * migration is forced (migrating the two live tenants' existing credentials off .env and into Key
 * Vault is explicitly a follow-up PR, not bundled into this one).
 *
 * Precedence, identical to the pre-this-change resolveTenantEnv(): the tenant-specific override
 * env var (envFileTenantKey() above), then the bare <key>. Reads process.env directly for both,
 * rather than importing env.ts's parsed/defaulted `env` export, specifically to avoid a circular
 * import (env.ts is what constructs this class and passes its own parsed env object in via
 * `baseEnv` - see the constructor). This is behavior-identical for every key this pipeline
 * actually resolves per-tenant today: every EnvSchema field ever passed through
 * resolveTenantEnv()/requireTenantEnv() (JIRA_*, SMTP_*, GITHUB_*, QASE_*, SLACK_*,
 * PIPELINE_OPERATOR) is `.optional()` with no schema default, so reading `baseEnv[key]` directly
 * here returns exactly what `env[key]` would have. A future EnvSchema field that both has a
 * `.default(...)` AND is resolved per-tenant would bypass that default through this path - not a
 * concern for any key in use today, but worth knowing if that combination is ever introduced.
 */
export class EnvFileSecretsProvider implements SecretsProvider {
  constructor(private readonly baseEnv: Record<string, string | undefined>) {}

  async getSecret(tenantId: string, key: string): Promise<string | undefined> {
    const overrideValue = process.env[envFileTenantKey(key, tenantId)];
    if (overrideValue !== undefined && overrideValue !== '') {
      return overrideValue;
    }
    const bareValue = this.baseEnv[key];
    if (bareValue !== undefined && bareValue !== '') {
      return bareValue;
    }
    return undefined;
  }
}

/**
 * First real cloud secrets-manager implementation - Azure Key Vault, since this org already has a
 * live Azure subscription (from the ACS Email work), so this needs no new vendor relationship.
 *
 * Auth: DefaultAzureCredential (@azure/identity), not a stored client secret - storing a new
 * long-lived secret to fix a secrets-sprawl problem would be self-defeating. In GitHub Actions,
 * the workflow authenticates via azure/login@v2 with a federated identity (OIDC - see this
 * project's docs/onboarding/internal-runbook.md for the exact setup steps), which performs `az
 * login` against GitHub's own OIDC token with no client secret involved; DefaultAzureCredential's
 * own credential chain falls through to AzureCliCredential and picks that session straight up, no
 * extra wiring needed here. The same DefaultAzureCredential chain also lets a developer hit a real
 * Key Vault locally (via their own `az login`) or run this from Azure infra with a managed
 * identity later, without this class needing to know which of those it's running under.
 *
 * Secret naming mirrors the env-file provider's <KEY>__<TENANT> shape, adapted to Key Vault's
 * naming rules (secret names may only contain letters, digits and dashes - no underscores): every
 * underscore in the credential key becomes a dash, and the tenant id is appended after a double
 * dash (mirroring the double-underscore separator) - see toSecretName() below. E.g.
 * JIRA_API_TOKEN for tenant "acme-corp" -> Key Vault secret "JIRA-API-TOKEN--acme-corp".
 *
 * Deliberately NO fallback to a shared/bare secret name (contrast EnvFileSecretsProvider's bare
 * <key> fallback) - every secret here is tenant-scoped by construction, which is this whole
 * class's reason for existing. A tenant on Key Vault with an unprovisioned secret sees a clear
 * "missing secret" error from requireTenantEnv() (see env.ts), never a silent read of some other
 * tenant's or the pipeline's shared value - that silent-fallback behavior is exactly the
 * single-point-of-compromise problem this provider exists to fix.
 */
export class AzureKeyVaultSecretsProvider implements SecretsProvider {
  private client: MinimalSecretClient | undefined;

  constructor(private readonly vaultUrl: string) {}

  /**
   * Lazy in two ways now: no network/credential work happens until the first real getSecret()
   * call (as before), AND the Azure SDK modules themselves aren't even require()'d into the
   * process until that same first call - see this file's top-of-file comment on why that second
   * part matters for every tenant that never uses this provider at all.
   */
  private async getClient(): Promise<MinimalSecretClient> {
    if (this.client) {
      return this.client;
    }
    // Bare require(), not createRequire()/import.meta - this file compiles to CommonJS output
    // under this project's "module": "NodeNext" setting (import.meta is a hard tsc error here
    // otherwise), so a plain ambient require() is already available and is exactly what makes
    // this lazy in the first place: Node's own require() only resolves/executes a module the
    // first time it's called, so @azure/identity and @azure/keyvault-secrets still aren't
    // loaded until this method actually runs.
    const { DefaultAzureCredential } = require('@azure/identity');
    const { SecretClient } = require('@azure/keyvault-secrets');
    // Assigned to a local first (rather than reading this.client back) so TS can narrow the
    // return type without a non-null assertion - narrowing a `this.<prop>` access across an
    // intervening constructor call is unreliable, but a local const needs no such narrowing.
    const client = new SecretClient(this.vaultUrl, new DefaultAzureCredential());
    this.client = client;
    return client;
  }

  static toSecretName(key: string, tenantId: string): string {
    return `${key.replace(/_/g, '-')}--${tenantId}`;
  }

  async getSecret(tenantId: string, key: string): Promise<string | undefined> {
    const client = await this.getClient();
    const secretName = AzureKeyVaultSecretsProvider.toSecretName(key, tenantId);
    try {
      const secret = await client.getSecret(secretName);
      return secret.value && secret.value !== '' ? secret.value : undefined;
    } catch (err) {
      if (isSecretNotFoundError(err)) {
        return undefined;
      }
      // A genuine operational failure (auth, network, throttling, ...) - let it throw rather than
      // silently reporting "not configured", per this interface's own contract (see
      // SecretsProvider.getSecret's doc comment).
      throw err;
    }
  }
}

/**
 * The Azure SDK throws a RestError with statusCode 404 (and, on most recent SDK versions,
 * `code: 'SecretNotFound'`) when a secret genuinely doesn't exist in the vault - distinguished
 * here from every other failure mode (403 unauthorized, network error, throttling, ...), which
 * should propagate as a loud thrown error instead of being reported as "not configured".
 */
function isSecretNotFoundError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const maybe = err as { statusCode?: number; code?: string };
  return maybe.statusCode === 404 || maybe.code === 'SecretNotFound';
}

/**
 * Resolves the SecretsProvider instance to use for a given provider name (config/tenants/<id>.json's
 * integrations.secrets.provider, via capabilityStore.ts's resolveSecretsProvider()). An open
 * string, not gatekept in the schema (see this module's own doc comment) - validated against the
 * real registry here, at the point of use, same "unknown provider" throw pattern as
 * getTestManagementClient()/getVcsClient() use for TMS/VCS provider selection.
 *
 * Takes already-constructed provider instances/factories (rather than constructing them itself)
 * so this function has no dependency on env.ts, capabilityStore.ts, or the Azure SDK's actual
 * credential/network setup - env.ts owns wiring the real instances together (it already holds the
 * parsed `env` object EnvFileSecretsProvider needs, and lazily builds the Key Vault client only if
 * a tenant actually selects it).
 */
export function selectSecretsProvider(
  providerName: string,
  providers: { envFile: SecretsProvider; azureKeyVault: () => SecretsProvider },
): SecretsProvider {
  switch (providerName) {
    case 'env-file':
      return providers.envFile;
    case 'azure-key-vault':
      return providers.azureKeyVault();
    default:
      throw new Error(
        `Unknown secrets provider "${providerName}" (config/tenants/<id>.json's ` +
          'integrations.secrets.provider) - only "env-file" and "azure-key-vault" are supported ' +
          'today. No other secrets-manager adapter has been built yet.',
      );
  }
}
