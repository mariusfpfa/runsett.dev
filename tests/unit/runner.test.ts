import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ModuleRegistry } from '../../packages/runner/src/registry.js';
import { BoundedChannel } from '../../packages/runner/src/protocol.js';
import { DiagnosticCollector } from '../../packages/runner/src/diagnostics.js';
import { createCodeExecutor } from '../../packages/runner/src/supervisor.js';
import { DEFAULT_EXECUTION_LIMITS } from '@runsett/contracts';

const entry = { moduleId: 'transform', moduleHash: 'a'.repeat(64), path: '/opt/runsett/modules/main.mjs', image: `sha256:${'b'.repeat(64)}` };
test('registry resolves only immutable registered module identities', () => {
  const registry = new ModuleRegistry([entry]);
  assert.deepEqual(registry.resolve(entry.moduleId, entry.moduleHash), entry);
  for (const [id, hash] of [['../main', entry.moduleHash], [entry.path, entry.moduleHash], ['transform', 'c'.repeat(64)]]) {
    assert.throws(() => registry.resolve(id!, hash!));
  }
  assert.throws(() => new ModuleRegistry([entry, entry]));
  for (const change of [{ path: '/tmp/main.mjs' }, { path: '/opt/runsett/modules/../escape.mjs' }, { image: 'node:24' }, { moduleHash: 'bad' }]) {
    assert.throws(() => new ModuleRegistry([{ ...entry, ...change }]));
  }
  entry.path = '/changed';
  assert.equal(registry.resolve('transform', 'a'.repeat(64)).path, '/opt/runsett/modules/main.mjs');
});
test('bounded channels reject overflow before retaining excess bytes', () => {
  const channel = new BoundedChannel(4);
  channel.push(Buffer.from('ab'));
  assert.throws(() => channel.push(Buffer.from('cde')), /limit/i);
  assert.equal(channel.bytes, 2);
});
test('diagnostics redact credentials spanning chunks and enforce combined raw budget', () => {
  const logs = new DiagnosticCollector(64, ['secret-value']);
  logs.push('stdout', Buffer.from('hello sec'));
  logs.push('stdout', Buffer.from('ret-value'));
  logs.push('stderr', Buffer.from('secret-value'));
  assert.equal(logs.finish().map((d) => d.message).join(''), 'hello [REDACTED][REDACTED]');
  assert.throws(() => logs.push('stderr', Buffer.alloc(64)), /limit/i);
});
test('executor rejects invalid input, raised limits, unapproved bindings and networking before Docker', async () => {
  const execute = createCodeExecutor({ registry: new ModuleRegistry([{ ...entry, path: '/opt/runsett/modules/main.mjs' }]), credentials: { allowed: 'value' } });
  const invocation = { identity: { workflowId: 'w', runId: 'r', stepId: 's', attempt: 1, operationKey: 'o', deploymentId: 'd' }, moduleId: 'transform', moduleHash: entry.moduleHash, input: null, credentialBindings: [], networkMode: 'none' as const, limits: DEFAULT_EXECUTION_LIMITS };
  for (const change of [{ input: 'x'.repeat(1024 * 1024) }, { credentialBindings: ['unknown'] }, { networkMode: 'configured' }, { limits: { ...DEFAULT_EXECUTION_LIMITS, pids: 100 } }]) {
    await assert.rejects(execute({ ...invocation, ...change } as typeof invocation), { code: 'VALIDATION_ERROR' });
  }
});
test('credential redaction preserves JSON syntax for escaped secrets', async () => {
  const { redactJson } = await import('../../packages/runner/src/diagnostics.js');
  const secret = 'secret"\nvalue';
  assert.deepEqual(redactJson({ nested: [secret], [secret]: 'text' }, [secret]), { nested: ['[REDACTED]'], '[REDACTED]': 'text' });
});
