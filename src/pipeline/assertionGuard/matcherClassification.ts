export type MatcherStrength = 'strict' | 'weak';

/**
 * Matcher name -> strength, confirmed against the real distribution in tests/**\/*.spec.ts
 * (see README's Assertion Integrity Guardrail section for the survey). Data, not inline logic,
 * so this is easy to extend as new matchers show up in the suite.
 *
 * Some entries (toContainText, toHaveCount, toHaveAttribute) are classified by name alone, even
 * though the original proposal qualified them ("non-trivial string" / "exact" / "specific value").
 * None of those qualifiers were exercised by the real suite at the time this table was built, so
 * there was nothing to calibrate an argument-sensitive rule against - revisit if a trivial-argument
 * false positive shows up in practice.
 */
export const MATCHER_CLASSIFICATION: Record<string, MatcherStrength> = {
  // Strict: checks a specific/exact value - weakening away from these loses real signal.
  toHaveText: 'strict',
  toHaveValue: 'strict',
  toContainText: 'strict',
  toHaveCount: 'strict',
  toBeChecked: 'strict',
  toHaveURL: 'strict',
  toHaveAttribute: 'strict',
  toBe: 'strict',

  // Weak: checks existence/presence only, not a specific value.
  toBeVisible: 'weak',
  toBeAttached: 'weak',
  toBeInViewport: 'weak',
  toBeEnabled: 'weak',
  toBeGreaterThan: 'weak',
  toBeEmpty: 'weak',
};

/** null for a matcher not in the table - neither strict nor weak, not used in strict->weak detection. */
export function classifyMatcher(matcherName: string): MatcherStrength | null {
  return MATCHER_CLASSIFICATION[matcherName] ?? null;
}
