import assert from 'node:assert/strict';
import { spawn, execFile, execFileSync, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, appendFile, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir, networkInterfaces } from 'node:os';
import { join, resolve } from 'node:path';
import { Client, Connection } from '@temporalio/client';
import { bundleWorkflowCode } from '@temporalio/worker';
import { DeploymentRegistry, taskQueueFor, type RegisteredDeployment } from '../../packages/runtime/src/versioning.js';
import { createRunClient } from '../../packages/runtime/src/client.js';
import { inspectRun } from '../../packages/runtime/src/inspection.js';
import { reconcileContainers } from '../../packages/runner/src/container.js';
import { defineBlock } from '../../packages/sdk/src/block.js';
import { createReceiver } from './receiver.js';
export async function until<T>(observe: () => T | Promise<T>, message: string, timeoutMs = 20000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const value = await observe(); if (value) return value as NonNullable<T>; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error(`Timed out: ${message}`);
}
export const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: 'pipe' }).trim();
export async function createHarness(suite: string, versions = ['1']) {
  // No fallback/skip: missing Docker, Postgres-backed Temporal or health fails setup.
  docker('info');
  const serviceOutput = docker('compose', '-f', 'deploy/compose.yaml', 'ps', '--format', 'json');
  const services = (serviceOutput.startsWith('[') ? JSON.parse(serviceOutput) : serviceOutput.split('\n').filter(Boolean).map(line => JSON.parse(line))) as any[];
  for (const name of ['postgres', 'temporal']) assert.ok(services.some(service => service.Service === name && service.Health === 'healthy'), `${name} Compose service must be healthy`);
  const connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233', connectTimeout: '5s' });
  await connection.workflowService.getSystemInfo({});
  const client = new Client({ connection });
  const directory = await mkdtemp(join(tmpdir(), `runsett-${suite}-`));
  let cleanupReceiver: Awaited<ReturnType<typeof createReceiver>> | undefined;
  try {
    const evidenceDirectory = resolve(process.env.RUNSETT_EVIDENCE_DIR ?? '.superpowers/sdd/durable-javascript/task-5-evidence');
    await mkdir(evidenceDirectory, { recursive: true });
    const registry = new DeploymentRegistry(join(directory, 'deployments'));
    const gateway = docker('network', 'inspect', 'bridge', '--format', '{{(index .IPAM.Config 0).Gateway}}');
    const image = docker('build', '-q', '-f', 'packages/runner/Dockerfile', '--build-arg', 'MODULE_BUNDLE=tests/fixtures/recovery', '.');
    const receiver = await createReceiver(gateway); cleanupReceiver = receiver;
    // Managed workspaces may expose a daemon in another network namespace. Probe
    // from the exact runner image instead of assuming its gateway is our host.
    const candidates = process.env.RUNSETT_RECEIVER_HOST ? [process.env.RUNSETT_RECEIVER_HOST] : [gateway, ...Object.values(networkInterfaces()).flatMap(items => (items ?? []).filter(item => !item.internal && item.family === 'IPv4').map(item => item.address))];
    const reachableHost = (await promisify(execFile)('docker', ['run', '--rm', '--network', 'bridge', '--entrypoint', 'node', image, '-e', `for (const host of ${JSON.stringify(candidates)}) { try { const response = await fetch('http://' + host + ':${receiver.port}/health/${receiver.healthToken}', { signal: AbortSignal.timeout(1500) }); if (await response.text() === '${receiver.healthToken}') { console.log(host); process.exit(0); } } catch {} } process.exit(1);`])).stdout.trim();
    receiver.url = `http://${reachableHost}:${receiver.port}`;
    const moduleHash = createHash('sha256').update(await readFile('tests/fixtures/recovery/operation.mjs')).digest('hex');
    const dependencyHash = createHash('sha256').update(await readFile('package-lock.json')).digest('hex');
    const block = defineBlock({ name: 'recovery', version: '1', moduleId: 'operation', moduleHash, inputSchema: { type: 'object' }, outputSchema: {}, effect: 'write', maximumAttempts: 3, credentialBindings: [], networkMode: 'configured' });
    const deployments: RegisteredDeployment[] = [];
    for (const version of versions) {
      const workflowBundle = await bundleWorkflowCode({ workflowsPath: resolve(`tests/fixtures/recovery/workflows${version === '2' ? '-v2' : ''}.ts`) });
      deployments.push(await registry.register({ deploymentId: `${suite}-${randomUUID()}-v${version}`, version, workflowTypes: version === '1' ? ['recovery', 'fanout'] : ['recovery'], workflowBundle, dependencyHash, blocks: [block], modules: [{ moduleId: 'operation', moduleHash, path: '/opt/runsett/modules/operation.mjs', image }], configuredNetwork: 'bridge' }));
    }
    const runs = createRunClient({ client, deployments: registry });
    const processes = new Set<ChildProcess>(); const activeRuns: string[] = [];
    async function evidence(name: string, data: object) { await appendFile(join(evidenceDirectory, `${suite}.jsonl`), JSON.stringify({ name, observedAt: new Date().toISOString(), ...data }) + '\n'); }
    async function worker(deployment = deployments[0]!) {
      const child = spawn(process.execPath, ['packages/runtime/dist/entrypoint.js'], { env: { ...process.env, RUNSETT_DEPLOYMENT_ID: deployment.deploymentId, RUNSETT_DEPLOYMENTS_DIR: registry.directory, RUNSETT_AUDIT_DIR: join(directory, 'audit') }, stdio: ['ignore', 'pipe', 'pipe'] });
      processes.add(child); let output = '';
      const log = createWriteStream(join(evidenceDirectory, `${suite}-worker-${child.pid}.log`));
      child.stdout!.on('data', chunk => { output = (output + chunk).slice(-65536); log.write(chunk); });
      child.stderr!.on('data', chunk => { output = (output + chunk).slice(-65536); log.write(chunk); });
      child.once('close', () => { processes.delete(child); log.end(); });
      await until(() => { if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Worker exited before ready: ${output}`); return /RUNNING/.test(output); }, 'worker RUNNING log');
      await evidence('worker-ready', { pid: child.pid, deploymentId: deployment.deploymentId, version: deployment.version, queue: taskQueueFor(deployment) });
      return child;
    }
    async function kill(child: ChildProcess) {
      assert.equal(child.exitCode, null); const exited = new Promise<void>(resolve => child.once('exit', (_code, signal) => { assert.equal(signal, 'SIGKILL'); resolve(); }));
      child.kill('SIGKILL'); await exited; await evidence('worker-killed', { pid: child.pid });
    }
    async function start(input: Record<string, any> = {}, deployment = deployments[0]!, workflowType = 'recovery') {
      const workflowId = `${suite}-${randomUUID()}`; activeRuns.push(workflowId);
      const run = await runs.startRun({ workflowId, deploymentId: deployment.deploymentId, workflowType, input: JSON.parse(JSON.stringify({ block, url: receiver.url, tag: workflowId, ...input })) });
      const handle = client.workflow.getHandle(run.workflowId, run.runId);
      await evidence('run-started', { ...run, deploymentId: deployment.deploymentId, version: deployment.version });
      return { ...run, handle };
    }
    async function inspect(workflowId: string) { return inspectRun({ client, deployments: registry, auditDirectory: join(directory, 'audit') }, workflowId, { details: true }); }
    async function close() {
      receiver.release();
      for (const id of activeRuns) await client.workflow.getHandle(id).cancel().catch(() => undefined);
      for (const child of [...processes]) { child.kill('SIGKILL'); await new Promise<void>(resolve => child.once('close', () => resolve())); }
      for (const deployment of deployments) await reconcileContainers(taskQueueFor(deployment), Date.now() + 60000, { acknowledge: records => evidence('cleanup', { records }) });
      await evidence('receiver-final', { attempts: receiver.attempts, operations: [...receiver.operations.values()] });
      await receiver.close(); await connection.close(); await rm(directory, { recursive: true, force: true });
    }
    return { client, registry, deployments, runs, directory, receiver, block, worker, kill, start, inspect, evidence, close };
  } catch (error) {
    await cleanupReceiver?.close(); await connection.close(); await rm(directory, { recursive: true, force: true }); throw error;
  }
}
export type Harness = Awaited<ReturnType<typeof createHarness>>;
