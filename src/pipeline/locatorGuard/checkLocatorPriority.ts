import fs from 'node:fs';
import path from 'node:path';
import { detectLocatorViolations, LocatorViolation } from './detectLocatorViolations';
import { findSuppressionAbove, findSuppressionComments } from '../shared/suppressionComment';

export const RULE_TAG = 'locator-priority';

export interface ViolationWithSuppression {
  violation: LocatorViolation;
  suppressed: boolean;
  suppressionReason: string | null;
}

export interface FileViolationResult {
  path: string;
  violations: ViolationWithSuppression[];
}

export interface LocatorCheckResult {
  files: FileViolationResult[];
  unsuppressedCount: number;
}

/** Pure: no filesystem access, so this is directly unit-testable against synthetic content. */
export function runLocatorPriorityCheck(
  files: { path: string; content: string }[],
): LocatorCheckResult {
  const fileResults: FileViolationResult[] = files.map(({ path: filePath, content }) => {
    const violations = detectLocatorViolations(content, filePath);
    const suppressions = findSuppressionComments(content, RULE_TAG);
    const results: ViolationWithSuppression[] = violations.map((violation) => {
      const match = findSuppressionAbove(suppressions, violation.line);
      return { violation, suppressed: match !== undefined, suppressionReason: match?.reason ?? null };
    });
    return { path: filePath, violations: results };
  });

  const unsuppressedCount = fileResults.reduce(
    (sum, f) => sum + f.violations.filter((v) => !v.suppressed).length,
    0,
  );

  return { files: fileResults, unsuppressedCount };
}

export function buildReport(result: LocatorCheckResult): string {
  const lines: string[] = ['# Locator Priority Check', ''];
  const filesWithViolations = result.files.filter((f) => f.violations.length > 0);

  if (filesWithViolations.length === 0) {
    lines.push('No CSS/XPath-style locator calls found in the scanned files.');
    return lines.join('\n');
  }

  for (const file of filesWithViolations) {
    lines.push(`## ${file.path}`, '');
    for (const { violation, suppressed, suppressionReason } of file.violations) {
      const status = suppressed ? `SUPPRESSED (${suppressionReason})` : 'UNREVIEWED';
      lines.push(`- [${status}] line ${violation.line}: \`.${violation.method}(...)\` — ${violation.text}`);
    }
    lines.push('');
  }

  lines.push(
    result.unsuppressedCount === 0
      ? 'Every violation above is suppressed with a justification comment - nothing blocking.'
      : `${result.unsuppressedCount} unreviewed violation(s) above. CLAUDE.md's locator priority is ` +
          'getByRole > getByLabel > getByTestId > getByText; CSS/XPath (.locator(), page.$*) needs ' +
          `an inline "// ${RULE_TAG}: approved — <reason>" comment to sign off, or should be replaced.`,
  );

  return lines.join('\n');
}

/** Recursively finds files under `dir` whose path ends with `suffix`. */
function findFiles(dir: string, suffix: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const relativePaths = fs.readdirSync(dir, { recursive: true }) as string[];
  return relativePaths
    .map((p) => path.join(dir, p))
    .filter((p) => p.endsWith(suffix) && fs.statSync(p).isFile());
}

/**
 * Roots to scan for locator-priority violations. Centralized here - rather than inlined in
 * checkLocatorPriority() - so there's exactly one place to extend as the codebase grows (e.g. a
 * future src/api/clients that starts building its own Playwright locators). Exported so tests
 * exercise this same list instead of keeping a second hardcoded copy that could silently drift out
 * of sync with it (see checkLocatorPriority.test.ts).
 *
 * `src/ui/pages` is the Page Object contract's home for locators; `tests` (recursive - covers
 * tests/ui, tests/api, and anything added later) is scanned too since at least one spec builds a
 * locator directly, bypassing a page object.
 */
export const LOCATOR_SCAN_ROOTS: { dir: string; suffix: string }[] = [
  { dir: 'src/ui/pages', suffix: '.ts' },
  { dir: 'tests', suffix: '.spec.ts' },
];

/** CLI entry point: scans LOCATOR_SCAN_ROOTS and runs the pure check above. */
export function checkLocatorPriority(): { exitCode: number; report: string } {
  const targetFiles = LOCATOR_SCAN_ROOTS.flatMap(({ dir, suffix }) => findFiles(dir, suffix));

  const files = targetFiles.map((filePath) => ({
    path: filePath.split(path.sep).join('/'),
    content: fs.readFileSync(filePath, 'utf-8'),
  }));

  const result = runLocatorPriorityCheck(files);
  return { exitCode: result.unsuppressedCount > 0 ? 1 : 0, report: buildReport(result) };
}
