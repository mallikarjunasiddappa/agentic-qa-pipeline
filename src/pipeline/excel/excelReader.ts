import ExcelJS from 'exceljs';
import { Scenario, ScenarioSchema, PrioritySchema } from '../types/schemas';

export interface ScenarioDiff {
  added: Scenario[];
  removed: Scenario[];
  changed: { id: string; before: Scenario; after: Scenario }[];
  unchanged: Scenario[];
}

export async function readScenarios(filePath: string): Promise<Scenario[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = workbook.getWorksheet('Scenarios');
  if (!sheet) {
    throw new Error(`Worksheet "Scenarios" not found in ${filePath}`);
  }

  const scenarios: Scenario[] = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const values = row.values as unknown[];
    const [, id, displayId, title, suite, preconditions, stepsCell, expectedResult, priority] = values;
    const steps = String(stepsCell ?? '')
      .split('\n')
      .map((line) => line.replace(/^\d+\.\s*/, '').trim())
      .filter((line) => line.length > 0);

    scenarios.push(
      ScenarioSchema.parse({
        id: String(id),
        displayId: displayId ? String(displayId) : undefined,
        title: String(title),
        suite: suite ? String(suite) : undefined,
        preconditions: String(preconditions ?? ''),
        steps,
        expectedResult: String(expectedResult ?? ''),
        priority: PrioritySchema.parse(String(priority)),
      }),
    );
  });
  return scenarios;
}

export function diffScenarios(original: Scenario[], edited: Scenario[]): ScenarioDiff {
  const originalById = new Map(original.map((s) => [s.id, s]));
  const editedById = new Map(edited.map((s) => [s.id, s]));

  const added = edited.filter((s) => !originalById.has(s.id));
  const removed = original.filter((s) => !editedById.has(s.id));
  const changed: ScenarioDiff['changed'] = [];
  const unchanged: Scenario[] = [];

  for (const [id, before] of originalById) {
    const after = editedById.get(id);
    if (!after) continue;
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      changed.push({ id, before, after });
    } else {
      unchanged.push(after);
    }
  }

  return { added, removed, changed, unchanged };
}
