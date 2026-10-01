import { createHash } from 'node:crypto';
import type { TmsCaseDetail } from '../testmgmt/types';

function normalizeField(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

/**
 * Content hash for a test management case. Fields are extracted by name (not by serializing the
 * raw provider API response) and joined in a fixed order, so incidental JSON field-order
 * differences from the API never affect the hash; each field is trimmed/lowercased, so
 * whitespace-only edits don't either. Any real change to title, description, preconditions, or a
 * step's action/expected pair does.
 */
export function hashCase(caseDetail: TmsCaseDetail): string {
  const parts = [
    normalizeField(caseDetail.title),
    normalizeField(caseDetail.description),
    normalizeField(caseDetail.preconditions),
    ...caseDetail.steps.map(
      (step) => `${normalizeField(step.action)}::${normalizeField(step.expectedResult)}`,
    ),
  ];
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}

/**
 * Content hash for a generated test file. Runs the source through Prettier first so
 * formatting-only diffs (quote style, line wrap, trailing commas) don't register as drift.
 *
 * Whole-file only - for a shared multi-test file, use hashScenarioTestBlock below instead so one
 * scenario's edit doesn't register as drift for its siblings in the same file. Still used as-is
 * for --stage traceability-update-baseline's testLastModified/legacy single-test-file paths.
 */
export async function hashTestFile(source: string, filePath: string): Promise<string> {
  // Prettier v3 is ESM-only; dynamic import works regardless of how this module itself compiles.
  const prettier = await import('prettier');
  const formatted = await prettier.format(source, { filepath: filePath });
  return createHash('sha256').update(formatted).digest('hex');
}

/**
 * Content hash for a single `test(...)` block (see src/pipeline/shared/testBlocks.ts), scoped to
 * just that scenario - editing a sibling test elsewhere in the same file does not change this
 * hash. `blockSource` is the exact source text of one TestBlock.source. Reformatted as a
 * standalone statement (`${blockSource};`) with an explicit `parser: 'typescript'` rather than
 * `filepath`, since a lone call expression has no file of its own to infer a parser from - same
 * "run it through Prettier first so formatting doesn't count as drift" reasoning as hashTestFile.
 */
export async function hashScenarioTestBlock(blockSource: string): Promise<string> {
  const prettier = await import('prettier');
  const formatted = await prettier.format(`${blockSource};\n`, { parser: 'typescript' });
  return createHash('sha256').update(formatted).digest('hex');
}
