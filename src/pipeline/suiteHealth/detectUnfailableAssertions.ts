import { extractTestBlocks, type AssertionInfo, type TestBlock } from '../assertionGuard/astDiff';
import type { AssertionState } from './classify';

/**
 * Answers ONE question about a spec file, for signal 1 of the Suite Health report:
 *
 *   "Can this test, as it stands today, ever fail?"
 *
 * WHY THIS FILE EXISTS AT ALL. `assertionGuard/checkAssertionIntegrity` looks like it already does
 * this, and the Suite Health spec originally assumed it did. It does not. That guard is DIFF-based:
 * `runAssertionIntegrityCheck(files: FileContentPair[])` takes `{ path, oldContent, newContent }`
 * and reports assertions that were WEAKENED DURING A CHANGE. A test that was born unfailable three
 * years ago and has never been touched since produces no finding there, because there is no diff.
 * That test is exactly the one this report is looking for.
 *
 * What IS reused: `extractTestBlocks` (the ts-morph parse, the expect() chain walk, the
 * try/catch and .catch() swallow detection) and `classifyMatcher` via `AssertionInfo.strength`.
 * No parsing is reimplemented here. This module is the judgement layer on top of that parse.
 *
 * Pure: text in, verdicts out. No filesystem, no network, no clock.
 */

/** Machine-readable reason, so the report can group and the tests can assert on it. */
export type CannotFailCode =
  | 'no-assertions'
  | 'all-assertions-swallowed'
  | 'all-assertions-tautological'
  | 'no-effective-assertions';

export interface SpecFile {
  path: string;
  content: string;
}

export interface TestAssertionAnalysis {
  filePath: string;
  title: string;
  bodyStartLine: number;
  /** Declared as test.skip(...). Recorded, NOT folded into cannotFail - see the note below. */
  isSkipped: boolean;
  /** Declared as test.fixme(...). Same treatment as isSkipped. */
  isFixme: boolean;
  /** Feeds SuiteCaseRecord.assertion in classify.ts unchanged. */
  assertion: AssertionState;
  /**
   * Every effective assertion uses a presence-only matcher (toBeVisible, toBeAttached, ...).
   *
   * DELIBERATELY NOT cannotFail. A toBeVisible CAN fail - the element can be missing. Calling a
   * weak-only test "protecting nothing" would be a false accusation, and one false accusation in
   * the top twenty rows is how this whole report stops being read. It is surfaced as a separate,
   * softer finding: "this test only checks that things exist, not that they are correct."
   */
  weakOnly: boolean;
  /** The assertions that justify the verdict, quoted. A verdict without evidence is an opinion. */
  evidence: string[];
}

/**
 * The state for a test-management case with no linked spec at all.
 *
 * cannotFail is FALSE here, not true. There is no assertion to judge, so claiming it cannot fail
 * would route the case to PROTECTING_NOTHING ("fix the assertion") when the real finding is that
 * there is nothing to fix yet. classify.ts already handles no-automation through its
 * never-run/ORPHANED branch, which produces the correct action.
 */
export const NO_AUTOMATION_ASSERTION_STATE: AssertionState = {
  hasAutomation: false,
  cannotFail: false,
};

