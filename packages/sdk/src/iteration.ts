/** Prevalidates every key; rejects immediately on failure, without starting queued work.
 * Already-dispatched operations remain owned by the workflow/Temporal cancellation scope.
 */
export async function mapItems<T, R>(items: readonly T[], options: { key: (item: T) => string; concurrency: number }, fn: (item: T, key: string) => Promise<R>): Promise<R[]> {
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 100) throw new RangeError('concurrency must be an integer from 1 to 100');
  const keys = items.map(options.key);
  if (keys.some(key => typeof key !== 'string' || key.length === 0) || new Set(keys).size !== keys.length) throw new TypeError('Item keys must be nonempty unique strings');
  const results: R[] = new Array(items.length);
  let cursor = 0; let failed = false;
  async function consume(): Promise<void> {
    while (!failed && cursor < items.length) {
      const index = cursor++;
      try { results[index] = await fn(items[index]!, keys[index]!); }
      catch (error) { failed = true; throw error; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(items.length, options.concurrency) }, consume));
  return results;
}
