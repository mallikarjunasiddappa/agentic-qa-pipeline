import { CallExpression, Node } from 'ts-morph';

/**
 * The single answer to "is this ts-morph node a Playwright test declaration, and what is its
 * title" - shared by every module that parses a spec file.
 *
 * WHY THIS EXISTS. Two independent parsers used to answer this question and they disagreed:
 * shared/testBlocks.ts allowlisted five modifiers while assertionGuard/astDiff.ts recognised only
 * `skip` and `fixme`, and testBlocks.ts rejected backtick titles that astDiff.ts accepted. The
 * consequences were real and silent in both directions:
 *
 *  - A test marked `test.only(...)` - the most common temporary edit anyone makes while iterating
 *    on a test - returned NO block from astDiff.ts, so the assertion-integrity guardrail stopped
 *    seeing that test entirely. Any assertion weakened in the same pull request went unexamined,
 *    at exactly the moment the author was editing it.
 *  - A test titled with backticks returned no block from testBlocks.ts, so the required-tags and
 *    traceability-coverage guardrails silently skipped it while the assertion guardrail ran on it.
 *    Which guardrails applied to a test depended on its quote style.
 *
 * Neither of those produced an error, a warning, or a failing test. The only durable fix is one
 * definition, imported by everything - so a future change to what counts as a test can never again
 * apply to some guardrails and not others.
 */

/** Playwright modifiers that still declare a runnable test. */
export type TestModifier = 'only' | 'skip' | 'fixme' | 'slow' | 'fail';

/**
 * Deliberately an allowlist rather than "anything hanging off `test.`", so `test.describe(...)`
 * (a grouping construct), `test.beforeEach(...)` and `test.step(...)` (hooks and sub-steps) are
 * never mistaken for tests.
 */
export const TEST_CALL_MODIFIERS: ReadonlySet<TestModifier> = new Set<TestModifier>([
  'only',
  'skip',
  'fixme',
  'slow',
  'fail',
]);

function isTestModifier(name: string): name is TestModifier {
  return (TEST_CALL_MODIFIERS as ReadonlySet<string>).has(name);
}

/**
 * The modifier on a test declaration: `null` for a bare `test(...)`, the modifier name for
 * `test.skip(...)` and friends, and `undefined` when the node is not a test declaration at all.
 *
 * Three-way rather than two-way because callers need to tell "a plain test" from "not a test" -
 * conflating them is how `test.only` became invisible in the first place.
 *
 * Deliberately does not try to prove this is *the* Playwright `test` rather than some unrelated
 * same-named function - the same accepted false-positive-over-false-negative tradeoff
 * detectLocatorViolations.ts makes for `.locator()`.
 */
export function readTestModifier(node: Node): TestModifier | null | undefined {
  if (!Node.isCallExpression(node)) return undefined;

  const expression = node.getExpression();
  if (Node.isIdentifier(expression)) {
    return expression.getText() === 'test' ? null : undefined;
  }

  if (Node.isPropertyAccessExpression(expression)) {
    const object = expression.getExpression();
    if (!Node.isIdentifier(object) || object.getText() !== 'test') return undefined;
    const name = expression.getName();
    return isTestModifier(name) ? name : undefined;
  }

  return undefined;
}

/** True for `test(...)` and for any allowlisted `test.<modifier>(...)`. */
export function isTestCallExpression(node: Node): boolean {
  return readTestModifier(node) !== undefined;
}

/**
 * The literal title of a test declaration, or null when it is not a plain literal.
 *
 * Accepts a string literal and a no-substitution template literal (a backtick title with no
 * `${...}` in it) - the two forms that produce a stable, matchable title. A title built at runtime
 * cannot be matched back to a manifest entry or a test-management case, so it returns null rather
 * than a guess: a block recorded under a guessed title attaches every later verdict to the wrong
 * test.
 */
export function getTestTitle(call: CallExpression): string | null {
  const first = call.getArguments()[0];
  if (!first) return null;
  if (Node.isStringLiteral(first) || Node.isNoSubstitutionTemplateLiteral(first)) {
    return first.getLiteralText();
  }
  return null;
}
