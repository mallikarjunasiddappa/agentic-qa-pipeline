import { CallExpression, Node, Project, SyntaxKind } from 'ts-morph';
import { MatcherStrength, classifyMatcher } from './matcherClassification';
import { getTestTitle, readTestModifier } from '../shared/testCallExpression';

export interface AssertionInfo {
  subjectText: string;
  matcher: string;
  negated: boolean;
  strength: MatcherStrength | null;
  line: number;
  text: string;
  wrappedInTryCatch: boolean;
  wrappedInCatchCall: boolean;
}

export interface TestBlock {
  title: string;
  bodyStartLine: number;
  bodyEndLine: number;
  // Declared via test.skip('title', ...). In-body conditional test.skip(cond, reason) calls are
  // out of scope - no real usage of that form exists in this suite to calibrate against.
  isSkipped: boolean;
  // Declared via test.fixme('title', ...); null if this test isn't a fixme.
  fixme: { line: number; hasComment: boolean } | null;
  assertions: AssertionInfo[];
}

export type FindingType =
  | 'assertion_removed'
  | 'strict_to_weak'
  | 'new_skip'
  | 'fixme_missing_comment'
  | 'assertion_swallowed';

export interface Finding {
  type: FindingType;
  testTitle: string;
  message: string;
  subjectText?: string;
  // Where a suppression comment must appear to clear this finding. Findings whose assertion still
  // exists in the new file (weakened, wrapped, fixme-without-comment) anchor to that exact line -
  // "line immediately preceding" per the spec. A fully deleted assertion has no surviving line, so
  // it falls back to test-scoped: the comment may appear anywhere in that test's body.
  anchor: { kind: 'line'; line: number } | { kind: 'test'; bodyStartLine: number; bodyEndLine: number };
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function getCallbackArg(call: CallExpression): Node | null {
  const args = call.getArguments();
  const last = args[args.length - 1];
  if (last && (Node.isArrowFunction(last) || Node.isFunctionExpression(last))) {
    return last;
  }
  return null;
}

/** True if a comment sits on the line directly above the statement, or trailing on its own line. */
function hasNearbyComment(call: CallExpression, targetLine: number): boolean {
  const stmt = call.getFirstAncestorByKind(SyntaxKind.ExpressionStatement) ?? call;
  const sourceFile = call.getSourceFile();

  const leading = stmt.getLeadingCommentRanges();
  const hasPreceding = leading.some((c) => {
    const endLine = sourceFile.getLineAndColumnAtPos(c.getEnd()).line;
    return endLine >= targetLine - 1 && endLine < targetLine;
  });
  if (hasPreceding) return true;

  const trailing = stmt.getTrailingCommentRanges();
  return trailing.some((c) => sourceFile.getLineAndColumnAtPos(c.getPos()).line === targetLine);
}

function isSwallowedByTryCatch(call: CallExpression): boolean {
  let node: Node | undefined = call.getParent();
  while (node) {
    if (Node.isBlock(node)) {
      const parent = node.getParent();
      if (Node.isTryStatement(parent) && parent.getTryBlock() === node) {
        const catchClause = parent.getCatchClause();
        if (catchClause) {
          const hasThrow = catchClause.getBlock().getDescendantsOfKind(SyntaxKind.ThrowStatement).length > 0;
          if (!hasThrow) return true;
        }
      }
    }
    if (Node.isArrowFunction(node) || Node.isFunctionExpression(node)) break;
    node = node.getParent();
  }
  return false;
}

function isSwallowedByCatchCall(call: CallExpression): boolean {
  const parent = call.getParent();
  if (!parent || !Node.isPropertyAccessExpression(parent)) return false;
  if (parent.getName() !== 'catch') return false;
  return Node.isCallExpression(parent.getParent());
}

function findExpectAssertions(root: Node): AssertionInfo[] {
  const results: AssertionInfo[] = [];

  for (const call of root.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = call.getExpression();
    if (!Node.isPropertyAccessExpression(expr)) continue;

    let current: Node = expr;
    const names: string[] = [];
    while (Node.isPropertyAccessExpression(current)) {
      names.unshift(current.getName());
      current = current.getExpression();
    }
    if (!Node.isCallExpression(current)) continue;
    const baseExpr = current.getExpression();
    if (!Node.isIdentifier(baseExpr) || baseExpr.getText() !== 'expect') continue;

    const matcher = names[names.length - 1];
    if (!matcher) continue;
    const negated = names.includes('not');

    const subjectNode = current.getArguments()[0];
    if (!subjectNode) continue;

    results.push({
      subjectText: normalize(subjectNode.getText()),
      matcher,
      negated,
      strength: classifyMatcher(matcher),
      line: call.getStartLineNumber(),
      text: normalize(call.getText()),
      wrappedInTryCatch: isSwallowedByTryCatch(call),
      wrappedInCatchCall: isSwallowedByCatchCall(call),
    });
  }

  return results;
}

/** Parses one file's source into its test blocks. Used for both the old (base) and new (working tree) content. */
export function extractTestBlocks(sourceText: string, fileName = 'file.spec.ts'): TestBlock[] {
  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile(fileName, sourceText, { overwrite: true });

  const blocks: TestBlock[] = [];
  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    // undefined means "not a test declaration"; null means a bare test(...) with no modifier.
    // This used to recognise only skip and fixme, which made every test.only/.slow/.fail block
    // invisible to this guardrail - see shared/testCallExpression.ts for why that mattered.
    const modifier = readTestModifier(call);
    if (modifier === undefined) continue;

    const title = getTestTitle(call);
    if (title === null) continue;

    const callback = getCallbackArg(call);
    if (!callback || (!Node.isArrowFunction(callback) && !Node.isFunctionExpression(callback))) continue;

    const body = callback.getBody();
    const fixmeLine = modifier === 'fixme' ? call.getStartLineNumber() : null;

    blocks.push({
      title,
      bodyStartLine: body.getStartLineNumber(),
      bodyEndLine: body.getEndLineNumber(),
      isSkipped: modifier === 'skip',
      fixme: fixmeLine !== null ? { line: fixmeLine, hasComment: hasNearbyComment(call, fixmeLine) } : null,
      assertions: findExpectAssertions(body),
    });
  }

