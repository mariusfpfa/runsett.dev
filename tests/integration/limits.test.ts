import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createHarness, until, type Harness } from '../fixtures/worker-controller.js';
let h: Harness;
before(async () => { h = await createHarness('limits'); await h.worker(); });
after(async () => { await h?.close(); });

test('lost submission response retried with the same ID executes only one external operation', { timeout: 45000 }, async () => {
  const workflowId = `lost-response-${crypto.randomUUID()}`;
  const request = { workflowId, deploymentId: h.deployments[0]!.deploymentId, workflowType: 'recovery', input: JSON.parse(JSON.stringify({ block: h.block, url: h.receiver.url, tag: workflowId })) };
  // Real accepted request; deliberately discard its response to model the uncertain client.
  await h.runs.startRun(request);
  const retried = await h.runs.startRun(request);
  const result = await h.client.workflow.getHandle(retried.workflowId, retried.runId).result();
  assert.equal(result.first.attempt, 1);
  assert.equal(h.receiver.attempts.filter(item => item.tag === `${workflowId}:first`).length, 1);
  assert.equal((await h.client.workflow.getHandle(workflowId).fetchHistory()).events!.filter(event => event.workflowExecutionStartedEventAttributes).length, 1);
  await h.evidence('lost-submission-response', { retried, receipts: h.receiver.attempts.filter(item => item.tag === `${workflowId}:first`) });
});

test('cancellation racing explicit retries reaches terminal cancellation and launches no later attempts', { timeout: 45000 }, async () => {
  const run = await h.start({ fail: 3, holdAttempt: 2 });
  await until(() => h.receiver.attempts.some(item => item.tag.startsWith(run.workflowId) && item.attempt === 2) && h.receiver.held === 1, 'explicit retry attempt 2 accepted and response held');
  await h.runs.cancelRun(run.workflowId);
  await assert.rejects(run.handle.result());
  const view = await h.inspect(run.workflowId); assert.equal(view.state, 'CANCELLED');
  const receipts = h.receiver.attempts.filter(item => item.tag.startsWith(run.workflowId));
  assert.deepEqual(receipts.map(item => item.attempt), [1, 2]);
  assert.deepEqual(receipts.map(item => item.duplicate), [false, true]);
  assert.equal([...h.receiver.operations.values()].filter(item => item.tag.startsWith(run.workflowId)).length, 1);
  await h.evidence('retry-cancel-race', { workflowId: run.workflowId, receipts, state: view.state });
});

test('bounded fanout saturates at two outstanding external requests and progresses after release', { timeout: 60000 }, async () => {
  const run = await h.start({ items: [1, 2, 3, 4, 5], concurrency: 2 }, undefined, 'fanout');
  await until(() => h.receiver.held === 2, 'two external requests held');
  const initial = await h.inspect(run.workflowId); assert.equal(initial.steps.length, 2);
  assert.equal(h.receiver.attempts.filter(item => item.tag.startsWith(run.workflowId)).length, 2);
  h.receiver.release();
  await until(() => h.receiver.held === 2, 'next two external requests held'); h.receiver.release();
  await until(() => h.receiver.held === 1, 'last request held'); h.receiver.release();
  const result = await run.handle.result(); assert.equal(result.length, 5);
  assert.equal(h.receiver.peakHeld, 2);
  assert.equal(h.receiver.attempts.filter(item => item.tag.startsWith(run.workflowId)).length, 5);
  await h.evidence('fanout-saturation', { workflowId: run.workflowId, peakOutstandingRequests: h.receiver.peakHeld, itemCount: result.length });
});

test('runner log and result overflows are recorded as terminal OUTPUT_LIMIT despite opt-in retries', { timeout: 60000 }, async () => {
  for (const mode of ['overflow', 'flood']) {
    const run = await h.start({ mode }); await assert.rejects(run.handle.result());
    const view = await h.inspect(run.workflowId);
    assert.equal(view.state, 'FAILED'); assert.equal(view.steps[0]?.error?.code, 'OUTPUT_LIMIT');
    assert.deepEqual(view.steps[0]?.observedAttempts, [1]);
    await h.evidence('overflow', { mode, workflowId: run.workflowId, state: view.state, steps: view.steps });
  }
});

test('replacement reconciliation durably records then removes an expired container', { timeout: 30000 }, async () => {
  const { ReconciliationAudit } = await import('../../packages/runtime/src/audit.js');
  const { inspectAudit } = await import('../../packages/runtime/src/inspection-audit.js');
  const { reconcileContainers } = await import('../../packages/runner/src/container.js');
  const { docker } = await import('../fixtures/worker-controller.js');
  const scope = `expired-${crypto.randomUUID()}`; const workflowId = scope;
  const image = h.deployments[0]!.modules[0]!.image;
  const id = docker('create', '--label', 'runsett.managed=true', '--label', `runsett.scope=${scope}`, '--label', 'runsett.expiresAt=1', '--label', `runsett.workflowId=${workflowId}`, '--label', 'runsett.runId=expired-run', '--label', 'runsett.stepId=uncertain', '--label', 'runsett.attempt=1', '--label', 'runsett.operationKey=expired-operation', '--label', `runsett.deploymentId=${h.deployments[0]!.deploymentId}`, image);
  try {
    const records = await reconcileContainers(scope, Date.now(), { acknowledge: new ReconciliationAudit(`${h.directory}/audit`).acknowledge });
    assert.equal(records.length, 1); assert.equal(records[0]?.outcome, 'terminated-unknown');
    assert.equal(docker('ps', '-aq', '--filter', `label=runsett.scope=${scope}`), '');
    const durable = await inspectAudit(`${h.directory}/audit`, workflowId, 'expired-run');
    assert.equal(durable.records.length, 1); assert.equal(durable.records[0]?.sideEffectOutcome, 'unknown');
    await h.evidence('expired-container-cleanup', { containerId: id, records, durable });
  } finally { try { docker('rm', '-f', id); } catch { /* removed after durable acknowledgement */ } }
});
