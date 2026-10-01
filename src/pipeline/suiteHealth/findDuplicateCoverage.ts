import type { TmsCaseDetail } from '../testmgmt/types';

/**
 * Signal 2 of the Suite Health report: which existing test cases substantially duplicate each other.
 *
 * WHY THIS IS NOT `scenarioGuard/checkDuplicateCoverage`. That rule compares the scenarios inside
 * ONE ticket's generated batch, before any of them is created, to stop the generator emitting the
 * same scenario twice. It never sees the other 1,200 cases already in the tool, and its `tokenize`
 * / `jaccard` helpers are private to that file. Same family of problem, different corpus.
 *
 * The tokenizer, stopword list and threshold below are deliberately IDENTICAL to that rule's. Two
 * tools in the same pipeline that disagree about what "duplicate" means is worse than either tool
 * alone, because it makes both unarguable. If that rule's threshold is retuned, retune this one.
 *
 * Pure: text in, pairs out.
 */

// Copied verbatim from scenarioQualityRules so the two agree. Not imported, because it is private
// there; exporting it would widen that module's public surface for one caller.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'to', 'of', 'on', 'in', 'is', 'are', 'was', 'were', 'be', 'been', 'and', 'or',
  'for', 'with', 'that', 'this', 'it', 'as', 'at', 'by', 'from', 'should', 'will', 'shall', 'then',
  'when', 'after', 'before', 'user', 'page', 'into', 'out', 'not', 'no', 'can', 'has', 'have', 'had',
]);

/** Same as scenarioQualityRules'. See the note above before changing either. */
export const DUPLICATE_SIMILARITY_THRESHOLD = 0.6;

/**
 * A token appearing in more than this share of the corpus is used for scoring but not for finding
 * candidates. "click", "verify", "login" appear everywhere; pairing on them would compare every
 * case against every other one and buy nothing, since the similarity score would reject them
 * anyway. This only bounds the work, it never changes a verdict.
 */
export const COMMON_TERM_RATIO = 0.3;

/** Shared terms shown as evidence per pair. Enough to judge, few enough to read. */
const MAX_SHARED_TERMS = 8;

export interface DuplicateCandidate {
  caseId: string;
  title: string;
  /** Steps and expected results, in order - the same text the batch-scoped rule compares. */
  body: string[];
}

export interface DuplicatePair {
  /** Sorted, so the same corpus always yields the same pair identity. */
  caseIds: [string, string];
  /** 0-1, rounded to two places. */
  similarity: number;
  /**
   * The overlapping terms, rarest across the corpus first. A verdict without evidence is an
   * opinion - and "refund, chargeback, settlement" argues the case where "choose, confirm, value"
   * does not, even though both are true. Ties break alphabetically so the output is stable.
   */
  sharedTerms: string[];
  /**
   * The case to keep, if the pair is consolidated: the one carrying more detail.
   *
   * A SUGGESTION for a person to act on. The action on DUPLICATE is consolidate-and-archive, and
   * nothing in this feature deletes anything - see the design rules in the spec.
   */
  suggestedSurvivor: string;
}

export interface FindDuplicateOptions {
  similarityThreshold?: number;
  commonTermRatio?: number;
}

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    (word) => word.length >= 3 && !STOPWORDS.has(word),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Maps a case as the test management adapter returns it into something comparable. */
export function candidateFromTmsCase(detail: TmsCaseDetail): DuplicateCandidate {
  const body: string[] = [];
  if (detail.preconditions) body.push(detail.preconditions);
  if (detail.description) body.push(detail.description);
  for (const step of detail.steps) {
    body.push(step.action);
    if (step.expectedResult) body.push(step.expectedResult);
  }
  return { caseId: detail.id, title: detail.title, body };
}

interface Indexed {
  caseId: string;
  tokens: Set<string>;
}

/**
 * Unordered pair identity, so (A,B) and (B,A) are the same key.
 *
 * The separator is an escaped NUL rather than a punctuation character because a case id is
 * provider-defined text: any printable separator could legitimately appear inside an id and make
 * two different pairs collide. Written as an escape so the source file stays plain ASCII.
 */
const PAIR_SEPARATOR = '\u0000';

function pairKey(a: string, b: string): string {
  return a < b ? `${a}${PAIR_SEPARATOR}${b}` : `${b}${PAIR_SEPARATOR}${a}`;
}

