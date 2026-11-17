import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { DEFAULT_EXECUTION_LIMITS, type CodeInvocation } from '@runsett/contracts';
import { ModuleRegistry } from '../../packages/runner/src/registry.js';
import { createCodeExecutor } from '../../packages/runner/src/supervisor.js';
import { reconcileContainers } from '../../packages/runner/src/container.js';

const scope = `runner-test-${process.pid}`;
const orphanScope = `${scope}-orphan`;
async function waitUntil<T>(observe: () => T, timeoutMs = 10000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const value = observe(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error('Timed out waiting for container state');
}
let image: string;
let execute: ReturnType<typeof createCodeExecutor>;
let registry: ModuleRegistry;
const hash = (file: string) => createHash('sha256').update(readFileSync(`tests/fixtures/runner/${file}.mjs`)).digest('hex');
function invocation(mode: string, overrides: Partial<CodeInvocation> = {}): CodeInvocation {
  return { identity: { workflowId: scope, runId: 'run', stepId: mode, attempt: 1, operationKey: 'stable-key', deploymentId: 'v1' }, moduleId: 'main', moduleHash: hash('main'), input: { mode, value: 21 }, credentialBindings: [], networkMode: 'none', limits: DEFAULT_EXECUTION_LIMITS, ...overrides };
}
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: 'pipe' }).trim();
before(() => {
  image = docker('build', '-q', '-f', 'packages/runner/Dockerfile', '.');
  registry = new ModuleRegistry(['main', 'syntax'].map(moduleId => ({ moduleId, moduleHash: hash(moduleId), path: `/opt/runsett/modules/${moduleId}.mjs`, image })));
  execute = createCodeExecutor({ registry, scope, credentials: { service: 'credential-secret-value', unrelated: 'must-not-pass' }, reconciliationIntervalMs: 100 });
});
after(async () => {
  execute.close();
  await reconcileContainers(scope, Date.now() + 60_000);
  await reconcileContainers(orphanScope, Date.now() + 60_000);
  assert.equal(docker('ps', '-aq', '--filter', `label=runsett.scope=${scope}`), '');
});
test('container executes async ESM, packaged dependency and dedicated result channel', async () => {
  const result = await execute(invocation('transform'));
  assert.deepEqual(result.output, { value: 42, dependency: true, operationKey: 'stable-key', attempt: 1 });
  assert.match(result.diagnostics.map(d => d.message).join(''), /ordinary/);
});
test('container rejects syntax, runtime and unsupported outputs and redacts secrets', async () => {
  await assert.rejects(execute(invocation('syntax', { moduleId: 'syntax', moduleHash: hash('syntax') })), { code: 'RUNTIME_ERROR' });
  await assert.rejects(execute(invocation('throw', { credentialBindings: ['service'] })), (error: any) => {
    assert.equal(error.code, 'RUNTIME_ERROR');
    assert.ok(!JSON.stringify(error).includes('credential-secret-value'));
    assert.match(JSON.stringify(error), /REDACTED/);
    return true;
  });
  for (const mode of ['undefined', 'bigint', 'cycle', 'date']) await assert.rejects(execute(invocation(mode)), { code: 'RUNTIME_ERROR' });
});
test('container transports a maximum-sized valid JSON result without pipe truncation', async () => {
  const value = 'é'.repeat(524287);
  const result = await execute(invocation('echo', { input: value }));
  assert.equal(result.output, value);
});
test('container bounds result and combined stdout/stderr while streaming', async () => {
  await assert.rejects(execute(invocation('oversize')), { code: 'OUTPUT_LIMIT' });
  await assert.rejects(execute(invocation('flood')), { code: 'OUTPUT_LIMIT' });
});
test('container has no ambient secrets/socket, is non-root and read-only with scoped tmpfs', async () => {
  process.env.RUNSETT_UNRELATED_SECRET = 'ambient-supervisor-secret';
  const result = await execute(invocation('isolation', { credentialBindings: ['service'] }));
  assert.deepEqual(result.output, { uid: 1000, env: ['PATH', 'HOSTNAME'], socket: false, readOnly: true, credentials: ['service'], secret: '[REDACTED]', signal: false });
});
test('module hash mismatch is rejected inside immutable image', async () => {
  const wrong = createCodeExecutor({ scope, registry: new ModuleRegistry([{ moduleId: 'main', moduleHash: 'f'.repeat(64), path: '/opt/runsett/modules/main.mjs', image }]) });
  try { await assert.rejects(wrong(invocation('transform', { moduleHash: 'f'.repeat(64) })), { code: 'VALIDATION_ERROR' }); } finally { wrong.close(); }
});
test('timeout and cancellation terminate the entire container including descendants', async () => {
  await assert.rejects(execute(invocation('descendants', { limits: { ...DEFAULT_EXECUTION_LIMITS, wallClockMs: 3000, cancellationGraceMs: 100 } })), (error: any) => {
    assert.equal(error.code, 'TIMEOUT');
    assert.match(error.diagnostics.map((d: any) => d.message).join(''), /descendant-ready/);
    return true;
  });
  const controller = new AbortController();
  const pending = execute(invocation('cancel'), controller.signal);
  await waitUntil(() => docker('ps', '-q', '--filter', `label=runsett.scope=${scope}`));
  controller.abort();
  await assert.rejects(pending, { code: 'CANCELLED' });
  assert.equal(docker('ps', '-aq', '--filter', `label=runsett.scope=${scope}`), '');
});
test('independent watchdog bounds orphan lifetime and restarted supervisor reconciles unknown effects', async () => {
  const child = spawn(process.execPath, ['--import', 'tsx', 'tests/fixtures/runner/orphan.ts', image, orphanScope, hash('main')], { stdio: 'ignore' });
  const id = await waitUntil(() => docker('ps', '-q', '--filter', `label=runsett.scope=${orphanScope}`));
  await waitUntil(() => {
    try { docker('exec', id, 'test', '-e', '/tmp/runner-ready'); return true; }
    catch { return false; }
  });
  const info = JSON.parse(docker('inspect', id))[0];
  assert.equal(info.HostConfig.Memory, 268435456);
  assert.equal(info.HostConfig.PidsLimit, 64);
  assert.equal(info.HostConfig.NetworkMode, 'none');
  assert.equal(info.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(info.HostConfig.CapDrop, ['ALL']);
  assert.equal(info.Config.User, '1000:1000');
  assert.equal(info.Config.Labels['runsett.workflowId'], orphanScope);
  child.kill('SIGKILL');
  await new Promise<void>(resolve => child.once('exit', () => resolve()));
  const restarted = createCodeExecutor({ registry, scope: orphanScope });
  const existing = await restarted.reconcile();
  restarted.close();
  assert.ok(existing.some(record => record.containerId.startsWith(id) && record.outcome === 'unknown'));
  await waitUntil(() => docker('inspect', '-f', '{{.State.Running}}', id) === 'false', 12000);
  assert.ok(Date.now() <= Number(info.Config.Labels['runsett.expiresAt']) + 1500, 'watchdog bounds lifetime independently');
  const expired = await reconcileContainers(orphanScope, Number(info.Config.Labels['runsett.expiresAt']) + 1);
  assert.ok(expired.some(record => record.containerId.startsWith(id) && record.outcome === 'terminated-unknown'));
  assert.equal(docker('ps', '-aq', '--filter', `label=runsett.scope=${orphanScope}`), '');
});
test('periodic reconciliation removes expired created containers and reports unknown effects', async () => {
  const cleanupScope = `${scope}-periodic`;
  const id = docker('create', '--label', 'runsett.managed=true', '--label', `runsett.scope=${cleanupScope}`, '--label', `runsett.expiresAt=${Date.now() + 5000}`, '--label', `runsett.workflowId=${scope}`, '--label', 'runsett.runId=orphan', '--label', 'runsett.stepId=created', '--label', 'runsett.attempt=1', '--label', 'runsett.operationKey=op', '--label', 'runsett.deploymentId=v1', image);
  const records: { outcome: string }[] = [];
  const restarted = createCodeExecutor({ registry, scope: cleanupScope, reconciliationIntervalMs: 100, onReconciliation: items => { records.push(...items); } });
  try {
    assert.ok((await restarted.reconcile()).some(record => record.outcome === 'unknown'));
    await waitUntil(() => records.some(record => record.outcome === 'terminated-unknown'));
    assert.equal(docker('ps', '-aq', '--filter', `label=runsett.scope=${cleanupScope}`), '');
  } finally {
    restarted.close();
    try { docker('rm', '-f', id); } catch { /* Already reconciled. */ }
  }
});
