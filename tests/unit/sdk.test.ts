import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defineBlock, validateBlockValue } from '../../packages/sdk/src/block.js';
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

test('schema IDs survive repeated definitions, clones and value validation', () => {
  const schema = { $id: 'urn:runsett:repeat', type: 'object', $defs: { value: { type: 'number' } }, properties: { value: { $ref: '#/$defs/value' } }, required: ['value'], additionalProperties: false };
  let block = defineBlock({ ...base, inputSchema: schema });
  for (let index = 0; index < 3; index++) {
    block = defineBlock(JSON.parse(JSON.stringify(block)));
    validateBlockValue(block.inputSchema, { value: 2 });
    assert.throws(() => validateBlockValue(block.inputSchema, { value: 'wrong' }), /schema/);
  }
});
test('same IDs in independent schemas cannot collide or satisfy external references', () => {
  const numberSchema = { $id: 'urn:runsett:scoped', $defs: { value: { type: 'number' } }, $ref: '#/$defs/value' };
  const stringSchema = { $id: 'urn:runsett:scoped', $defs: { value: { type: 'string' } }, $ref: '#/$defs/value' };
  const numeric = defineBlock({ ...base, inputSchema: numberSchema, outputSchema: stringSchema });
  const textual = defineBlock({ ...base, name: 'textual', inputSchema: stringSchema, outputSchema: numberSchema });
  for (const block of [numeric, textual, numeric]) {
    const numberInput = block.name === 'double';
    validateBlockValue(block.inputSchema, numberInput ? 3 : 'text');
    assert.throws(() => validateBlockValue(block.inputSchema, numberInput ? 'wrong' : 3), /schema/);
  }
  assert.throws(() => defineBlock({ ...base, inputSchema: { $ref: 'urn:runsett:scoped' } }));
  assert.throws(() => defineBlock({ ...base, inputSchema: { $ref: 'https://external.invalid/schema' } }));
});
test('validation cache cannot retain a caller-mutated schema under its earlier content', () => {
  const schema = { $id: 'urn:runsett:mutable', type: 'number' };
  validateBlockValue(schema, 3);
  schema.type = 'string';
  validateBlockValue(schema, 'text');
  assert.throws(() => validateBlockValue(schema, 3), /schema/);
});