/**
 * Finds every pair of cases whose text overlaps above the threshold.
 *
 * PAIRS, NOT CLUSTERS, on purpose. Chaining A~B and B~C into one group of three quietly asserts
 * A~C, which the scores never showed. On a corpus this size that transitive merge snowballs into
 * one enormous "duplicate group" that is impossible to act on and obviously wrong to anyone who
 * reads it. Each pair here stands on its own measured score. `collectSignals` turns the pairs into
 * per-case neighbour lists, which is exactly the direct-neighbour semantics `duplicateOfCaseIds`
 * wants.
 */
export function findDuplicateCoverage(
  candidates: DuplicateCandidate[],
  options: FindDuplicateOptions = {},
): DuplicatePair[] {
  const threshold = options.similarityThreshold ?? DUPLICATE_SIMILARITY_THRESHOLD;
  const commonRatio = options.commonTermRatio ?? COMMON_TERM_RATIO;

  const indexed: Indexed[] = candidates.map((candidate) => ({
    caseId: candidate.caseId,
    tokens: new Set(tokenize([candidate.title, ...candidate.body].join(' '))),
  }));
  const byCaseId = new Map(indexed.map((entry) => [entry.caseId, entry]));

  // Document frequency, then an inverted index over the terms that are not ubiquitous.
  const documentFrequency = new Map<string, number>();
  for (const entry of indexed) {
    for (const token of entry.tokens) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }
  const commonThreshold = indexed.length * commonRatio;
  const postings = new Map<string, string[]>();
  for (const entry of indexed) {
    for (const token of entry.tokens) {
      if ((documentFrequency.get(token) ?? 0) > commonThreshold) continue;
      postings.set(token, [...(postings.get(token) ?? []), entry.caseId]);
    }
  }

  const seen = new Set<string>();
  const pairs: DuplicatePair[] = [];

  for (const entry of indexed) {
    const distinctive = [...entry.tokens].filter(
      (token) => (documentFrequency.get(token) ?? 0) <= commonThreshold,
    );

    // A case made entirely of ubiquitous words has no distinctive term to pair on. Rather than
    // drop it silently, compare it against the other cases in the same position - a bounded set,
    // because by definition few cases are pure boilerplate.
    const candidateIds =
      distinctive.length > 0
        ? distinctive.flatMap((token) => postings.get(token) ?? [])
        : indexed
            .filter((other) =>
              [...other.tokens].every((token) => (documentFrequency.get(token) ?? 0) > commonThreshold),
            )
            .map((other) => other.caseId);

    for (const otherId of candidateIds) {
      if (otherId === entry.caseId) continue;
      const key = pairKey(entry.caseId, otherId);
      if (seen.has(key)) continue;
      seen.add(key);

      const other = byCaseId.get(otherId);
      if (!other) continue;

      const similarity = jaccard(entry.tokens, other.tokens);
      if (similarity < threshold) continue;

      const shared = [...entry.tokens]
        .filter((token) => other.tokens.has(token))
        .sort(
          (a, b) =>
            (documentFrequency.get(a) ?? 0) - (documentFrequency.get(b) ?? 0) || a.localeCompare(b),
        );
      const [first, second] =
        entry.caseId < other.caseId ? [entry, other] : [other, entry];

      pairs.push({
        caseIds: [first.caseId, second.caseId],
        similarity: Math.round(similarity * 100) / 100,
        sharedTerms: shared.slice(0, MAX_SHARED_TERMS),
        // More tokens means more detail written down. Ties go to the lower id purely so the
        // output is stable; there is no claim that the older case is the better one.
        suggestedSurvivor:
          first.tokens.size === second.tokens.size
            ? first.caseId
            : first.tokens.size > second.tokens.size
              ? first.caseId
              : second.caseId,
      });
    }
  }

  return pairs.sort(
    (a, b) =>
      b.similarity - a.similarity ||
      a.caseIds[0].localeCompare(b.caseIds[0]) ||
      a.caseIds[1].localeCompare(b.caseIds[1]),
  );
}

/** Feeds `collectSignals`' `duplicateGroups` input. One two-element group per measured pair. */
export function toDuplicateGroups(pairs: DuplicatePair[]): string[][] {
  return pairs.map((pair) => [pair.caseIds[0], pair.caseIds[1]]);
}
