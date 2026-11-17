import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Connection, Client } from '@temporalio/client';
import { bundleWorkflowCode } from '@temporalio/worker';
import { defaultPayloadConverter } from '@temporalio/common';
import { DeploymentRegistry } from '../../packages/runtime/src/versioning.js';
import { createRunClient } from '../../packages/runtime/src/client.js';
import { createRunsettWorker } from '../../packages/runtime/src/worker.js';
import { defineBlock } from '../../packages/sdk/src/block.js';
let connection: Connection; let temporal: Client; let registry: DeploymentRegistry; let runs: ReturnType<typeof createRunClient>; let path: string;
const workers: Awaited<ReturnType<typeof createRunsettWorker>>[] = [];
const running: Promise<void>[] = [];
let deploymentId: string;
before(async () => {
  // Deliberately fails if real local Temporal is not running; no test-server fallback or skip.
  connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233', connectTimeout: '5s' });
  temporal = new Client({ connection });
  await connection.workflowService.getSystemInfo({});
  path = await mkdtemp(join(tmpdir(), 'runsett-temporal-'));
  registry = new DeploymentRegistry(join(path, 'deployments'));
  const image = execFileSync('docker', ['build', '-q', '-f', 'packages/runner/Dockerfile', '--build-arg', 'MODULE_BUNDLE=examples/javascript/modules', '.'], { encoding: 'utf8' }).trim();
  const moduleHash = createHash('sha256').update(await readFile('examples/javascript/modules/operation.mjs')).digest('hex');
  const dependencyHash = createHash('sha256').update(await readFile('package-lock.json')).digest('hex');
  for (const version of ['1', '2']) {
    const workflowBundle = await bundleWorkflowCode({ workflowsPath: resolve(`tests/fixtures/temporal/workflows${version === '2' ? '-v2' : ''}.ts`) });
    const id = `integration-${randomUUID()}-v${version}`;
    if (version === '1') deploymentId = id;
    const blocks = [1, 3].map(maximumAttempts => defineBlock({ name: 'operation', version: '1', moduleId: 'operation', moduleHash, inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, effect: 'write', maximumAttempts, credentialBindings: [], networkMode: 'none' }));
    const deployment = await registry.register({ deploymentId: id, version, workflowTypes: ['oneStep', 'retryStep', 'example', 'waiting', 'invalidIteration'], workflowBundle, dependencyHash, blocks, modules: [{ moduleId: 'operation', moduleHash, path: '/opt/runsett/modules/operation.mjs', image }] });
    const worker = await createRunsettWorker({ deployment, auditDirectory: join(path, 'audit'), address: process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233' });
    workers.push(worker); running.push(worker.run());
  }
  runs = createRunClient({ client: temporal, deployments: registry });
});
after(async () => {
  workers.forEach(worker => worker.shutdown());
  await Promise.all(running);
  for (const worker of workers) await worker.close();
  await connection?.close();
  if (path) await rm(path, { recursive: true, force: true });
});
async function start(workflowType: string, input: any = {}) {
  return await runs.startRun({ workflowId: `test-${randomUUID()}`, deploymentId, workflowType, input });
}
test('real Temporal executes one recorded sandboxed step with default one attempt', async () => {
  const run = await start('oneStep');
  const output = await temporal.workflow.getHandle(run.workflowId, run.runId).result();
  assert.equal(output.attempt, 1);
  assert.ok(output.operationKey);
  const completed = (await temporal.workflow.getHandle(run.workflowId, run.runId).fetchHistory()).events!.find(event => event.activityTaskCompletedEventAttributes)!;
  const recorded = defaultPayloadConverter.fromPayload(completed.activityTaskCompletedEventAttributes!.result!.payloads![0]!) as any;
  assert.ok(recorded.diagnostics?.length, 'Success diagnostics must be recorded in activity history');
  assert.deepEqual(recorded.output, output);
  const history = await temporal.workflow.getHandle(run.workflowId, run.runId).fetchHistory();
  const scheduled = history.events!.filter(event => event.activityTaskScheduledEventAttributes);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0]!.activityTaskScheduledEventAttributes!.retryPolicy!.maximumAttempts, 1);
});
test('explicit retry keeps stable operation key and default does not retry failures', async () => {
  const run = await start('retryStep', { failBefore: 3 });
  const output = await temporal.workflow.getHandle(run.workflowId, run.runId).result();
  assert.equal(output.attempt, 3);
  assert.equal(output.operationKey, createHash('sha256').update(JSON.stringify(['runsett-operation-v1', run.workflowId, run.runId, deploymentId, 'operation'])).digest('hex'));
  const history = await temporal.workflow.getHandle(run.workflowId, run.runId).fetchHistory();
  assert.equal(history.events!.filter(event => event.activityTaskScheduledEventAttributes).length, 1);
  const failed = await start('oneStep', { failBefore: 3 });
  await assert.rejects(temporal.workflow.getHandle(failed.workflowId, failed.runId).result());
  const failedHistory = await temporal.workflow.getHandle(failed.workflowId, failed.runId).fetchHistory();
  const event = failedHistory.events!.find(event => event.activityTaskFailedEventAttributes);
  assert.equal(event!.activityTaskFailedEventAttributes!.failure!.applicationFailureInfo!.details!.payloads!.length, 1);
});
test('atomic same-ID submission returns original run and rejects changed input/deployment/type', async () => {
  const request = { workflowId: `dedup-${randomUUID()}`, deploymentId, workflowType: 'oneStep', input: { b: 2, a: 1 } };
  const results = await Promise.all([runs.startRun(request), runs.startRun({ ...request, input: { a: 1, b: 2 } })]);
  assert.deepEqual(results[0], results[1]);
  await temporal.workflow.getHandle(results[0]!.workflowId, results[0]!.runId).result();
  assert.deepEqual(await runs.startRun(request), results[0]);
  const deployments = await registry.list();
  for (const changed of [{ input: { a: 2 } }, { deploymentId: deployments.find(item => item.deploymentId !== deploymentId)!.deploymentId }, { workflowType: 'retryStep' }]) {
    await assert.rejects(runs.startRun({ ...request, ...changed }), /conflict/i);
  }
  await assert.rejects(runs.startRun({ ...request, workflowId: 'invalid-type', workflowType: 'missing' }), /workflow type/i);
});
test('workflow records durable timer, bounded items and a second step; version queues coexist', async () => {
  const run = await start('example', { items: [1, 2, 3], waitMs: 100 });
  const result = await temporal.workflow.getHandle(run.workflowId, run.runId).result();
  assert.equal(result.version, '1');
  assert.deepEqual(result.items.map((item: any) => item.value), [1, 2, 3]);
  const history = await temporal.workflow.getHandle(run.workflowId, run.runId).fetchHistory();
  assert.ok(history.events!.some(event => event.timerStartedEventAttributes));
  const otherDeployment = (await registry.list()).find(item => item.deploymentId !== deploymentId)!;
  const other = await runs.startRun({ workflowId: `v2-${randomUUID()}`, deploymentId: otherDeployment.deploymentId, workflowType: 'example', input: { items: [4], waitMs: 10 } });
  const info = await temporal.workflow.getHandle(other.workflowId, other.runId).describe();
  const originalInfo = await temporal.workflow.getHandle(run.workflowId, run.runId).describe();
  assert.notEqual(info.taskQueue, originalInfo.taskQueue);
  assert.equal((await temporal.workflow.getHandle(other.workflowId, other.runId).result()).version, '2');
});
test('cancelRun cancels an engine-owned durable wait', async () => {
  const run = await start('waiting');
  const handle = temporal.workflow.getHandle(run.workflowId, run.runId);
  const deadline = Date.now() + 10_000;
  while (!(await handle.fetchHistory()).events!.some(event => event.timerStartedEventAttributes)) {
    assert.ok(Date.now() < deadline, 'durable timer was not scheduled');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  await runs.cancelRun(run.workflowId);
  await assert.rejects(temporal.workflow.getHandle(run.workflowId, run.runId).result());
});

test('invalid workflow iteration fails the run before dispatch rather than retrying workflow tasks', async () => {
  const run = await start('invalidIteration');
  const handle = temporal.workflow.getHandle(run.workflowId, run.runId);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await assert.rejects(Promise.race([handle.result(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Workflow did not fail promptly')), 5000); })]), error => {
      assert.doesNotMatch(String(error), /did not fail promptly/);
      return true;
    });
    assert.equal((await handle.fetchHistory()).events!.filter(event => event.activityTaskScheduledEventAttributes).length, 0);
  } finally { if (timer) clearTimeout(timer); await handle.cancel().catch(() => undefined); }
});
test('startRun snapshots request input before asynchronous registry/network work', async () => {
  const request = { workflowId: `snapshot-${randomUUID()}`, deploymentId, workflowType: 'oneStep', input: { value: 1 } };
  const pending = runs.startRun(request);
  request.input.value = 99;
  const run = await pending;
  assert.equal((await temporal.workflow.getHandle(run.workflowId, run.runId).result()).value, 1);
  assert.deepEqual(await runs.startRun({ ...request, input: { value: 1 } }), run);
});
