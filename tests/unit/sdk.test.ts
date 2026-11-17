import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defineBlock } from '../../packages/sdk/src/block.js';
const base = { name: 'double', version: '1', moduleId: 'double', moduleHash: 'a'.repeat(64), inputSchema: { type: 'number' }, outputSchema: { type: 'number' }, effect: 'pure' as const, credentialBindings: [], networkMode: 'none' as const };
test('defineBlock defaults to one attempt, snapshots serializable schemas and respects explicit retries', () => {
  const block = defineBlock(base);
  assert.equal(block.maximumAttempts, 1);
  assert.equal(defineBlock({ ...base, effect: 'write', maximumAttempts: 3 }).maximumAttempts, 3);
  assert.deepEqual(JSON.parse(JSON.stringify(block)), block);
  assert.notEqual(block.inputSchema, base.inputSchema);
  assert.ok(Object.isFrozen(block.inputSchema));
});
test('defineBlock rejects invalid JSON Schema and unserializable metadata', () => {
  for (const value of [
    { ...base, inputSchema: { type: 'nonsense' } }, { ...base, inputSchema: { type: 'object', properties: { x: { type: 'number' } }, required: 'x' } },
    { ...base, outputSchema: { validate: () => true } }, { ...base, inputSchema: { $ref: 'https://external.invalid/schema' } },
    { ...base, maximumAttempts: 0 }, { ...base, maximumAttempts: 1.5 }, { ...base, effect: 'unsafe' }, { ...base, moduleHash: 'tag' },
    { ...base, credentialBindings: ['x', 'x'] }, { ...base, networkMode: 'host' }, { ...base, unknown: true },
    { ...base, name: undefined }, { ...base, version: new Date() },
  ]) assert.throws(() => defineBlock(value as never));
});
test('defineBlock rejects async validator schemas rather than treating a Promise as validation success', () => {
  assert.throws(() => defineBlock({ ...base, inputSchema: { $async: true, type: 'number' } }));
});
