import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ModuleRegistry } from '../../packages/runner/src/registry.js';
import { BoundedChannel } from '../../packages/runner/src/protocol.js';
import { DiagnosticCollector } from '../../packages/runner/src/diagnostics.js';
import { createCodeExecutor } from '../../packages/runner/src/supervisor.js';
import { DEFAULT_EXECUTION_LIMITS } from '@runsett/contracts';
import { spawn } from 'node:child_process';
import { RUNNER_READY } from '../../packages/runner/src/protocol.js';

const entry = { moduleId: 'transform', moduleHash: 'a'.repeat(64), path: '/opt/runsett/modules/main.mjs', image: `sha256:${'b'.repeat(64)}` };
for (const prefix of ['', RUNNER_READY.subarray(0, 5).toString()]) {
  test(`clean attachment exit with ${prefix ? 'partial' : 'absent'} READY fails promptly as infrastructure`, async () => {
    let removed = false;
    const execute = createCodeExecutor({ registry: new ModuleRegistry([{ ...entry, path: '/opt/runsett/modules/main.mjs' }]), scope: 'unit-early-attachment', runtime: {
      create: async () => 'synthetic-attachment',
      attach: () => spawn(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(prefix)})`], { stdio: ['pipe', 'pipe', 'pipe'] }),
      remove: async () => { removed = true; },
    } });
    const started = Date.now();
    try {
      await assert.rejects(execute({ identity: { workflowId: 'w', runId: 'r', stepId: 's', attempt: 1, operationKey: 'o', deploymentId: 'd' }, moduleId: 'transform', moduleHash: entry.moduleHash, input: null, credentialBindings: [], networkMode: 'none', limits: { ...DEFAULT_EXECUTION_LIMITS, wallClockMs: 2000 } }), { code: 'INFRASTRUCTURE_ERROR' });
      assert.ok(Date.now() - started < 1000, 'must settle before the invocation deadline');
      assert.equal(removed, true);
    } finally { execute.close(); }
  });
}
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

test('cancellation during stalled startup settles before reconciliation is released', async () => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const execute = createCodeExecutor({ registry: new ModuleRegistry([{ ...entry, path: '/opt/runsett/modules/main.mjs' }]), onReconciliation: () => blocked });
  const controller = new AbortController();
  const pending = execute({ identity: { workflowId: 'w', runId: 'r', stepId: 's', attempt: 1, operationKey: 'o', deploymentId: 'd' }, moduleId: 'transform', moduleHash: entry.moduleHash, input: null, credentialBindings: [], networkMode: 'none', limits: DEFAULT_EXECUTION_LIMITS }, controller.signal).catch(error => error);
  controller.abort();
  try {
    const result = await Promise.race([pending, new Promise(resolve => setTimeout(() => resolve('still pending'), 200))]);
    assert.equal((result as any).code, 'CANCELLED');
  } finally { release(); execute.close(); await pending; }
});

test('one absolute deadline bounds stalled startup reconciliation', async () => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const execute = createCodeExecutor({ registry: new ModuleRegistry([{ ...entry, path: '/opt/runsett/modules/main.mjs' }]), onReconciliation: () => blocked });
  const pending = execute({ identity: { workflowId: 'w', runId: 'r', stepId: 's', attempt: 1, operationKey: 'o', deploymentId: 'd' }, moduleId: 'transform', moduleHash: entry.moduleHash, input: null, credentialBindings: [], networkMode: 'none', limits: { ...DEFAULT_EXECUTION_LIMITS, wallClockMs: 50 } }).catch(error => error);
  try {
    const result = await Promise.race([pending, new Promise(resolve => setTimeout(() => resolve('still pending'), 200))]);
    assert.equal((result as any).code, 'TIMEOUT');
  } finally { release(); execute.close(); await pending; }
});
