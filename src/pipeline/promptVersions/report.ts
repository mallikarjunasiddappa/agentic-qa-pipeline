import fs from 'node:fs';
import path from 'node:path';
import { PromptVersionReport } from './buildChangelog';
import { tenantDataPath } from '../config/tenantContext';

export function REPORT_JSON_PATH(): string { return tenantDataPath('promptVersions', 'report.json'); }
export function REPORT_MD_PATH(): string { return tenantDataPath('promptVersions', 'report.md'); }

/**
 * No append-only log here, unlike healing/flaky telemetry - git already is the log, so this
 * regenerates fully from current history on every run rather than accumulating its own state.
 */
export function writePromptVersionReports(
  report: PromptVersionReport,
): { reportJsonPath: string; reportMdPath: string } {
  fs.mkdirSync(path.dirname(REPORT_JSON_PATH()), { recursive: true });
  fs.writeFileSync(REPORT_JSON_PATH(), `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
  fs.writeFileSync(REPORT_MD_PATH(), buildReportMarkdown(report), 'utf-8');
  return { reportJsonPath: REPORT_JSON_PATH(), reportMdPath: REPORT_MD_PATH() };
}

function buildReportMarkdown(report: PromptVersionReport): string {
  const lines: string[] = [];
  lines.push('# Prompt Version Report', '', `Generated: ${report.generatedAt}`, '');
  lines.push(
    'Scope: `.claude/agents/*.md` only (the six pipeline agents). Not ' +
      '`.claude/skills/playwright-cli/references/*.md`.',
    '',
    'This is a pure git-log-derived changelog, not its own record - for a full diff on any commit '
      + 'below, run `git show <sha> -- <path>` yourself.',
    '',
  );

  for (const agent of report.agents) {
    lines.push(`## ${agent.agentFile}`, '');
    if (agent.commits.length === 0) {
      lines.push('_No commit history found._', '');
      continue;
    }
    lines.push('| SHA | Date | Author | Message | +Ins | -Del |', '|---|---|---|---|---|---|');
    for (const commit of agent.commits) {
      lines.push(
        `| ${commit.shortSha} | ${commit.date} | ${commit.author} | ${commit.message} | +${commit.insertions} | -${commit.deletions} |`,
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}