  return blocks;
}

function groupBySubject(assertions: AssertionInfo[]): Map<string, AssertionInfo[]> {
  const map = new Map<string, AssertionInfo[]>();
  for (const a of assertions) {
    const list = map.get(a.subjectText) ?? [];
    list.push(a);
    map.set(a.subjectText, list);
  }
  return map;
}

/** Compares matched (same-title) test pairs between old and new blocks and produces findings. */
export function compareTestBlocks(oldBlocks: TestBlock[], newBlocks: TestBlock[]): Finding[] {
  const findings: Finding[] = [];
  const oldByTitle = new Map(oldBlocks.map((b) => [b.title, b]));

  for (const newBlock of newBlocks) {
    const oldBlock = oldByTitle.get(newBlock.title);
    if (!oldBlock) continue; // new/renamed test - out of scope

    const testAnchor = {
      kind: 'test' as const,
      bodyStartLine: newBlock.bodyStartLine,
      bodyEndLine: newBlock.bodyEndLine,
    };

    if (newBlock.assertions.length < oldBlock.assertions.length) {
      findings.push({
        type: 'assertion_removed',
        testTitle: newBlock.title,
        message: `Assertion count decreased from ${oldBlock.assertions.length} to ${newBlock.assertions.length}`,
        anchor: testAnchor,
      });
    }

    const oldBySubject = groupBySubject(oldBlock.assertions);
    const newBySubject = groupBySubject(newBlock.assertions);

    for (const [subject, oldAssertions] of oldBySubject) {
      if (!oldAssertions.some((a) => a.strength === 'strict')) continue;
      const newAssertions = newBySubject.get(subject) ?? [];
      if (newAssertions.some((a) => a.strength === 'strict')) continue;

      if (newAssertions.length === 0) {
        findings.push({
          type: 'assertion_removed',
          testTitle: newBlock.title,
          subjectText: subject,
          message: `Strict assertion on "${subject}" was removed`,
          anchor: testAnchor,
        });
      } else {
        findings.push({
          type: 'strict_to_weak',
          testTitle: newBlock.title,
          subjectText: subject,
          message: `"${subject}" moved from a strict matcher to "${newAssertions[0].matcher}" (weak)`,
          anchor: { kind: 'line', line: newAssertions[0].line },
        });
      }
    }

    for (const [subject, newAssertions] of newBySubject) {
      const oldAssertions = oldBySubject.get(subject) ?? [];
      for (const newA of newAssertions) {
        if (!newA.wrappedInTryCatch && !newA.wrappedInCatchCall) continue;
        const hadSameWrap = oldAssertions.some(
          (oldA) => oldA.matcher === newA.matcher && (oldA.wrappedInTryCatch || oldA.wrappedInCatchCall),
        );
        if (hadSameWrap) continue;
        findings.push({
          type: 'assertion_swallowed',
          testTitle: newBlock.title,
          subjectText: subject,
          message: `"${subject}" assertion is newly wrapped in ${
            newA.wrappedInTryCatch ? 'try/catch' : '.catch()'
          }, which would swallow a failure`,
          anchor: { kind: 'line', line: newA.line },
        });
      }
    }

    if (newBlock.isSkipped && !oldBlock.isSkipped) {
      findings.push({
        type: 'new_skip',
        testTitle: newBlock.title,
        message: 'Test is newly marked test.skip',
        anchor: testAnchor,
      });
    }

    if (newBlock.fixme && !newBlock.fixme.hasComment && !oldBlock.fixme) {
      findings.push({
        type: 'fixme_missing_comment',
        testTitle: newBlock.title,
        message: 'test.fixme has no comment explaining it',
        anchor: { kind: 'line', line: newBlock.fixme.line },
      });
    }
  }

  return findings;
}
