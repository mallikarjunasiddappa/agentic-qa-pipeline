import type { ExecutionHistory, RiskBand } from './classify';

/**
 * Section 6 of the Suite Health spec: weight every finding, and sort the report by risk rather
 * than by verdict.
 *
 *     risk = area weight x blast radius x execution frequency
 *
 * WHY THIS EXISTS. A cold test on the About page and a cold test on authentication are not the
 * same finding, and presenting them as one is how a report gets skimmed and closed. A QA lead
 * reads the top twenty rows and nothing else, so what lands in those twenty rows is the whole
 * product.
 *
 * NOTHING IS INFERRED. Area weights are per-project configuration, passed in. One customer's
 * "billing" is another's "core", and a guessed weight is indistinguishable from a measured one
 * once it is a number in a column. SUGGESTED_AREA_WEIGHTS below is a starting point to copy into
 * a project's configuration, deliberately NOT a default this module applies on its own.
 *
 * Pure: numbers in, numbers out.
 */

export interface RiskInput {
  caseId: string;
  /**
   * Jira components and labels for the story this case traces to. Matched case-insensitively
   * against the configured weights.
   */
  areas: string[];
  /**
   * Does a failure here block a release?
   *
   * An assertion someone made, not something derived from the ticket. There is no field in Jira
   * that means this, and reading one into a label would be exactly the kind of guess the sort
   * order cannot afford.
   */
  blocksRelease: boolean;
  execution: ExecutionHistory;
}

export interface AreaWeightConfig {
  /** Area name (matched case-insensitively) -> weight. Empty is legal and means "unconfigured". */
  weights: Record<string, number>;
  /** Applied when a case matches no configured area. */
  defaultWeight: number;
}

export interface RiskFactors {
  area: number;
  blastRadius: number;
  frequency: number;
}

export interface RiskScore {
  caseId: string;
  /** The sort key. Rounded to two places; only comparisons matter, not the absolute value. */
  score: number;
  /** Feeds `collectSignals`' `riskBands`. See the band rules below - it is NOT derived from score. */
  band: RiskBand;
  factors: RiskFactors;
  /** Which configured areas matched. Evidence, so a surprising sort position can be explained. */
  matchedAreas: string[];
  /** False when the case matched nothing configured and fell back to defaultWeight. */
  areaConfigured: boolean;
}

/**
 * A starting point for a project's configuration, from the spec's examples. NOT applied
 * automatically - a caller has to pass it in, which is the difference between a default someone
 * chose and a default that happened to them.
 */
export const SUGGESTED_AREA_WEIGHTS: Readonly<Record<string, number>> = Object.freeze({
  payments: 3,
  billing: 3,
  auth: 3,
  authentication: 3,
  security: 3,
  'personal-data': 3,
  gdpr: 3,
  checkout: 2,
  marketing: 0.5,
  about: 0.5,
});

export const DEFAULT_AREA_WEIGHT = 1;

/** A weight at or above this makes a case high-risk. Ties to SUGGESTED_AREA_WEIGHTS' top band. */
export const HIGH_AREA_WEIGHT = 3;
/** A weight at or below this makes a case low-risk. */
export const LOW_AREA_WEIGHT = 0.5;

/** Applied when a failure blocks a release. */
export const BLOCKING_MULTIPLIER = 2;

/**
 * Execution frequency, compressed.
 *
 * Raw run counts cannot be a multiplier: a test that has run 4,000 times would outrank an
 * unconfigured auth test by three orders of magnitude, and the area weight - the one factor a
 * human actually configured - would stop mattering at all. log10 keeps the ordering (more runs
 * still ranks higher) while holding the whole realistic range inside roughly 1x to 4x, so area
 * weight stays the dominant term. 0 runs gives exactly 1, not 0, because a never-run test must
 * not have its risk multiplied away to nothing - "never run" is itself a finding.
 */
export function frequencyFactor(totalRuns: number): number {
  if (totalRuns <= 0) return 1;
  return 1 + Math.log10(1 + totalRuns);
}

function normalise(area: string): string {
  return area.trim().toLowerCase();
}

/**
 * Highest configured weight among the case's areas.
 *
 * HIGHEST, not average. A case tagged both "payments" and "reporting" is a payments case that
 * also touches reporting; averaging would let an unrelated second label dilute a real risk, which
 * is the wrong direction for the one number that decides what a person reads first.
 */
function resolveArea(
  areas: string[],
  config: AreaWeightConfig,
): { weight: number; matched: string[]; configured: boolean } {
  const configured = new Map(
    Object.entries(config.weights).map(([name, weight]) => [normalise(name), weight]),
  );

  const matched: string[] = [];
  let weight: number | null = null;
  for (const area of areas) {
    const found = configured.get(normalise(area));
    if (found === undefined) continue;
    matched.push(normalise(area));
    if (weight === null || found > weight) weight = found;
  }

  matched.sort();
  return weight === null
    ? { weight: config.defaultWeight, matched: [], configured: false }
    : { weight, matched, configured: true };
}

export function scoreRisk(input: RiskInput, config: AreaWeightConfig): RiskScore {
  const area = resolveArea(input.areas, config);
  const blastRadius = input.blocksRelease ? BLOCKING_MULTIPLIER : 1;
  const frequency = frequencyFactor(input.execution.totalRuns);

  return {
    caseId: input.caseId,
    score: Math.round(area.weight * blastRadius * frequency * 100) / 100,
    // Band comes from the CONFIGURED area weight alone, never from the score. Frequency and blast
    // radius must not be able to promote an unconfigured About-page test into the high band -
    // COLD_BUT_LOAD_BEARING says "keep this, it is protecting something important", and that
    // sentence cannot rest on a run count.
    band: !area.configured
      ? 'medium'
      : area.weight >= HIGH_AREA_WEIGHT
        ? 'high'
        : area.weight <= LOW_AREA_WEIGHT
          ? 'low'
          : 'medium',
    factors: {
      area: area.weight,
      blastRadius,
      frequency: Math.round(frequency * 100) / 100,
    },
    matchedAreas: area.matched,
    areaConfigured: area.configured,
  };
}

export function scoreAllRisk(inputs: RiskInput[], config: AreaWeightConfig): RiskScore[] {
  return inputs.map((input) => scoreRisk(input, config));
}

/** Feeds `collectSignals`' `riskBands` input. */
export function toRiskBands(scores: RiskScore[]): Record<string, RiskBand> {
  const bands: Record<string, RiskBand> = {};
  for (const score of scores) bands[score.caseId] = score.band;
  return bands;
}

/**
 * Sort comparator for the report: highest risk first, case id as the tiebreak.
 *
 * The tiebreak is not cosmetic. Without it, two equal-risk rows can swap places between runs, and
 * a report that reorders itself when nothing changed is a report nobody diffs.
 */
export function compareByRisk(a: RiskScore, b: RiskScore): number {
  return b.score - a.score || a.caseId.localeCompare(b.caseId);
}
