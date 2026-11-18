import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { assertJsonValue, DEFAULT_EXECUTION_LIMITS, type JsonValue } from '@runsett/contracts';
import type { CredentialSource } from '@runsett/runner';
import { Client, Connection, WorkflowNotFoundError } from '@temporalio/client';
import { bundleWorkflowCode } from '@temporalio/worker';
import {
  createRunClient,
  createRunsettWorker,
  DeploymentRegistry,
  inspectRun,
  type RegisteredDeployment,
} from '@runsett/runtime';
import { connectorBinding, visualBlock } from './block.js';
import { isConnectorKind } from './connector-settings.js';
import type { StudioConnections } from './connections.js';
import { pinSources, prepareStudioDeployment, testJavaScript, testModule } from './javascript.js';
import {
  assertTestInput,
  RequestError,
  validateForRun,
  validateOperationTest,
  validateStepTest,
  triggerName,
  type AutomaticTrigger,
  type RecordedRunRef,
  type RecordedStepOutput,
  type RunInput,
} from './model.js';
import type { StudioStore } from './store.js';

const exec = promisify(execFile);
export const root = fileURLToPath(new URL('../../../', import.meta.url));
export const namespace = process.env.TEMPORAL_NAMESPACE ?? 'default';
const address = process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233';
const deployments = new DeploymentRegistry(
  process.env.RUNSETT_DEPLOYMENTS_DIR ?? join(root, '.runsett/deployments'),
);
const auditDirectory = process.env.RUNSETT_AUDIT_DIR ?? join(root, '.runsett/audit');
const connectorNetwork = process.env.RUNSETT_STUDIO_NETWORK ?? 'bridge';
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

function runPlan(
  input: RunInput,
  deployment: RegisteredDeployment,
  pinnedSteps = pinSources(input.steps).steps,
) {
  const connector = deployment.modules.find((module) => module.moduleId === 'studio-connector');
  return {
    ...input,
    steps: pinnedSteps,
    moduleHash: deployment.modules[0]!.moduleHash,
    ...(connector && input.steps.some((step) => isConnectorKind(step.kind))
      ? { connectorHash: connector.moduleHash }
      : {}),
  };
}

