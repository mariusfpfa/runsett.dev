import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createHarness, until, type Harness } from '../fixtures/worker-controller.js';
let h: Harness;
before(async () => { h = await createHarness('recovery'); });
after(async () => { await h?.close(); });
const timerStarted = async (run: any) => (await run.handle.fetchHistory()).events?.some((event: any) => event.timerStartedEventAttributes);

test('SIGKILL before a step resumes a recorded durable timer on a replacement process', { timeout: 45000 }, async () => {
  const first = await h.worker(); const run = await h.start({ beforeMs: 5000 });
  await until(() => timerStarted(run), 'before-step timer recorded');
  const boundary = await h.inspect(run.workflowId);
  assert.equal(boundary.steps.length, 0); assert.equal(boundary.wait?.reason, 'durable-timer');
  assert.equal(h.receiver.attempts.filter(item => item.tag.startsWith(run.workflowId)).length, 0);
  await h.kill(first); const killedAt = Date.now();
  const replacement = await h.worker(); const result = await run.handle.result();
  assert.equal(result.version, '1'); assert.equal(result.first.attempt, 1);
  assert.equal(h.receiver.attempts.filter(item => item.tag === `${run.workflowId}:first`).length, 1);
  await h.evidence('before-step-recovery', { workflowId: run.workflowId, recoveryMs: Date.now() - killedAt, selectedVersion: result.version });
  await h.kill(replacement);
});

test('completed step remains checkpointed across SIGKILL during durable sleep', { timeout: 45000 }, async () => {
  const first = await h.worker(); const run = await h.start({ waitMs: 2500, second: true });
  await until(() => timerStarted(run), 'post-step durable timer recorded');
  const checkpoint = await h.inspect(run.workflowId);
  assert.equal(checkpoint.steps[0]?.state, 'COMPLETED'); assert.equal(checkpoint.wait?.reason, 'durable-timer');
  await h.kill(first); const killedAt = Date.now();
  const replacement = await h.worker(); const result = await run.handle.result();
  assert.equal(result.first.attempt, 1);
  const receipts = h.receiver.attempts.filter(item => item.tag.startsWith(run.workflowId));
  assert.deepEqual(receipts.map(item => item.tag), [`${run.workflowId}:first`, `${run.workflowId}:second`]);
  const view = await h.inspect(run.workflowId); assert.deepEqual(view.steps.map(step => step.state), ['COMPLETED', 'COMPLETED']);
  await h.evidence('checkpoint-and-timer-recovery', { workflowId: run.workflowId, recoveryMs: Date.now() - killedAt, selectedVersion: result.version, receipts, steps: view.steps });
  await h.kill(replacement);
});

test('receiver accepts before checkpoint; replacement retry deduplicates the actual external operation', { timeout: 60000 }, async () => {
  const first = await h.worker(); const run = await h.start({ hold: true });
  await until(() => h.receiver.attempts.find(item => item.tag === `${run.workflowId}:first`), 'receiver committed external operation and withheld response');
  const before = await h.inspect(run.workflowId);
  assert.equal(before.steps.length, 1); assert.equal(before.steps[0]?.outputRef, undefined);
  assert.equal((await run.handle.fetchHistory()).events!.filter(event => event.activityTaskCompletedEventAttributes).length, 0);
  await h.kill(first); const killedAt = Date.now();
  h.receiver.release();
  const replacement = await h.worker(); const result = await run.handle.result();
  const receipts = h.receiver.attempts.filter(item => item.tag === `${run.workflowId}:first`);
  assert.deepEqual(receipts.map(item => item.attempt), [1, 2]);
  assert.deepEqual(receipts.map(item => item.duplicate), [false, true]);
  assert.equal(new Set(receipts.map(item => item.key)).size, 1);
  assert.equal([...h.receiver.operations.values()].filter(item => item.tag === `${run.workflowId}:first`).length, 1);
  assert.equal(result.first.attempt, 2); assert.equal(result.first.duplicate, true);
  const view = await h.inspect(run.workflowId); assert.equal(view.steps[0]?.state, 'COMPLETED');
  assert.ok(view.reconciliation.records.some(record => record.sideEffectOutcome === 'unknown'));
  await h.evidence('accepted-before-checkpoint-recovery', { workflowId: run.workflowId, recoveryMs: Date.now() - killedAt, checkpointBeforeKill: before.steps, receipts, output: result, reconciliation: view.reconciliation });
  await h.kill(replacement);
});
