import 'dotenv/config';
import { getJiraClient } from '../src/pipeline/jira/jiraClient';

// One-off debug helper, mirrors `npm run pipeline -- --stage jira --issue <KEY>` but that stage
// only returns { key, summary, description } (via JiraClient.extractDescription) - this prints
// issuetype/status too, which the client already fetches (`fields: 'summary,description,issuetype,status'`
// in JiraClient.getIssue) but the pipeline stage doesn't surface.
//
// Usage: npx tsx scripts/fetchIssueMeta.ts KAN-9

async function main() {
  const issueKey = process.argv[2];
  if (!issueKey) {
    console.error('Usage: npx tsx scripts/fetchIssueMeta.ts <ISSUE-KEY>');
    process.exit(1);
  }

  const jira = await getJiraClient();
  const issue = await jira.getIssue(issueKey);
  console.log(
    JSON.stringify(
      {
        key: issue.key,
        summary: issue.fields.summary,
        issuetype: (issue.fields as any).issuetype?.name,
        status: (issue.fields as any).status?.name,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