async function prepareDeployment() {
  const moduleHash = hash(await readFile(join(root, 'packages/studio/modules/operation.mjs')));
  const connectorHash = hash(await readFile(join(root, 'packages/studio/modules/connector.mjs')));
  const dependencyHash = hash(await readFile(join(root, 'package-lock.json')));
  const [{ stdout }, bundle] = await Promise.all([
    exec(
      'docker',
      [
        'build',
        '-q',
        '-f',
        'packages/runner/Dockerfile',
        '--build-arg',
        'MODULE_BUNDLE=packages/studio/modules',
        '.',
      ],
      {
        cwd: root,
        env: { ...process.env, DOCKER_BUILDKIT: '1' },
        timeout: 600_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    ),
    bundleWorkflowCode({ workflowsPath: fileURLToPath(new URL('./workflow.js', import.meta.url)) }),
  ]);
  const image = stdout.trim();
  const deploymentId =
    'studio-engine-' +
    hash(JSON.stringify([hash(bundle.code), moduleHash, dependencyHash, image])).slice(0, 24);
  return deployments.register({
    deploymentId,
    version: '1',
    workflowTypes: ['studioWorkflow'],
    workflowBundle: { code: bundle.code },
    dependencyHash,
    blocks: [visualBlock(moduleHash)],
    modules: [
      { moduleId: 'studio-operation', moduleHash, path: '/opt/runsett/modules/operation.mjs', image },
      {
        moduleId: 'studio-connector',
        moduleHash: connectorHash,
        path: '/opt/runsett/modules/connector.mjs',
        image,
      },
    ],
  });
}
type WorkerHandle = Awaited<ReturnType<typeof createRunsettWorker>>;
type ActiveWorker = { handle: WorkerHandle; finished: Promise<void>; lastUsed: number; retiring: boolean };

export class StudioEngine {
  status: 'starting' | 'online' | 'offline' = 'starting';
  message = 'Starting the local engine…';
  private client?: Client;
  private current?: RegisteredDeployment;
  private starting?: Promise<void>;
  private stopping = false;
  private readonly workers = new Map<string, ActiveWorker>();
  private readonly launching = new Map<string, Promise<void>>();
  private maintenanceTimer?: NodeJS.Timeout;
  private maintenance?: Promise<void>;
  private testing = false;
  constructor(
    private readonly store: StudioStore,
    private readonly connections?: StudioConnections,
  ) {}

  private credentials(ids: string[]): Record<string, CredentialSource> {
    if (!ids.length) return {};
    if (!this.connections) throw new RequestError('Studio connections are unavailable.', 503);
    return this.connections.getCredentials([...new Set(ids)]);
  }

  start() {
    if (this.status === 'online' || this.starting || this.stopping) return;
    this.status = 'starting';
    this.starting = this.connect()
      .catch((error) => {
        console.error('Studio startup:', error);
        this.status = 'offline';
      })
      .finally(() => {
        delete this.starting;
      });
  }
  private async connect() {
    if (!process.env.TEMPORAL_ADDRESS) {
      this.message = 'Start Docker, then retry the local engine.';
      // Older Docker Desktop installs can use the project-local Compose binary.
      const localCompose = join(root, '.runsett/bin/docker-compose');
      const command = existsSync(localCompose) ? localCompose : 'docker';
      const args = command === 'docker' ? ['compose'] : [];
      await exec(command, [...args, '-f', 'deploy/compose.yaml', 'up', '-d', '--wait'], {
        cwd: root,
        timeout: 600_000,
      });
    }
    this.message = 'Check the Temporal connection and retry.';
    if (!this.client)
      this.client = new Client({
        connection: await Connection.connect({ address, connectTimeout: '5s' }),
        namespace,
      });
    this.message = 'Check Docker and retry building the workflow worker.';
    const current = await prepareDeployment();
    this.current = current;
    await this.ensureWorker(current);
    this.status = 'online';
    this.message = 'Engine online';
    this.maintainWorkers();
    this.maintenanceTimer ??= setInterval(() => this.maintainWorkers(), 30_000).unref();
  }
  private async ensureWorker(deployment: RegisteredDeployment): Promise<void> {
    if (this.stopping) throw new RequestError('Studio is shutting down.', 503);
    const id = deployment.deploymentId;
    const active = this.workers.get(id);
    if (active?.retiring) {
      await active.finished;
      return this.ensureWorker(deployment);
    }
    if (active) {
      active.lastUsed = Date.now();
      return;
    }
    const pending = this.launching.get(id);
    if (pending) return pending;
    const credentials = this.credentials(deployment.blocks.flatMap((block) => block.credentialBindings));
    const start = createRunsettWorker({ deployment, auditDirectory, address, namespace, credentials })
      .then((handle) => {
        const finished = handle
          .run()
          .catch((error) => console.error('Studio worker:', error))
          .finally(async () => {
            this.workers.delete(id);
            if (!this.stopping && id === this.current?.deploymentId) {
              this.status = 'offline';
              this.message = 'The workflow worker stopped. Retry the engine to resume.';
            }
            await handle.close();
          });
        void finished.catch((error) => console.error('Worker shutdown:', error));
        this.workers.set(id, { handle, finished, lastUsed: Date.now(), retiring: false });
      })
      .finally(() => this.launching.delete(id));
    this.launching.set(id, start);
    return start;
  }
  private maintainWorkers() {
    if (this.maintenance || this.status !== 'online' || this.stopping) return;
    this.maintenance = this.refreshWorkers()
      .catch((error) => console.error('Studio worker refresh:', error))
      .finally(() => {
        delete this.maintenance;
      });
  }
  private async refreshWorkers() {
    const client = this.connected();
    // Resume old immutable deployments after restart, including workflows parked on a timer.
    const active = await client.connection.withDeadline(Date.now() + 10_000, async () => {
      const ids = new Set<string>();
      const query = "WorkflowType = 'studioWorkflow' AND ExecutionStatus = 'Running'";
      for await (const info of client.workflow.list({ query })) {
        const memo = info.memo?.runsettRequest as { deploymentId?: unknown } | undefined;
        const id = memo?.deploymentId ?? this.store.getSubmission(info.workflowId)?.deploymentId;
        if (typeof id === 'string' && /^studio-(?:engine|js|plan)-[a-f0-9]{24}$/.test(id)) ids.add(id);
      }
      return ids;
    });
    for (const id of active) {
      if (this.stopping) return;
      const worker = this.workers.get(id);
      if (worker && !worker.retiring) worker.lastUsed = Date.now();
      else {
        try {
          await this.ensureWorker(await deployments.read(id));
        } catch (error) {
          // A shared namespace can include deployments belonging to another workspace.
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
    }
    for (const [id, worker] of this.workers) {
      if (
        id !== this.current?.deploymentId &&
        !worker.retiring &&
        Date.now() - worker.lastUsed > 90_000 &&
        worker.handle.worker.getState() === 'RUNNING'
      ) {
        worker.retiring = true;
        worker.handle.shutdown();
      }
    }
  }
  async stop() {
    this.stopping = true;
    await this.starting;
    clearInterval(this.maintenanceTimer);
    await this.maintenance;
    await Promise.allSettled(this.launching.values());
    const workers = [...this.workers.values()];
    for (const { handle } of workers) if (handle.worker.getState() === 'RUNNING') handle.shutdown();
    await Promise.allSettled(workers.map((worker) => worker.finished));
    await this.client?.connection.close();
  }
  async checkConnection() {
    if (this.status !== 'online' || !this.client) return;
    const { connection, workflowService } = this.client;
    try {
      await connection.withDeadline(Date.now() + 1800, () => workflowService.getSystemInfo({}));
    } catch {
      this.status = 'offline';
      this.message = 'The connection to Temporal was lost. Start Docker and retry the engine.';
    }
  }
  private connected() {
    if (!this.client || this.status !== 'online')
      throw new RequestError('The engine is ' + this.status + '. ' + this.message, 503);
    return this.client;
  }
  async run(
    id: string,
    revision: number,
    requestId: string,
    testInput?: JsonValue,
    trigger?: AutomaticTrigger,
  ) {
    const client = this.connected();
    const previous = this.store.getSubmission('studio-' + id + '-' + requestId);
    let deployment: RegisteredDeployment;
    if (previous) {
      deployment = await deployments.read(previous.deploymentId);
    } else {
      const workflow = this.store.get(id);
      if (workflow.revision !== revision)
        throw new RequestError('Save your latest changes before running this workflow.', 409);
      const value = validateForRun(workflow.document, testInput);
      const { name, steps } = workflow.document;
      const pinned = pinSources(steps);
      try {
        const plan = runPlan(
          { name, revision, value, steps, ...(trigger ? { trigger } : {}) },
          this.current!,
          pinned.steps,
        );
        assertJsonValue(plan, DEFAULT_EXECUTION_LIMITS.inputBytes);
      } catch {
        throw new RequestError('The input and workflow plan together must fit within 1 MiB.');
      }
      // Fail a missing connection before recording a run or building any authored code.
      this.credentials(
        steps.flatMap((step) => {
          if (!isConnectorKind(step.kind)) return [];
          const binding = connectorBinding(step.kind, step.setting);
          return binding ? [binding] : [];
        }),
      );
      deployment = await prepareStudioDeployment(
        deployments,
        this.current!,
        pinned.sources,
        steps,
        connectorNetwork,
      );
    }
    const submission = this.store.prepareRun(
      id,
      revision,
      requestId,
      deployment.deploymentId,
      testInput,
      trigger,
    );
    if (submission.deploymentId !== deployment.deploymentId)
      deployment = await deployments.read(submission.deploymentId);
    await this.ensureWorker(deployment);
    const input = runPlan(submission.input, deployment);
    return client.connection.withDeadline(Date.now() + 12_000, () =>
      createRunClient({ client, deployments }).startRun({
        workflowId: submission.id,
        workflowType: 'studioWorkflow',
        deploymentId: deployment.deploymentId,
        input,
      }),
    );
  }
  async testStep(value: unknown, signal: AbortSignal, operation = false) {
    this.connected();
    const test = operation ? validateOperationTest(value) : validateStepTest(value);
    if (this.testing) throw new RequestError('Another step test is running. Try again in a moment.', 429);
    this.testing = true;
    try {
      if ('kind' in test && test.kind === 'wait') {
        const start = Date.now();
        await delay(Number(test.setting) * 1000, undefined, { signal });
        return { ok: true, output: test.input, diagnostics: [], durationMs: Date.now() - start };
      }
      const module = this.current!.modules[0]!;
      if ('source' in test)
        return await testJavaScript(module.image, test.source, test.input, auditDirectory, signal);
      const input = { kind: test.kind, setting: test.setting, value: test.input };
      assertTestInput(input);
      if (isConnectorKind(test.kind)) {
        const connector = this.current!.modules.find((item) => item.moduleId === 'studio-connector');
        if (!connector) throw new RequestError('The connector module is unavailable.', 503);
        const binding = connectorBinding(test.kind, test.setting);
        return await testModule(connector, input, auditDirectory, signal, {
          network: connectorNetwork,
          credentials: this.credentials(binding ? [binding] : []),
        });
      }
      return await testModule(module, input, auditDirectory, signal);
    } finally {
      this.testing = false;
    }
  }
  async history(id?: string, includeSteps = false) {
    const client = this.connected();
    // Caller validates id as a UUID before it can enter a visibility query.
    const query = id ? "WorkflowId STARTS_WITH 'studio-" + id + "-'" : undefined;
    return client.connection.withDeadline(Date.now() + 8_000, async () => {
      const runs = [];
      for await (const info of client.workflow.list({ ...(query ? { query } : {}), pageSize: 50 })) {
        if (!info.memo?.runsettRequest) continue;
        const submission = this.store.getSubmission(info.workflowId);
        if (includeSteps && (!submission || submission.workflowId !== id)) continue;
        runs.push({
          id: info.workflowId,
          runId: info.runId,
          name: submission?.input.name ?? info.type,
          state: info.status.name,
          startedAt: info.startTime,
          finishedAt: info.closeTime,
          revision: submission?.revision,
          ...(submission ? { triggerName: triggerName(submission.input.trigger) } : {}),
          ...(includeSteps && submission
            ? { steps: submission.input.steps.map(({ id, name }) => ({ id, name })) }
            : {}),
        });
        if (runs.length >= 50) break;
      }
      return runs;
    });
  }
  async previousOutput(
    workflowId: string,
    stepId: string,
    signal: AbortSignal,
    selected?: RecordedRunRef,
  ): Promise<RecordedStepOutput | null> {
    this.store.get(workflowId);
    signal.throwIfAborted();
    const runs = selected
      ? [selected]
      : (await this.history(workflowId)).sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
    let partial = false;
    for (const run of runs) {
      signal.throwIfAborted();
      const submission = this.store.getSubmission(run.id);
      if (submission?.workflowId !== workflowId) {
        if (selected) throw new RequestError('This run does not belong to this workflow.', 404);
        continue;
      }
      const { value: trigger, steps } = submission.input;
      const origin = { runId: run.runId, revision: submission.revision };
      // Visibility has already verified this pair when searching recent runs. An explicit
      // selection must also verify the execution before returning a saved trigger input.
      if (stepId === 'trigger' && !selected)
        return { ...origin, stepName: triggerName(submission.input.trigger), value: trigger };
      const index = steps.findIndex((step) => step.id === stepId);
      const step = steps[index];
      if (!step && stepId !== 'trigger' && stepId !== 'output') continue;

      // A completed wait forwards the last value in this run's saved ordering.
      const producer =
        step?.kind === 'wait' ? steps.slice(0, index).findLast((s) => s.kind !== 'wait') : step;
      let report;
      try {
        report = await this.inspect(run.id, false, {
          runId: run.runId,
          outputStepId: stepId === 'output' ? null : (producer?.id ?? 'trigger'),
        });
      } catch (e) {
        if (!selected && e instanceof RequestError && e.status === 404) continue;
        throw e;
      }
      partial ||= report.partial;
      if (stepId === 'trigger')
        return { ...origin, stepName: triggerName(submission.input.trigger), value: trigger };
      if (stepId === 'output') {
        if (report.state !== 'COMPLETED' || report.output === undefined) continue;
        assertTestInput(report.output);
        return { ...origin, stepName: 'Return result', value: report.output };
      }
      if (!step || report.steps.find((s) => s.stepId === stepId)?.state !== 'COMPLETED') continue;
      const value = producer ? report.steps.find((s) => s.stepId === producer.id)?.output : trigger;
      if (value === undefined) continue;
      assertTestInput(value);
      return { ...origin, stepName: step.name, value };
    }
    if (partial) throw new RequestError('Run history is incomplete. Try loading the output again.', 503);
    return null;
  }
  async inspect(id: string, logs = false, selection?: { runId: string; outputStepId: string | null }) {
    const client = this.connected();
    try {
      return await client.connection.withDeadline(Date.now() + 10_000, async () => {
        const report = await inspectRun({ client, deployments, auditDirectory }, id, {
          details: true,
          logs,
          ...selection,
          maxEvents: 400,
        });
        if (report.deployment.availability === 'unsupported')
          throw new RequestError('This run is outside Runsett.', 404);
        const submission = this.store.getSubmission(id);
        const plan = submission?.input;
        let completed: number | undefined;
        if (plan && report.state === 'RUNNING') {
          try {
            completed = await client.connection.withDeadline(Date.now() + 1500, () =>
              client.workflow.getHandle(id, report.runId).query<number>('studioCompletedSteps'),
            );
          } catch {
            /* A queued run can have no responding worker yet. */
          }
        }
        const observed = new Map(report.steps.map((step) => [step.stepId, step]));
        const lastObserved = plan?.steps.findLastIndex((step) => observed.has(step.id)) ?? -1;
        function stateOf(plan: RunInput, index: number) {
          if (
            report.state === 'COMPLETED' ||
            index < lastObserved ||
            (completed !== undefined && index < completed)
          )
            return 'COMPLETED';
          if (
            report.state === 'RUNNING' &&
            completed === index &&
            plan.steps[index]?.kind === 'wait' &&
            report.wait?.reason === 'durable-timer'
          )
            return 'WAITING';
          return report.state === 'RUNNING' ? 'PENDING' : 'NOT_RECORDED';
        }
        const steps = plan
          ? plan.steps.map((step, i) => ({
              name: step.name,
              kind: step.kind,
              stepId: step.id,
              state: stateOf(plan, i),
              ...observed.get(step.id),
            }))
          : report.steps.map((step) => ({ ...step, name: step.stepId, kind: 'operation' }));
        return {
          id,
          runId: report.runId,
          state: report.state,
          name: plan?.name ?? report.workflowType,
          revision: plan?.revision,
          ...(plan ? { triggerName: triggerName(plan.trigger) } : {}),
          input: plan ? plan.value : report.input,
          output: report.output,
          error: report.error,
          steps,
          canCancel: !!submission,
          partial:
            report.history.truncated ||
            report.history.availability !== 'available' ||
            report.details.truncated ||
            report.diagnostics.truncated,
        };
      });
    } catch (error) {
      if (error instanceof WorkflowNotFoundError)
        throw new RequestError('This run is no longer in Temporal history.', 404);
      throw error;
    }
  }
  async cancel(id: string) {
    const client = this.connected();
    if (!this.store.getSubmission(id)) throw new RequestError('Only Studio runs can be cancelled here.', 400);
    await client.connection.withDeadline(Date.now() + 8_000, () =>
      createRunClient({ client, deployments }).cancelRun(id),
    );
  }
}
