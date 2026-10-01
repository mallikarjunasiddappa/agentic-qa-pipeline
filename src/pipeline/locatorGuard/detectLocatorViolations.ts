import { Node, Project, SyntaxKind } from 'ts-morph';

export type ForbiddenMethod = 'locator' | '$' | '$$' | '$eval' | '$$eval';

const FORBIDDEN_METHODS = new Set<string>(['locator', '$', '$$', '$eval', '$$eval']);

export interface LocatorViolation {
  line: number;
  method: ForbiddenMethod;
  text: string;
}

/**
 * Flags every `.locator(...)` call and every `page.$`/`$$`/`$eval`/`$$eval` call, unconditionally
 * - matched by method name alone, regardless of the receiver expression. Deliberately not trying
 * to detect "does this string look like CSS": that produces false negatives on selectors that
 * don't look CSS-like but are. Flagging the method itself has none. This also means it can't tell
 * apart a real Playwright `.locator()` call from some unrelated object's same-named method - that
 * false-positive risk is the accepted tradeoff for zero false negatives (same philosophy the
 * assertion-integrity guardrail uses for matching `expect(...)`).
 */
export function detectLocatorViolations(sourceText: string, fileName = 'file.ts'): LocatorViolation[] {
  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile(fileName, sourceText, { overwrite: true });

  const violations: LocatorViolation[] = [];
  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = call.getExpression();
    if (!Node.isPropertyAccessExpression(expr)) continue;

    const method = expr.getName();
    if (!FORBIDDEN_METHODS.has(method)) continue;

    violations.push({
      line: call.getStartLineNumber(),
      method: method as ForbiddenMethod,
      text: call.getText().replace(/\s+/g, ' ').trim(),
    });
  }

  return violations;
}
