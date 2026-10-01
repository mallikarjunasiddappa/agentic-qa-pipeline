import { requireTenantEnv } from '../src/pipeline/config/env';
import axios from 'axios';

/**
 * Debug helper: dumps the RAW JSON body of every Testiny folder, exactly as the API returns it -
 * every key, not just the ones TestinyFolderListItem's TypeScript interface happens to declare.
 *
 * Round 1 of this diagnosis (printing only the typed parent_id field) showed parent_id: undefined
 * on every folder, including ones that should be real sub-folders - two possible explanations:
 * (a) parent_id is a plain field the way testcase_folder_id turned out NOT to be for case
 * membership (silently ignored at create time, needs a mapping call instead), or (b) the field is
 * simply named something else in the real response and TestinyFolderListItem's "parent_id" is a
 * guess that doesn't match, the same kind of hyphen/underscore mismatch already found twice in
 * this integration. Bypasses TestinyClient.listFolders()'s typed mapping entirely and calls the
 * API directly so nothing is silently dropped by the interface.
 *
 * Deliberately wrapped end-to-end in try/catch, printing only err.response?.data (never a raw
 * axios error object, which can carry the request's Authorization/X-Api-Key header in its config)
 * - see the KAN-10 incident where an unwrapped diagnostic script crashed and dumped a live Testiny
 * API key to stdout. Never remove this wrapping in a copy of this script.
 *
 * Usage: npx tsx scripts/listTestinyFolders.ts
 */
async function main(): Promise<void> {
  const apiKey = await requireTenantEnv('TESTINY_API_KEY', 'Testiny Agent');
  const projectIdRaw = await requireTenantEnv('TESTINY_PROJECT_ID', 'Testiny Agent');
  const projectId = Number(projectIdRaw);

  const http = axios.create({
    baseURL: 'https://app.testiny.io/api/v1',
    headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' },
  });

  const { data } = await http.post<{ data: Record<string, unknown>[] }>('/testcase-folder/find', {
    filter: { project_id: projectId },
    pagination: { limit: 500 },
  });

  console.log(`${data.data.length} folder(s) - full raw JSON:\n`);
  for (const f of data.data) {
    console.log(JSON.stringify(f, null, 2));
  }
}

main().catch((err) => {
  const withResponse = err as { response?: { status?: number; data?: unknown }; message?: string };
  if (withResponse?.response) {
    console.error(`HTTP ${withResponse.response.status}:`, JSON.stringify(withResponse.response.data));
  } else {
    console.error('Non-HTTP error:', withResponse?.message ?? '(no message)');
  }
  process.exitCode = 1;
});
