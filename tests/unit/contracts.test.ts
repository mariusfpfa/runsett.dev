import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertJsonValue, assertExecutionLimits, DEFAULT_EXECUTION_LIMITS,
  assertExecutionIdentity, assertCodeInvocation, assertCodeResult,
  assertExecutionError, ExecutionError, MAX_ERROR_STACK_BYTES,
} from '../../packages/contracts/src/index.js';

const MIB = 1_048_576;
const identity = { workflowId: 'flow', runId: 'run', stepId: 'step', attempt: 1, operationKey: 'stable', deploymentId: 'v1' };
const diagnostic = { stream: 'stdout' as const, message: 'done', timestamp: '2026-11-17T00:00:00.000Z' };
const result = { output: { ok: true }, diagnostics: [diagnostic], moduleHash: 'abc123', startedAt: '2026-11-17T00:00:00.000Z', finishedAt: '2026-11-17T00:00:01.000Z' };

test('contracts: valid nested JSON round-trips without altering values', () => {
  const value = { nil: null, yes: true, no: false, number: 1.5, text: '😀', list: [0, 'x', { deep: [] }] };
  assertJsonValue(value, MIB);
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value);
  assertJsonValue(Object.assign(Object.create(null), { ok: 1 }), MIB);
  const shared = { value: 1 };
  assertJsonValue([shared, shared], MIB);
});

const cyclic: Record<string, unknown> = {};
cyclic.self = cyclic;
const hidden = Object.defineProperty({}, 'hidden', { value: 1 });
const accessor = Object.defineProperty({}, 'value', { enumerable: true, get() { throw new Error('getter must not run'); } });
const extraArray = Object.assign([1], { extra: 2 });
for (const [name, value] of Object.entries({
  undefined, nestedUndefined: { a: undefined }, nan: NaN, infinity: Infinity,
  negativeInfinity: -Infinity, bigint: 1n, fn: () => 1, symbol: Symbol('x'),
  cycle: cyclic, date: new Date(), map: new Map(), set: new Set(),
  bytes: new Uint8Array([1]), instance: new (class Example { value = 1; })(),
  sparse: new Array(2), extraArray, hidden, accessor,
  symbolKey: { [Symbol('key')]: 1 }, toJSON: { toJSON: () => 'changed' },
  arrayInstance: new (class CustomArray extends Array {})(1).fill(2),
})) {
  test(`contracts: rejects unsupported JSON ${name}`, () => {
    assert.throws(() => assertJsonValue(value, MIB));
  });
}

test('contracts: counts serialized UTF-8 bytes at the 1 MiB boundary', () => {
  const value = 'é'.repeat(524_287); // 1,048,574 bytes plus two JSON quotes.
  assert.equal(Buffer.byteLength(JSON.stringify(value)), MIB);
  assert.doesNotThrow(() => assertJsonValue(value, MIB));
  assert.throws(() => assertJsonValue(`${value}a`, MIB));
  assert.doesNotThrow(() => assertJsonValue('😀', 6));
  assert.throws(() => assertJsonValue('😀', 5));
  assert.doesNotThrow(() => assertJsonValue('\ud800', 8));
  assert.throws(() => assertJsonValue('\ud800', 7));
  assert.throws(() => assertJsonValue('\n', 3));
});

test('contracts: rejects invalid byte budgets', () => {
  for (const invalid of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => assertJsonValue(null, invalid));
  }
});

test('contracts: default limits enforce the approved execution budgets', () => {
  assert.deepEqual(DEFAULT_EXECUTION_LIMITS, {
    wallClockMs: 30_000, memoryBytes: 268_435_456, cpus: 1, pids: 64,
    inputBytes: MIB, resultBytes: MIB, diagnosticBytes: 262_144, cancellationGraceMs: 2_000,
  });
  assert.doesNotThrow(() => assertExecutionLimits(DEFAULT_EXECUTION_LIMITS));
  assert.doesNotThrow(() => assertExecutionLimits({ ...DEFAULT_EXECUTION_LIMITS, cpus: 0.5 }));
});

test('contracts: rejects missing, unknown, or invalid execution limits', () => {
  for (const key of ['wallClockMs', 'memoryBytes', 'pids', 'inputBytes', 'resultBytes', 'diagnosticBytes', 'cancellationGraceMs']) {
    for (const invalid of [0, -1, 1.5, NaN, Infinity, '10', undefined, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => assertExecutionLimits({ ...DEFAULT_EXECUTION_LIMITS, [key]: invalid }), key);
    }
  }
  for (const cpus of [0, -1, NaN, Infinity, '1']) {
    assert.throws(() => assertExecutionLimits({ ...DEFAULT_EXECUTION_LIMITS, cpus }));
  }
  assert.throws(() => assertExecutionLimits({ ...DEFAULT_EXECUTION_LIMITS, extra: true }));
  assert.throws(() => assertExecutionLimits(null));
});

