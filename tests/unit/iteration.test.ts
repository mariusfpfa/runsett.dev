import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapItems } from '../../packages/sdk/src/iteration.js';

test('mapItems rejects invalid concurrency and all duplicate/empty keys before dispatch', async () => {
  let dispatched = 0;
  for (const concurrency of [0, -1, 101, 1.5, NaN, Infinity]) {
    await assert.rejects(mapItems([1], { concurrency, key: String }, async () => { dispatched++; }));
  }
  await assert.rejects(mapItems([1, 1], { concurrency: 2, key: String }, async () => { dispatched++; }));
  await assert.rejects(mapItems([1], { concurrency: 2, key: () => '' }, async () => { dispatched++; }));
  assert.equal(dispatched, 0);
});
test('mapItems bounds parallelism and returns results in source order', async () => {
  let active = 0; let maximum = 0;
  const result = await mapItems([30, 20, 10, 5], { concurrency: 2, key: String }, async (item, key) => {
    maximum = Math.max(maximum, ++active);
    await new Promise(resolve => setTimeout(resolve, item));
    active--;
    return key;
  });
  assert.equal(maximum, 2);
  assert.deepEqual(result, ['30', '20', '10', '5']);
  assert.deepEqual(await mapItems([], { concurrency: 1, key: String }, async () => 0), []);
});
test('mapItems fails fast without dispatching queued work or unhandled late failures', async () => {
  const calls: number[] = [];
  await assert.rejects(mapItems([1, 2, 3, 4], { concurrency: 2, key: String }, async item => {
    calls.push(item);
    if (item === 1) throw new Error('first');
    await new Promise(resolve => setTimeout(resolve, 20));
    throw new Error('late');
  }), /first/);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(calls, [1, 2]);
});
