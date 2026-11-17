import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createHarness, until, type Harness } from '../fixtures/worker-controller.js';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DeploymentRegistry, taskQueueFor } from '../../packages/runtime/src/versioning.js';
import { createRunClient, RunConflictError } from '../../packages/runtime/src/client.js';
import { inspectRun } from '../../packages/runtime/src/inspection.js';
import { canonicalJson, sha256 } from '../../packages/runtime/src/storage.js';
let h: Harness;
before(async () => { h = await createHarness('versioning', ['1', '2']); });
after(async () => { await h?.close(); });
test('same ID and version with changed content cannot resume an old sleeping run', { timeout: 90000 }, async t => {
  const originalDeployment = h.deployments[0]!;
  const replacementRegistry = new DeploymentRegistry(join(h.directory, 'replacement'));
  const { fingerprint: _fingerprint, ...definition } = originalDeployment;
  const replacement = await replacementRegistry.register({ ...definition, workflowBundle: h.deployments[1]!.workflowBundle });
  assert.notEqual(replacement.fingerprint, originalDeployment.fingerprint);
  const oldWorker = await h.worker(originalDeployment);
  const original = await h.start({ waitMs: 10000, second: true });
  await until(async () => (await h.inspect(original.workflowId)).wait?.reason === 'durable-timer', 'original content sleeps');
  await h.kill(oldWorker);
  const newWorker = await h.worker(replacement, replacementRegistry);
  t.after(async () => { if (newWorker.exitCode === null && newWorker.signalCode === null) await h.kill(newWorker); });
  const replacementClient = createRunClient({ client: h.client, deployments: replacementRegistry });
  const newer = await replacementClient.startRun({ workflowId: `changed-content-${randomUUID()}`, deploymentId: replacement.deploymentId, workflowType: 'recovery', input: { block: h.block as any, url: h.receiver.url, tag: 'changed-content' } });
  assert.equal((await h.client.workflow.getHandle(newer.workflowId).result()).version, '2');
  await until(async () => (await original.handle.fetchHistory()).events!.some(event => event.timerFiredEventAttributes), 'original timer fires', 20000);
  // Give the live replacement a positive task-completion gate after the old timer fires.
  const live = await replacementClient.startRun({ workflowId: `changed-content-live-${randomUUID()}`, deploymentId: replacement.deploymentId, workflowType: 'recovery', input: { block: h.block as any, url: h.receiver.url, tag: 'changed-content-live' } });
  assert.equal((await h.client.workflow.getHandle(live.workflowId).result()).version, '2');
  const waiting = await h.inspect(original.workflowId);
  assert.equal(waiting.state, 'RUNNING');
  assert.equal(waiting.wait?.reason, 'activity-or-workflow-task');
  assert.equal(waiting.steps.length, 1);
  assert.equal(h.receiver.attempts.filter(item => item.tag === `${original.workflowId}:second`).length, 0);
  const originalQueue = (await original.handle.describe()).taskQueue;
  const replacementQueue = (await h.client.workflow.getHandle(newer.workflowId).describe()).taskQueue;
  assert.equal(originalQueue, taskQueueFor(originalDeployment));
  assert.equal(replacementQueue, taskQueueFor(replacement));
  assert.notEqual(originalQueue, replacementQueue);
  await h.evidence('same-names-content-isolated', { originalFingerprint: originalDeployment.fingerprint, replacementFingerprint: replacement.fingerprint, originalQueue, replacementQueue, waiting });
  const restored = await h.worker(originalDeployment);
  assert.equal((await original.handle.result()).version, '1');
  assert.equal(h.receiver.attempts.filter(item => item.tag === `${original.workflowId}:first`).length, 1);
  await h.evidence('same-names-original-restored', { workflowId: original.workflowId, selectedVersion: '1' });
  await h.kill(restored); await h.kill(newWorker);
});
test('same-ID submission conflicts and inspection detects replacement content from another registry', async t => {
  const deployment = h.deployments[0]!;
  const replacementRegistry = new DeploymentRegistry(join(h.directory, 'identity-replacement'));
  const { fingerprint: _fingerprint, ...definition } = deployment;
  await replacementRegistry.register({ ...definition, dependencyHash: 'b'.repeat(64) });
  const request = { workflowId: `content-identity-${randomUUID()}`, deploymentId: deployment.deploymentId, workflowType: 'recovery', input: {} };
  const accepted = await h.runs.startRun(request);
  try {
    assert.deepEqual(await h.runs.startRun(request), accepted);
    await t.test('changed content conflicts', async () => {
      await assert.rejects(createRunClient({ client: h.client, deployments: replacementRegistry }).startRun(request), RunConflictError);
    });
    await t.test('inspection detects mismatched artifacts', async () => {
      const view = await inspectRun({ client: h.client, deployments: replacementRegistry, auditDirectory: join(h.directory, 'audit') }, request.workflowId);
      assert.equal(view.deployment.availability, 'mismatch');
      assert.equal(view.deployment.fingerprint, deployment.fingerprint);
    });
    await t.test('manual metadata retains full deployment fingerprint', async () => {
      const memo = (await h.client.workflow.getHandle(request.workflowId).describe()).memo!.runsettRequest as any;
      assert.equal(memo.deploymentFingerprint, deployment.fingerprint);
    });
  } finally { await h.client.workflow.getHandle(request.workflowId).terminate('test cleanup').catch(() => undefined); }
});
test('legacy and incomplete deployment metadata stay visibly unsupported and cannot be rebound', async t => {
  const deployment = h.deployments[0]!;
  const identity = { version: 1, deploymentId: deployment.deploymentId, workflowType: 'recovery', input: {} };
  for (const memo of [undefined, { version: 1, deploymentId: deployment.deploymentId, workflowType: 'recovery', fingerprint: sha256(canonicalJson(identity)) }, { version: 2, deploymentId: deployment.deploymentId, workflowType: 'recovery', fingerprint: 'a'.repeat(64) }]) {
    await t.test(`metadata version ${memo?.version ?? 'absent'}`, async () => {
      const workflowId = `legacy-identity-${randomUUID()}`;
      const handle = await h.client.workflow.start('recovery', { workflowId, taskQueue: `legacy-unused-${randomUUID()}`, args: [{}], memo: { runsettRequest: memo ?? null } });
      try {
        await assert.rejects(h.runs.startRun({ workflowId, deploymentId: deployment.deploymentId, workflowType: 'recovery', input: {} }), RunConflictError);
        const view = await h.inspect(workflowId);
        assert.equal(view.deployment.availability, 'unsupported');
      } finally { await handle.terminate('test cleanup'); }
    });
  }
});
test('live v2 handles new runs while absent v1 waits visibly and resumes original immutable code', { timeout: 90000 }, async () => {
  const v1 = await h.worker(h.deployments[0]);
  const original = await h.start({ waitMs: 30000, second: true });
  await until(async () => (await h.inspect(original.workflowId)).wait?.reason === 'durable-timer', 'v1 durable timer');
  const v2 = await h.worker(h.deployments[1]);
  const newer = await h.start({}, h.deployments[1]);
  assert.equal((await h.inspect(original.workflowId)).wait?.reason, 'durable-timer', 'old worker must still be sleeping at the kill boundary');
  await h.kill(v1); const killedAt = Date.now();
  assert.equal((await newer.handle.result()).version, '2');
  await until(async () => (await original.handle.fetchHistory()).events!.some(event => event.timerFiredEventAttributes), 'Temporal fires v1 timer without v1 process', 45000);
  // A second v2 result provides a positive live-worker gate while v1's task is pending.
  const stillLive = await h.start({}, h.deployments[1]); assert.equal((await stillLive.handle.result()).version, '2');
  const waiting = await h.inspect(original.workflowId);
  assert.equal(waiting.state, 'RUNNING'); assert.equal(waiting.deployment.version, '1');
  assert.equal(waiting.wait?.reason, 'activity-or-workflow-task');
  assert.equal(waiting.steps.length, 1); assert.equal(waiting.steps[0]?.state, 'COMPLETED');
  assert.equal(h.receiver.attempts.filter(item => item.tag === `${original.workflowId}:second`).length, 0);
  assert.notEqual((await original.handle.describe()).taskQueue, (await newer.handle.describe()).taskQueue);
  await h.evidence('old-worker-absent', { workflowId: original.workflowId, knownKilledPid: v1.pid, liveV2Pid: v2.pid, waiting, observation: 'Controlled old process absent; no permanent poller absence inferred' });
  const restored = await h.worker(await h.registry.read(h.deployments[0]!.deploymentId));
  const result = await original.handle.result(); assert.equal(result.version, '1');
  assert.equal(h.receiver.attempts.filter(item => item.tag === `${original.workflowId}:first`).length, 1);
  await h.evidence('original-code-restored', { workflowId: original.workflowId, recoveryMs: Date.now() - killedAt, selectedVersion: result.version, liveNewVersion: '2' });
  await h.kill(restored); await h.kill(v2);
});
