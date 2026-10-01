import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapWithConcurrency } from './concurrency';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('mapWithConcurrency: results land at their original index regardless of resolution order', async () => {
  // Item 0 is deliberately the slowest, so if results were appended in completion order instead
  // of index order, this would come back as [30, 20, 10] instead of [10, 20, 30].
  const items = [
    { value: 10, delayMs: 30 },
    { value: 20, delayMs: 10 },
    { value: 30, delayMs: 0 },
  ];
  const results = await mapWithConcurrency(items, 3, async (item) => {
    await delay(item.delayMs);
    return item.value;
  });
  assert.deepEqual(results, [10, 20, 30]);
});

test('mapWithConcurrency: never runs more than `limit` calls at once', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const items = Array.from({ length: 20 }, (_, i) => i);

  await mapWithConcurrency(items, 4, async (item) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await delay(5);
    inFlight -= 1;
    return item;
  });

  assert.ok(maxInFlight <= 4, `expected max 4 concurrent calls, saw ${maxInFlight}`);
  assert.ok(maxInFlight > 1, 'expected genuine concurrency, not accidental serialization');
});

test('mapWithConcurrency: processes every item exactly once', async () => {
  const items = Array.from({ length: 37 }, (_, i) => i);
  const seen: number[] = [];
  const results = await mapWithConcurrency(items, 5, async (item) => {
    seen.push(item);
    return item * 2;
  });

  assert.equal(seen.length, 37);
  assert.deepEqual(new Set(seen), new Set(items));
  assert.deepEqual(results, items.map((i) => i * 2));
});

test('mapWithConcurrency: a thrown error from one call rejects the whole call', async () => {
  const items = [1, 2, 3, 4, 5];
  await assert.rejects(
    mapWithConcurrency(items, 2, async (item) => {
      if (item === 3) throw new Error('boom');
      return item;
    }),
    /boom/,
  );
});

test('mapWithConcurrency: limit larger than the item count does not error', async () => {
  const results = await mapWithConcurrency([1, 2], 10, async (item) => item);
  assert.deepEqual(results, [1, 2]);
});

test('mapWithConcurrency: empty input returns empty output', async () => {
  const results = await mapWithConcurrency([], 5, async (item) => item);
  assert.deepEqual(results, []);
});
