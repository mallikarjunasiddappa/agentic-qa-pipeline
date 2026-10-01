import { FlakyRunResult } from '../types/schemas';

/**
 * True unless every observed result is identical. An empty input has nothing to compare and is a
 * caller bug (the pipeline stage always requires >=2 results before calling this).
 */
export function decideFlaky(results: FlakyRunResult[]): boolean {
  if (results.length === 0) {
    throw new Error('decideFlaky requires at least one result to evaluate');
  }
  return results.some((result) => result !== results[0]);
}