test('contracts: validates identity and invocation at runtime', () => {
  const invocation = { identity, moduleId: 'transform', moduleHash: 'abc123', input: { ok: true }, credentialBindings: ['service'], networkMode: 'none', limits: DEFAULT_EXECUTION_LIMITS };
  assert.doesNotThrow(() => assertExecutionIdentity(identity));
  assert.doesNotThrow(() => assertCodeInvocation(invocation));
  assert.doesNotThrow(() => assertCodeInvocation({ ...invocation, input: 0, credentialBindings: [], limits: { ...DEFAULT_EXECUTION_LIMITS, inputBytes: 1 } }));
  for (const value of [null, { ...identity, workflowId: '' }, { ...identity, attempt: 0 }, { ...identity, attempt: 1.5 }]) {
    assert.throws(() => assertExecutionIdentity(value));
  }
  for (const value of [
    { ...invocation, identity: { ...identity, attempt: 0 } }, { ...invocation, moduleId: '' },
    { ...invocation, moduleHash: '' }, { ...invocation, input: undefined },
    { ...invocation, credentialBindings: [''] }, { ...invocation, credentialBindings: ['a', 'a'] },
    { ...invocation, networkMode: 'all' }, { ...invocation, limits: {} },
    { ...invocation, input: 'oversize', limits: { ...DEFAULT_EXECUTION_LIMITS, inputBytes: 3 } },
  ]) assert.throws(() => assertCodeInvocation(value));
});

test('contracts: validates results, timestamps and combined diagnostic bytes', () => {
  assert.doesNotThrow(() => assertCodeResult(result));
  for (const value of [
    { ...result, output: undefined }, { ...result, moduleHash: '' },
    { ...result, startedAt: 'yesterday' }, { ...result, finishedAt: '2026-11-16T00:00:00.000Z' },
    { ...result, diagnostics: [{ ...diagnostic, stream: 'other' }] },
    { ...result, diagnostics: [{ ...diagnostic, message: 'é'.repeat(131_073) }] },
    { ...result, diagnostics: [{ ...diagnostic, message: 'a'.repeat(131_073) }, { ...diagnostic, stream: 'stderr', message: 'b'.repeat(131_073) }] },
  ]) assert.throws(() => assertCodeResult(value));
  assert.throws(() => assertCodeResult(result, { ...DEFAULT_EXECUTION_LIMITS, resultBytes: 2 }));
  assert.throws(() => assertCodeResult({ ...result, diagnostics: Object.assign([], { toJSON: () => [] }) }));
});

test('contracts: validates stable error codes and serializable error details', () => {
  for (const code of ['VALIDATION_ERROR', 'RUNTIME_ERROR', 'TIMEOUT', 'CANCELLED', 'RESOURCE_LIMIT', 'OUTPUT_LIMIT', 'INFRASTRUCTURE_ERROR']) {
    assert.doesNotThrow(() => assertExecutionError({ code, message: 'failed', retryable: false, diagnostics: [] }));
  }
  for (const value of [
    { code: 'UNKNOWN', message: 'failed', retryable: false, diagnostics: [] },
    { code: 'TIMEOUT', message: 1, retryable: false, diagnostics: [] },
    { code: 'TIMEOUT', message: 'failed', retryable: 'yes', diagnostics: [] },
    { code: 'TIMEOUT', message: 'failed', retryable: false, diagnostics: [], stack: 'é'.repeat(4097) },
    { code: 'TIMEOUT', message: 'failed', retryable: false, diagnostics: [{ ...diagnostic, timestamp: 'invalid' }] },
  ]) assert.throws(() => assertExecutionError(value));
  const error = new ExecutionError({ code: 'TIMEOUT', message: 'deadline', retryable: false, diagnostics: [diagnostic], stack: 'trace' });
  assert.ok(error instanceof Error);
  assert.equal(error.message, 'deadline');
  const serialized = JSON.parse(JSON.stringify(error));
  assert.deepEqual(serialized, { code: 'TIMEOUT', message: 'deadline', retryable: false, diagnostics: [diagnostic], stack: 'trace' });
  assert.doesNotThrow(() => assertExecutionError(serialized));
  assert.throws(() => new ExecutionError({ code: 'UNKNOWN', message: 'bad', retryable: false, diagnostics: [] } as never));
  const noStack = JSON.parse(JSON.stringify(new ExecutionError({ code: 'RUNTIME_ERROR', message: 'bad', retryable: false, diagnostics: [] })));
  assert.ok(noStack.stack === undefined || Buffer.byteLength(noStack.stack) <= MAX_ERROR_STACK_BYTES);
});
