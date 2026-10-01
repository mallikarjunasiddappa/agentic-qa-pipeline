import ExcelJS from 'exceljs';
import path from 'node:path';
import fs from 'node:fs';
import { Scenario } from '../types/schemas';
import { env } from '../config/env';

const COLUMNS = [
  { header: 'ID', key: 'id', width: 12 },
  { header: 'Case ID', key: 'displayId', width: 12 },
  { header: 'Title', key: 'title', width: 40 },
  { header: 'Suite', key: 'suite', width: 22 },
  { header: 'Preconditions', key: 'preconditions', width: 30 },
  { header: 'Steps', key: 'steps', width: 60 },
  { header: 'Expected Result', key: 'expectedResult', width: 40 },
  { header: 'Priority', key: 'priority', width: 12 },
];

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Builds a meaningful, per-ticket output filename - "<jiraKey>-<feature-slug>-scenarios.xlsx" -
 * instead of the generic "scenarios.xlsx" every ticket used to share. That shared name meant every
 * new --stage excel-write silently overwrote whatever the previous ticket's sign-off sheet was,
 * unless someone manually backed it up first - see scenarios_prompts/track-a-kan-2-execution-prompt.md's
 * "isolation strategy" for the manual workaround this used to require. `specFilePath` is expected
 * to be a `specs/<feature>.plan.md` path; the feature slug comes from its basename with a trailing
 * `.plan.md` stripped, so `specs/profile-subscriptions.plan.md` contributes "profile-subscriptions".
 */
export function buildScenarioFileName(jiraKey: string, specFilePath: string): string {
  const featureSlug = slugify(path.basename(specFilePath).replace(/\.plan\.md$/i, ''));
  const keySlug = slugify(jiraKey);
  return `${keySlug}${featureSlug ? `-${featureSlug}` : ''}-scenarios.xlsx`;
}

/**
 * Assigns a short, human-facing display id ("KAN3-01", "KAN3-02", ...) to each scenario, in the
 * order given - sequential per Jira ticket, zero-padded to 2 digits. Purely for the Excel
 * sign-off sheet's "Case ID" column during Gate 1/2 human review; `scenario.id` (the kebab-case
 * slug) is untouched and keeps driving file naming/traceability exactly as before. Re-running
 * this over the same spec reassigns the same sequence (order comes from parseScenariosFromSpec's
 * document order, which is stable), so display ids don't drift across regenerations unless the
 * spec's scenario order itself changes.
 */
export function assignDisplayIds(jiraKey: string, scenarios: Scenario[]): Scenario[] {
  const prefix = jiraKey.replace(/-/g, '').toUpperCase();
  return scenarios.map((scenario, index) => ({
    ...scenario,
    displayId: `${prefix}-${String(index + 1).padStart(2, '0')}`,
  }));
}

export async function writeScenarios(scenarios: Scenario[], filePath?: string): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Scenarios');
  sheet.columns = COLUMNS;

  for (const scenario of scenarios) {
    sheet.addRow({
      id: scenario.id,
      displayId: scenario.displayId ?? '',
      title: scenario.title,
      suite: scenario.suite ?? '',
      preconditions: scenario.preconditions,
      steps: scenario.steps.map((s, i) => `${i + 1}. ${s}`).join('\n'),
      expectedResult: scenario.expectedResult,
      priority: scenario.priority,
    });
  }

  sheet.getRow(1).font = { bold: true };
  sheet.getColumn('steps').alignment = { wrapText: true, vertical: 'top' };
  sheet.getColumn('preconditions').alignment = { wrapText: true, vertical: 'top' };

  const outPath = filePath ?? path.join(env.OUTPUT_DIR, 'scenarios.xlsx');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  await workbook.xlsx.writeFile(outPath);
  return outPath;
}
