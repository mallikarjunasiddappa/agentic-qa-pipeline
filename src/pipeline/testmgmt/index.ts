import { env } from '../config/env';
import { resolveTmsProvider } from '../config/capabilityStore';
import { getQaseClient } from './qaseClient';
import { QaseAdapter } from './qaseAdapter';
import { getTestinyClient } from './testinyClient';
import { TestinyAdapter } from './testinyAdapter';
import { TestManagementClient } from './types';

export type { TestManagementClient, TmsCaseDetail, TmsCaseStep, TmsResultStatus, TmsRunRecord, TmsRunCase } from './types';

let client: TestManagementClient | null = null;

/**
 * Returns the configured test management provider's client. Provider is resolved via
 * resolveTmsProvider() - a tenant's config/tenants/<id>.json integrations.tms.provider takes
 * precedence, falling back to the global TMS_PROVIDER env var (default 'qase') for a tenant with
 * no capabilities.json yet, so nothing breaks with zero config changes. 'qase' and 'testiny' both
 * have real adapters - this abstraction (TestManagementClient) was built provider-agnostic from
 * the start specifically so a second adapter is a new case here, not a rewrite (Phase 0's
 * genericity proof: adding 'testiny' below, plus testinyClient.ts/testinyAdapter.ts, was the only
 * change needed outside this file's own switch - see TestinyAdapter's own doc comment).
 */
export async function getTestManagementClient(): Promise<TestManagementClient> {
  if (client) return client;

  const provider = resolveTmsProvider(env.TMS_PROVIDER);
  switch (provider) {
    case 'qase':
      client = new QaseAdapter(await getQaseClient());
      return client;
    case 'testiny':
      client = new TestinyAdapter(await getTestinyClient());
      return client;
    default:
      throw new Error(
        `Unknown TMS provider "${provider}". Only "qase" and "testiny" are supported today - no ` +
          'other test management adapter has been built yet.',
      );
  }
}
