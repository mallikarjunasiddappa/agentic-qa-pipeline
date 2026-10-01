export interface SuppressionComment {
  line: number;
  reason: string;
}

/**
 * Shared suppression-comment convention, used by both the assertion-integrity guardrail and the
 * locator-priority check: `// <ruleTag>: approved — <reason>` on its own line, immediately above
 * the flagged code. A reason is required - the bare tag alone doesn't match, so a suppression
 * can't be copy-pasted without a real justification landing in git blame.
 *
 * (`src/pipeline/assertionGuard/suppression.ts` has its own copy of this same pattern hardcoded to the
 * "assertion-integrity" tag, predating this shared version - left as-is rather than refactored,
 * since it's already shipped and tested and the duplication is small.)
 */
export function findSuppressionComments(sourceText: string, ruleTag: string): SuppressionComment[] {
  const escapedTag = ruleTag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^\\s*\\/\\/\\s*${escapedTag}:\\s*approved\\s*(?:—|-{1,2})\\s*(\\S.*)$`);

  return sourceText
    .split('\n')
    .map((line, index): SuppressionComment | null => {
      const match = line.match(re);
      return match ? { line: index + 1, reason: match[1].trim() } : null;
    })
    .filter((c): c is SuppressionComment => c !== null);
}

/** The suppression (if any) sitting exactly one line above `targetLine`. */
export function findSuppressionAbove(
  suppressions: SuppressionComment[],
  targetLine: number,
): SuppressionComment | undefined {
  return suppressions.find((s) => s.line === targetLine - 1);
}
