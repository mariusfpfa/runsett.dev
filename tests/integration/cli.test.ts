import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { execFileSync, spawn } from 'node:child_process';
import { readFile, mkdtemp, rm, rename } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Client, Connection } from '@temporalio/client';
import { bundleWorkflowCode } from '@temporalio/worker';
import { DeploymentRegistry } from '../../packages/runtime/src/versioning.js';
import { ReconciliationAudit } from '../../packages/runtime/src/audit.js';
import { createRunsettWorker } from '../../packages/runtime/src/worker.js';
import { operation, retryOperation } from '../../examples/javascript/blocks.js';
let connection: Connection; let client: Client; let directory: string; let deploymentId: string;
let worker: Awaited<ReturnType<typeof createRunsettWorker>>; let running: Promise<void>;
const schedules: string[] = [];
async function cli(args: string[], success = true) {
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveResult, reject) => {
    const child = spawn(process.execPath, ['node_modules/.bin/runsett', ...args, '--json'], { env: { ...process.env, RUNSETT_DEPLOYMENTS_DIR: join(directory, 'deployments'), RUNSETT_AUDIT_DIR: join(directory, 'audit') } });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
    child.on('error', reject); child.on('close', code => resolveResult({ code, stdout, stderr }));
  });
  assert.equal(result.code === 0, success, JSON.stringify(result));
  return JSON.parse(result.stdout);
}
async function run(type: string, input = '{}') {
  return cli(['run', '--id', `cli-${randomUUID()}`, '--deployment', deploymentId, '--workflow', type, '--input', input]);
}
before(async () => {
  // A missing real Compose service is a failure, never a skip or test-server fallback.
  connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233', connectTimeout: '5s' });
  client = new Client({ connection });
  await connection.workflowService.getSystemInfo({});
  directory = await mkdtemp(join(tmpdir(), 'runsett-cli-'));
  deploymentId = `cli-deployment-${randomUUID()}`;
  const image = execFileSync('docker', ['build', '-q', '-f', 'packages/runner/Dockerfile', '--build-arg', 'MODULE_BUNDLE=examples/javascript/modules', '.'], { encoding: 'utf8' }).trim();
  const workflowBundle = await bundleWorkflowCode({ workflowsPath: resolve('tests/fixtures/temporal/workflows.ts') });
  const dependencyHash = createHash('sha256').update(await readFile('package-lock.json')).digest('hex');
  const deployment = await new DeploymentRegistry(join(directory, 'deployments')).register({ deploymentId, version: '1', workflowTypes: ['oneStep', 'retryStep', 'waiting'], workflowBundle, dependencyHash, blocks: [operation, retryOperation], modules: [{ moduleId: operation.moduleId, moduleHash: operation.moduleHash, path: '/opt/runsett/modules/operation.mjs', image }] });
  worker = await createRunsettWorker({ deployment, auditDirectory: join(directory, 'audit'), address: process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233' });
  running = worker.run();
});
after(async () => {
  for (const id of schedules) await client.schedule.getHandle(id).delete().catch(() => undefined);
  worker?.shutdown(); await running; await worker?.close(); await connection?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});
test('CLI returns submission IDs, reads recorded results/logs, and defaults to payload references', async () => {
  const submitted = await run('oneStep', '{"value":12}');
  assert.ok(submitted.workflowId); assert.ok(submitted.runId);
  const handle = client.workflow.getHandle(submitted.workflowId, submitted.runId);
  await handle.result();
  const summary = await cli(['inspect', submitted.workflowId]);
  assert.equal(summary.state, 'COMPLETED'); assert.equal(summary.deployment.availability, 'available');
  assert.equal(summary.output, undefined); assert.equal(summary.steps[0].diagnostics, undefined);
  assert.equal(summary.steps[0].stepId, 'operation'); assert.deepEqual(summary.steps[0].observedAttempts, [1]);
  const detailed = await cli(['inspect', submitted.workflowId, '--details', '--logs']);
  assert.equal(detailed.output.value, 12); assert.equal(detailed.steps[0].output.value, 12);
  assert.match(detailed.steps[0].diagnostics[0].message, /operationKey/);
  assert.equal(detailed.history.truncated, false);
  assert.equal(detailed.steps[0].attemptHistory, 'incomplete');
  const bounded = await cli(['inspect', submitted.workflowId, '--logs', '--max-log-bytes', '1']);
  assert.equal(bounded.diagnostics.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(bounded.steps[0].diagnostics)) < 128);
  const short = await cli(['inspect', submitted.workflowId, '--max-events', '1']);
  assert.equal(short.state, 'COMPLETED'); assert.equal(short.history.truncated, true);
  assert.equal(short.outputAvailability, 'unavailable');
});
test('CLI retrieves recorded classified errors without fabricating retry attempts', async () => {
  const submitted = await run('retryStep', '{"failBefore":9}');
  await assert.rejects(client.workflow.getHandle(submitted.workflowId).result());
  const view = await cli(['inspect', submitted.workflowId, '--logs', '--details']);
  assert.equal(view.state, 'FAILED'); assert.equal(view.steps[0].error.code, 'RUNTIME_ERROR');
  assert.match(view.steps[0].error.message, /Deliberate/);
  assert.deepEqual(view.steps[0].observedAttempts, [3]);
  assert.equal(view.steps[0].attemptHistory, 'incomplete');
  assert.ok(view.steps[0].diagnostics.length);
  assert.equal(view.diagnostics.bytes, Buffer.byteLength(JSON.stringify(view.steps[0].diagnostics[0])), 'Repeated workflow failure must not consume the step diagnostic budget twice');
});
test('CLI cancellation is acknowledged separately from final engine state', async () => {
  const submitted = await run('waiting');
  const cancelled = await cli(['cancel', submitted.workflowId]);
  assert.equal(cancelled.cancellationRequested, true);
  await assert.rejects(client.workflow.getHandle(submitted.workflowId).result());
  assert.equal((await cli(['inspect', submitted.workflowId])).state, 'CANCELLED');
});
test('inspect works with missing deployment, never executes code, and surfaces unknown Docker evidence', async () => {
  const submitted = await run('oneStep');
  const handle = client.workflow.getHandle(submitted.workflowId); await handle.result();
  const beforeHistory = (await handle.fetchHistory()).events!.length;
  const deployments = join(directory, 'deployments'); await rename(deployments, `${deployments}-offline`);
  try {
    await new ReconciliationAudit(join(directory, 'audit')).acknowledge([{ containerId: 'evidence-only', identity: { workflowId: submitted.workflowId, runId: submitted.runId, stepId: 'uncertain', attempt: 1, operationKey: 'unknown-op', deploymentId }, expiresAt: Date.now(), outcome: 'terminated-unknown' }]);
    const view = await cli(['inspect', submitted.workflowId, '--details']);
    assert.equal(view.deployment.availability, 'missing'); assert.equal(view.state, 'COMPLETED');
    assert.equal(view.reconciliation.records[0].outcome, 'terminated-unknown');
    assert.equal(view.reconciliation.records[0].sideEffectOutcome, 'unknown');
    assert.equal((await handle.fetchHistory()).events!.length, beforeHistory);
    assert.doesNotMatch(JSON.stringify(view), /workflowBundle|function\(input|evidence-only/);
  } finally { await rename(`${deployments}-offline`, deployments); }
});
test('CLI JSON errors have nonzero exits for bad arguments, missing run/version, and duplicate schedules', async () => {
  for (const args of [['wat'], ['run'], ['inspect', 'missing-run'], ['inspect', 'id', '--max-events', '0'], ['run', '--id', 'id', '--deployment', 'missing', '--workflow', 'oneStep', '--input', '{}']]) {
    assert.ok((await cli(args, false)).error.code);
  }
});
test('real Temporal schedules use UTC, SKIP, one-hour catchup and recurring IDs with deployment memo', async () => {
  const id = `cli-schedule-${randomUUID()}`; schedules.push(id);
  const args = ['schedule', 'create', '--id', id, '--deployment', deploymentId, '--workflow', 'oneStep', '--cron', '0 0 * * *', '--input', '{}'];
  assert.equal((await cli(args)).scheduleId, id);
  const handle = client.schedule.getHandle(id); const description = await handle.describe();
  assert.equal(description.spec.timezone, 'UTC'); assert.equal(description.policies.overlap, 'SKIP');
  assert.equal(description.policies.catchupWindow, 3_600_000);
  assert.equal(description.action.memo!.runsettRequest && (description.action.memo!.runsettRequest as any).deploymentId, deploymentId);
  await cli(args, false);
  const ids: string[] = [];
  for (let i = 0; i < 2; i++) {
    await handle.trigger();
    const deadline = Date.now() + 10_000;
    let recent;
    do { recent = (await handle.describe()).info.recentActions; if (recent.length > i) break; assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 50)); } while (true);
    const execution = recent.at(-1)!.action.workflow; ids.push(execution.workflowId);
    assert.equal((await client.workflow.getHandle(execution.workflowId, execution.firstExecutionRunId).result()).attempt, 1);
    const view = await cli(['inspect', execution.workflowId]);
    assert.equal(view.deployment.deploymentId, deploymentId);
    assert.ok(view.schedule.intendedAt); assert.ok(view.schedule.actualStartedAt);
    // Temporal timestamps schedule workflow IDs to distinguish occurrences, including triggers.
    await new Promise(resolve => setTimeout(resolve, 1100));
  }
  assert.notEqual(ids[0], ids[1]);
  assert.equal((await cli(['schedule', 'pause', id])).paused, true);
  assert.equal((await handle.describe()).state.paused, true);
});
test('inspection reports unreadable audit observations without changing engine state', async () => {
  const submitted = await run('oneStep'); await client.workflow.getHandle(submitted.workflowId).result();
  const audit = join(directory, 'audit'); const saved = `${audit}-saved`;
  await rename(audit, saved);
  try {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(audit, 'not a directory');
    const view = await cli(['inspect', submitted.workflowId]);
    assert.equal(view.state, 'COMPLETED'); assert.equal(view.reconciliation.availability, 'unavailable');
    assert.deepEqual(view.reconciliation.records, []);
  } finally { await rm(audit, { force: true }); await rename(saved, audit); }
});
test('CLI failure output never echoes secret-looking input or unknown options', async () => {
  const secret = 'fixture-secret-do-not-echo';
  const result = await cli(['run', '--id', 'bad-input', '--deployment', deploymentId, '--workflow', 'oneStep', '--input', secret], false);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
  const unknown = await cli(['inspect', secret, `--${secret}`], false);
  assert.doesNotMatch(JSON.stringify(unknown), new RegExp(secret));
});
