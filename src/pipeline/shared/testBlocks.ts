import { Project, SyntaxKind } from 'ts-morph';
import { getTestTitle, isTestCallExpression } from './testCallExpression';

const SCENARIO_ID_RE = /^\s*\/\/\s*scenario-id:\s*(\S+)\s*$/;

export interface TestBlock {
  // From a `// scenario-id: <id>` comment on its own line directly above the test - same
  // "marker comment" convention as suppressionComment.ts. Undefined when the test has no such
  // marker, which is expected and fine for a file with only one test (see resolveTestBlock).
  scenarioId?: string;
  // The literal title passed as the first argument to test(...). Populated for a plain string
  // literal and for a backtick title with no ${...} in it (see shared/testCallExpression.ts);
  // a title built at runtime cannot be matched back to a manifest entry, so such a test is
  // skipped rather than recorded under a guessed title.
  testTitle: string;
  // Exact source text of the test(...) call expression, for hashing (see hashing.ts's
  // hashScenarioTestBlock) - scoped to just this test, so a sibling test elsewhere in the same
  // file changing does not affect it.
  source: string;
  startLine: number;
}

/**
 * Finds every `test(...)` call in a spec file's source, whether it holds one scenario (the
 * convention every file used before multi-test-per-file support existed) or several grouped under
 * one `test.describe`. Pure/in-memory (ts-morph with useInMemoryFileSystem) - no filesystem
 * access, so this is directly unit-testable and reusable by both the traceability hashing path
 * and the (Phase 2) coverage guardrail.
 */
export function findTestBlocks(sourceText: string, fileName = 'file.ts'): TestBlock[] {
  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile(fileName, sourceText, { overwrite: true });

  const blocks: TestBlock[] = [];
  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (!isTestCallExpression(call)) continue;

    const testTitle = getTestTitle(call);
    if (testTitle === null) continue;

    // The marker comment sits directly above the statement this call lives in (an
    // ExpressionStatement for a bare `test(...)` call), same "one line above the flagged code"
    // shape as suppressionComment.ts's findSuppressionAbove.
    const statement = call.getFirstAncestorByKind(SyntaxKind.ExpressionStatement) ?? call;
    const leadingComments = statement.getLeadingCommentRanges();
    const marker = leadingComments
      .map((c) => c.getText().match(SCENARIO_ID_RE))
      .find((m): m is RegExpMatchArray => m !== null);

    blocks.push({
      scenarioId: marker?.[1],
      testTitle,
      source: call.getText(),
      startLine: call.getStartLineNumber(),
    });
  }

  return blocks;
}

/**
 * Resolves exactly which block in `blocks` corresponds to `scenarioId` - deterministic-only,
 * never a guess:
 *  - Exactly one block in the file: unambiguous regardless of whether it carries a marker -
 *    covers every file generated before this feature existed, and any group with only one
 *    scenario today.
 *  - More than one block: a `// scenario-id: <id>` marker matching `scenarioId` is required.
 *    Returns undefined (not a best-effort guess) if none matches, or if more than one does
 *    (a marker collision, which should never legitimately happen but is checked for rather than
 *    silently picking the first).
 */
export function resolveTestBlock(blocks: TestBlock[], scenarioId: string): TestBlock | undefined {
  if (blocks.length === 1) return blocks[0];
  const matches = blocks.filter((b) => b.scenarioId === scenarioId);
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * The comment line to place directly above a `test(...)` call so resolveTestBlock can find it in
 * a file with more than one test. See test-generation.md for when this is required vs. optional.
 */
export function buildScenarioIdComment(scenarioId: string): string {
  return `// scenario-id: ${scenarioId}`;
}

/** How a test is identified within a file: its scenario-id marker when it has one, else its title. */
export function blockIdentity(block: TestBlock): string {
  return block.scenarioId ?? block.testTitle;
}

/**
 * Which of `after`'s test(...) blocks are new relative to `before`.
 *
 * Lives here rather than in any one guardrail because more than one of them needs the same answer,
 * and because it is the correct alternative to "which FILES are new". Under this project's
 * ticket-level shared-file default, most new scenarios land as one more test(...) appended into an
 * already-existing spec file, so an added-files-only check misses almost every scenario added after
 * a ticket's first one - while checking every block in a changed file would fail CI on historical
 * debt nobody touched. Diffing the blocks is the only option that catches the new work without
 * punishing the old.
 */
export function findNewTestBlocks(before: string, after: string, fileName: string): TestBlock[] {
  const beforeIds = new Set((before ? findTestBlocks(before, fileName) : []).map(blockIdentity));
  return findTestBlocks(after, fileName).filter((b) => !beforeIds.has(blockIdentity(b)));
}
