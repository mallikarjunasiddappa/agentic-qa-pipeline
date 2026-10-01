/**
 * Runs `fn` over `items` with at most `limit` calls in flight at once, preserving each result's
 * original index position in the returned array regardless of which call actually resolves first.
 * A worker-pool pattern, not fixed-size batching - a worker picks up the next item the moment it's
 * free, rather than every worker waiting for the slowest item in the current batch before the next
 * batch starts. First real use: checkDrift() in traceabilityAgent.ts, which used to fire one
 * tms.getCase() call at a time, sequentially, for every manifest entry - fine at dozens of
 * entries, a genuine multi-minute bottleneck at thousands.
 *
 * Written in-house rather than pulling in a library (e.g. p-limit) for this - CLAUDE.md's "no new
 * npm dependencies without asking" rule, and the actual logic is small: a shared queue cursor plus
 * a fixed number of self-refilling worker loops.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await fn(items[currentIndex], currentIndex);
    }
  }

  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return results;
}