/** Subjects whose value is fixed the moment the file is saved. */
const LITERAL_SUBJECT = /^(true|false|null|undefined|-?\d+(\.\d+)?|(['"`]).*\3)$/;

/** Trailing `.matcher(args)` of a normalised assertion call. Greedy, so nested parens survive. */
const MATCHER_CALL = /\.\s*[A-Za-z0-9_$]+\s*\((.*)\)\s*;?$/;

function isLiteral(text: string): boolean {
  return LITERAL_SUBJECT.test(text.trim());
}

function isSwallowed(assertion: AssertionInfo): boolean {
  return assertion.wrappedInTryCatch || assertion.wrappedInCatchCall;
}

/**
 * True when BOTH sides of the comparison are literals, so the result is decided at authoring time:
 * expect(true).toBe(true), expect(1).toBeGreaterThan(0), expect(true).toBeTruthy().
 *
 * A literal subject alone is not enough - expect(true).toBe(someFlag) can genuinely fail. If the
 * argument cannot be parsed out of the call text, the answer is NO. Under-reporting here costs a
 * missed row; over-reporting costs the report's credibility.
 */
function isTautological(assertion: AssertionInfo): boolean {
  if (!isLiteral(assertion.subjectText)) return false;

  const match = MATCHER_CALL.exec(assertion.text);
  if (!match) return false;

  const args = match[1].trim();
  if (args === '') return true; // expect(true).toBeTruthy()
  return isLiteral(args);
}

function quote(assertions: AssertionInfo[]): string[] {
  return assertions.slice(0, 3).map((a) => `line ${a.line}: ${a.text}`);
}

/**
 * Judges one already-parsed test block. Exported so a caller that has blocks in hand (the
 * traceability walk does) need not re-parse the file.
 */
export function analyseTestBlock(block: TestBlock, filePath: string): TestAssertionAnalysis {
  const swallowed = block.assertions.filter(isSwallowed);
  const tautological = block.assertions.filter((a) => !isSwallowed(a) && isTautological(a));
  const effective = block.assertions.filter((a) => !isSwallowed(a) && !isTautological(a));

  let assertion: AssertionState;
  let evidence: string[];

  if (block.assertions.length === 0) {
    assertion = { hasAutomation: true, cannotFail: true, cannotFailReason: 'no-assertions' };
    evidence = ['The test body contains no expect() call.'];
  } else if (effective.length > 0) {
    assertion = { hasAutomation: true, cannotFail: false };
    evidence = [];
  } else if (tautological.length === 0) {
    assertion = {
      hasAutomation: true,
      cannotFail: true,
      cannotFailReason: 'all-assertions-swallowed',
    };
    evidence = quote(swallowed);
  } else if (swallowed.length === 0) {
    assertion = {
      hasAutomation: true,
      cannotFail: true,
      cannotFailReason: 'all-assertions-tautological',
    };
    evidence = quote(tautological);
  } else {
    assertion = {
      hasAutomation: true,
      cannotFail: true,
      cannotFailReason: 'no-effective-assertions',
    };
    evidence = quote([...swallowed, ...tautological]);
  }

  const weakOnly = effective.length > 0 && effective.every((a) => a.strength === 'weak');
  if (weakOnly) {
    evidence = quote(effective);
  }

  return {
    filePath,
    title: block.title,
    bodyStartLine: block.bodyStartLine,
    // Suppression is signal 5 and has its own owner. Recorded here so the collector does not have
    // to parse the file twice, but never folded into cannotFail: a skipped test's assertion is not
    // broken, it is simply not running, and the two need different actions.
    isSkipped: block.isSkipped,
    isFixme: block.fixme !== null,
    assertion,
    weakOnly,
    evidence,
  };
}

/** Parses one spec file and judges every test in it. */
export function analyseSpecFile(content: string, filePath: string): TestAssertionAnalysis[] {
  return extractTestBlocks(content, filePath).map((block) => analyseTestBlock(block, filePath));
}

/** Parses many. Order follows the input, so the report is reproducible run to run. */
export function analyseSpecFiles(files: SpecFile[]): TestAssertionAnalysis[] {
  return files.flatMap((file) => analyseSpecFile(file.content, file.path));
}

/** Key a test is addressed by everywhere else in the pipeline: (file path, test title). */
export function testKey(filePath: string, title: string): string {
  return `${filePath}::${title}`;
}

/**
 * Index for the collector's case -> test lookup.
 *
 * A duplicate (path, title) keeps the FIRST occurrence. Two tests with the same title in one file
 * are a real defect, but silently letting the second overwrite the first would make the report
 * depend on file order, which is worse than being slightly wrong about which one was judged.
 */
export function indexAnalyses(
  analyses: TestAssertionAnalysis[],
): Map<string, TestAssertionAnalysis> {
  const index = new Map<string, TestAssertionAnalysis>();
  for (const analysis of analyses) {
    const key = testKey(analysis.filePath, analysis.title);
    if (!index.has(key)) index.set(key, analysis);
  }
  return index;
}
