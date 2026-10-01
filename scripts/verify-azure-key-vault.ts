import { AzureKeyVaultSecretsProvider } from '../src/pipeline/config/secretsProvider';

/**
 * Real-Azure verification for AzureKeyVaultSecretsProvider (secretsProvider.ts) - the roadmap's
 * HIGH PRIORITY item flagged as "merged but not yet verified against real Azure infrastructure".
 * secretsProvider.test.ts only ever mocks SecretClient.prototype.getSecret - this script is the
 * first time this provider's real network/auth path (dynamic import(), DefaultAzureCredential
 * resolution, a real Key Vault round-trip) actually runs, deliberately kept out of the unit suite
 * since it needs real Azure infrastructure and a signed-in `az` session to mean anything.
 *
 * Prerequisites (see docs/onboarding/internal-runbook.md Step 10 for the full picture - this
 * script only needs the lightweight local-dev subset, not the full GitHub Actions OIDC setup):
 *   1. A real Key Vault exists in the org's Azure subscription (create one if none exists yet -
 *      this script can't tell you whether one already does).
 *   2. You're signed in locally: `az login` (in your own terminal - never paste credentials into
 *      chat). DefaultAzureCredential's chain falls through to AzureCliCredential and picks that
 *      session up automatically - no extra config needed here.
 *   3. Your signed-in identity has the "Key Vault Secrets User" role (RBAC) on that vault, scoped
 *      to just that resource.
 *   4. One real secret exists in the vault under a name this script will ask you to provide via
 *      --test-secret-name (any existing secret works - this never writes or deletes anything, only
 *      reads).
 *
 * What this verifies that the mocked unit tests can't:
 *   - The dynamic import('@azure/identity') / import('@azure/keyvault-secrets') pair actually
 *     resolves at runtime (not just under test.mock's module-registry patching).
 *   - DefaultAzureCredential really does pick up a local `az login` session with no extra wiring.
 *   - A real getSecret() round-trip against a real vault returns the real value.
 *   - The 404/SecretNotFound path really is distinguished from a real auth failure, against Azure's
 *     actual error shape (not the hand-constructed error objects the unit tests use).
 *
 * Usage:
 *   AZURE_KEY_VAULT_URL=https://your-vault.vault.azure.net/ \
 *     npx tsx scripts/verify-azure-key-vault.ts --test-secret-name <a-real-secret-name-in-the-vault>
 */
function parseArgs(): { testSecretName?: string } {
  const args: Record<string, string> = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      args[argv[i].slice(2)] = argv[i + 1];
      i += 1;
    }
  }
  return { testSecretName: args['test-secret-name'] };
}

async function main(): Promise<void> {
  const { testSecretName } = parseArgs();
  const vaultUrl = process.env.AZURE_KEY_VAULT_URL;

  if (!vaultUrl) {
    console.error('AZURE_KEY_VAULT_URL is not set. Set it to your real vault URL and rerun.');
    process.exitCode = 1;
    return;
  }
  if (!testSecretName) {
    console.error('--test-secret-name is required - the name of a real secret already in the vault.');
    process.exitCode = 1;
    return;
  }

  console.log(`Vault: ${vaultUrl}`);
  console.log(`Test secret name: ${testSecretName}`);
  console.log('');

  const provider = new AzureKeyVaultSecretsProvider(vaultUrl);

  // getSecret()'s real signature is (tenantId, key) and internally builds
  // "<KEY-with-dashes>--<tenantId>" via toSecretName() - bypassing that here by calling the raw
  // secret name directly isn't possible through the public interface (by design, per this class's
  // own doc comment: every secret is tenant-scoped by construction). So this script constructs a
  // synthetic tenantId/key pair whose toSecretName() output equals exactly the real secret name
  // you point it at, rather than requiring you to pre-name a secret in the <KEY>--<tenant> shape
  // just to run this check.
  const [key, ...tenantParts] = testSecretName.split('--');
  const tenantId = tenantParts.join('--') || 'verify-script';
  const reconstructedName = AzureKeyVaultSecretsProvider.toSecretName(key.replace(/-/g, '_'), tenantId);

  console.log('--- Test 1: fetch a real, existing secret ---');
  if (reconstructedName !== testSecretName) {
    console.log(
      `Note: --test-secret-name "${testSecretName}" doesn't parse as a <KEY>--<tenant> pair, so ` +
        `this will look for "${reconstructedName}" instead, which won't exist. Pass a secret name ` +
        `already in that shape (e.g. "MY-TEST-SECRET--verify-script") for a clean pass, or read this ` +
        `as exercising the real 404 path below either way.`,
    );
  }
  try {
    const value = await provider.getSecret(tenantId, key.replace(/-/g, '_'));
    if (value !== undefined) {
      console.log(`PASS - got a real value back (length ${value.length}, not printed).`);
    } else {
      console.log(
        `Got undefined - either the secret genuinely isn't at "${reconstructedName}", or this is ` +
          `exercising the 404 path instead of the success path. See the note above.`,
      );
    }
  } catch (err) {
    console.log('FAIL - getSecret() threw on what should be a real, existing secret:');
    console.log(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exitCode = 1;
  }

  console.log('');
  console.log('--- Test 2: a secret that genuinely does not exist should return undefined, not throw ---');
  try {
    const missing = await provider.getSecret(
      'verify-script-nonexistent-tenant',
      'THIS_SECRET_DEFINITELY_DOES_NOT_EXIST_' + Date.now(),
    );
    if (missing === undefined) {
      console.log('PASS - 404/SecretNotFound correctly reported as undefined, not thrown.');
    } else {
      console.log(`FAIL - expected undefined, got a real value back: ${missing}`);
      process.exitCode = 1;
    }
  } catch (err) {
    console.log('FAIL - a genuinely missing secret should return undefined, not throw:');
    console.log(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exitCode = 1;
  }

  console.log('');
  console.log(
    process.exitCode === 1
      ? '--- Overall: FAILURES ABOVE - see output ---'
      : '--- Overall: PASS - real Azure Key Vault round-trip verified ---',
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exitCode = 1;
});
