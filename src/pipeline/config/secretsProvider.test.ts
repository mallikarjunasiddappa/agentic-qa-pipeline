import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  envFileTenantKey,
  EnvFileSecretsProvider,
  AzureKeyVaultSecretsProvider,
  selectSecretsProvider,
  SecretsProvider,
} from './secretsProvider';

test('envFileTenantKey uppercases the tenant id and replaces hyphens with underscores', () => {
  assert.equal(envFileTenantKey('JIRA_API_TOKEN', 'acme'), 'JIRA_API_TOKEN__ACME');
  assert.equal(envFileTenantKey('JIRA_API_TOKEN', 'acme-corp'), 'JIRA_API_TOKEN__ACME_CORP');
});

test('EnvFileSecretsProvider prefers the tenant-specific override env var over the bare key', async () => {
  const provider = new EnvFileSecretsProvider({ JIRA_API_TOKEN: 'shared-token' });
  process.env.JIRA_API_TOKEN__ACME = 'acme-specific-token';
  try {
    assert.equal(await provider.getSecret('acme', 'JIRA_API_TOKEN'), 'acme-specific-token');
  } finally {
    delete process.env.JIRA_API_TOKEN__ACME;
  }
});

test('EnvFileSecretsProvider falls back to the bare key when no tenant override is set', async () => {
  const provider = new EnvFileSecretsProvider({ JIRA_API_TOKEN: 'shared-token' });
  assert.equal(await provider.getSecret('acme', 'JIRA_API_TOKEN'), 'shared-token');
});

test('EnvFileSecretsProvider returns undefined when neither the override nor the bare key is set', async () => {
  const provider = new EnvFileSecretsProvider({});
  assert.equal(await provider.getSecret('acme', 'JIRA_API_TOKEN'), undefined);
});

test('EnvFileSecretsProvider treats an empty-string value the same as unset, on both the override and the bare key', async () => {
  const provider = new EnvFileSecretsProvider({ JIRA_API_TOKEN: '' });
  process.env.JIRA_API_TOKEN__ACME = '';
  try {
    assert.equal(await provider.getSecret('acme', 'JIRA_API_TOKEN'), undefined);
  } finally {
    delete process.env.JIRA_API_TOKEN__ACME;
  }
});

test('AzureKeyVaultSecretsProvider.toSecretName mirrors the <KEY>__<TENANT> shape with Key Vault-safe characters', () => {
  assert.equal(AzureKeyVaultSecretsProvider.toSecretName('JIRA_API_TOKEN', 'acme-corp'), 'JIRA-API-TOKEN--acme-corp');
});

// AzureKeyVaultSecretsProvider.getClient() (secretsProvider.ts) lazily require()s
// '@azure/keyvault-secrets' at call time, deliberately - not a static top-level import, and not
// a dynamic import() either - so tenants who never use this provider never pay the Azure SDK's
// cold-load cost, and so the require() call actually resolves the CommonJS build this project
// targets rather than hitting the ESM/CommonJS dual-package hazard a dynamic import() ran into
// here (see that file's own header comment and getClient()'s comment for both stories). Mocking
// a SecretClient obtained any other way (a static import, or a dynamic import()) was observed to
// patch a different module-registry entry than the one production code actually resolves at
// runtime, so the mock silently missed and these tests hit a real (failing) network call instead
// of the mock. require()-ing it here the same way the provider does guarantees both resolve to
// the identical cached module instance.
function mockSecretClientGetSecret(impl: (...args: unknown[]) => unknown) {
  const { SecretClient } = require('@azure/keyvault-secrets');
  return mock.method(SecretClient.prototype, 'getSecret', impl);
}

test('AzureKeyVaultSecretsProvider.getSecret returns the secret value on success', async () => {
  const m = mockSecretClientGetSecret(async () => ({ value: 'real-secret-value' }));
  try {
    const provider = new AzureKeyVaultSecretsProvider('https://fake-vault.vault.azure.net');
    assert.equal(await provider.getSecret('acme', 'JIRA_API_TOKEN'), 'real-secret-value');
  } finally {
    m.mock.restore();
  }
});

test('AzureKeyVaultSecretsProvider.getSecret returns undefined (not configured) on a 404/SecretNotFound error - no fallback to a shared secret', async () => {
  const m = mockSecretClientGetSecret(async () => {
    const err = new Error('not found') as Error & { statusCode: number; code: string };
    err.statusCode = 404;
    err.code = 'SecretNotFound';
    throw err;
  });
  try {
    const provider = new AzureKeyVaultSecretsProvider('https://fake-vault.vault.azure.net');
    assert.equal(await provider.getSecret('acme', 'JIRA_API_TOKEN'), undefined);
  } finally {
    m.mock.restore();
  }
});

test('AzureKeyVaultSecretsProvider.getSecret rethrows a genuine operational failure (e.g. 403 unauthorized) rather than reporting "not configured"', async () => {
  const m = mockSecretClientGetSecret(async () => {
    const err = new Error('access denied') as Error & { statusCode: number };
    err.statusCode = 403;
    throw err;
  });
  try {
    const provider = new AzureKeyVaultSecretsProvider('https://fake-vault.vault.azure.net');
    await assert.rejects(() => provider.getSecret('acme', 'JIRA_API_TOKEN'), /access denied/);
  } finally {
    m.mock.restore();
  }
});

test('selectSecretsProvider("env-file", ...) returns the given envFile instance', () => {
  const envFile: SecretsProvider = { getSecret: async () => 'x' };
  const azureKeyVault = mock.fn(() => {
    throw new Error('should not be called for env-file');
  });
  assert.equal(selectSecretsProvider('env-file', { envFile, azureKeyVault }), envFile);
  assert.equal(azureKeyVault.mock.calls.length, 0);
});

test('selectSecretsProvider("azure-key-vault", ...) calls the azureKeyVault factory and returns its result', () => {
  const envFile: SecretsProvider = { getSecret: async () => 'x' };
  const azureKeyVaultInstance: SecretsProvider = { getSecret: async () => 'y' };
  const azureKeyVault = mock.fn(() => azureKeyVaultInstance);
  assert.equal(selectSecretsProvider('azure-key-vault', { envFile, azureKeyVault }), azureKeyVaultInstance);
  assert.equal(azureKeyVault.mock.calls.length, 1);
});

test('selectSecretsProvider throws an actionable error for an unknown provider name', () => {
  const envFile: SecretsProvider = { getSecret: async () => 'x' };
  const azureKeyVault = () => {
    throw new Error('should not be called');
  };
  assert.throws(
    () => selectSecretsProvider('some-other-vendor', { envFile, azureKeyVault }),
    /Unknown secrets provider "some-other-vendor".*only "env-file" and "azure-key-vault"/s,
  );
});
