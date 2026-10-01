import { Finding } from './astDiff';

// // assertion-integrity: approved — <reason>   (em dash, "--", or "-" all accepted as separator)
// A reason is required - the tag alone with nothing after it does not match, so a suppression
// can't be copy-pasted without an actual justification landing in git blame.
const SUPPRESSION_RE = /^\s*\/\/\s*assertion-integrity:\s*approved\s*(?:—|-{1,2})\s*(\S.*)$/;

export interface SuppressionComment {
  line: number;
  reason: string;
}

/** Scans raw source text for suppression comments and the (1-based) line each sits on. */
export function findSuppressionComments(sourceText: string): SuppressionComment[] {
  return sourceText
    .split('\n')
    .map((line, index): SuppressionComment | null => {
      const match = line.match(SUPPRESSION_RE);
      return match ? { line: index + 1, reason: match[1].trim() } : null;
    })
    .filter((c): c is SuppressionComment => c !== null);
}

/**
 * Finds the suppression (if any) that clears `finding`. Deliberately scoped so a single comment
 * can never suppress the whole file:
 * - Line-anchored findings (assertion still exists, just weakened/wrapped) require the comment on
 *   the exact line immediately above - not two lines above, not "somewhere nearby".
 * - Test-anchored findings (assertion fully deleted, no surviving line to anchor to) accept the
 *   comment anywhere within that one test's body. Note this means one test-scoped comment clears
 *   every deletion-type finding in that same test, not just one of them - there's no line left to
 *   disambiguate between multiple deletions in the same test.
 */
function matchSuppression(
  finding: Finding,
  suppressions: SuppressionComment[],
): SuppressionComment | undefined {
  const anchor = finding.anchor;
  if (anchor.kind === 'line') {
    return suppressions.find((s) => s.line === anchor.line - 1);
  }
  return suppressions.find((s) => s.line >= anchor.bodyStartLine && s.line <= anchor.bodyEndLine);
}

export function isSuppressed(finding: Finding, suppressions: SuppressionComment[]): boolean {
  return matchSuppression(finding, suppressions) !== undefined;
}

export interface FindingWithSuppression {
  finding: Finding;
  suppressed: boolean;
  suppressionReason: string | null;
}

/** Applies suppression comments (parsed from the new file's source) to a list of findings. */
export function applySuppressions(findings: Finding[], newSourceText: string): FindingWithSuppression[] {
  const suppressions = findSuppressionComments(newSourceText);
  return findings.map((finding) => {
    const match = matchSuppression(finding, suppressions);
    return { finding, suppressed: match !== undefined, suppressionReason: match?.reason ?? null };
  });
}
