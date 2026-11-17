import assert from 'node:assert/strict';
import { test } from 'node:test';
import { asyncLocalStorage, CancelledFailure, type Context } from '@temporalio/activity';
import { ExecutionError } from '@runsett/contracts';
import { defineBlock } from '../../packages/sdk/src/block.js';
import { createActivities } from '../../packages/runtime/src/activities.js';
import { DeploymentRegistry } from '../../packages/runtime/src/versioning.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('activity adapter preserves Temporal cancellation rather than recording an application failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'runsett-activity-'));
  try {
    const block = defineBlock({ name: 'operation', version: '1', moduleId: 'operation', moduleHash: 'a'.repeat(64), inputSchema: {}, outputSchema: {}, effect: 'write', credentialBindings: [], networkMode: 'none' });
    const deployment = await new DeploymentRegistry(directory).register({ deploymentId: 'v1', version: '1', workflowTypes: ['test'], workflowBundle: { code: 'fixture' }, dependencyHash: 'b'.repeat(64), blocks: [block], modules: [{ moduleId: block.moduleId, moduleHash: block.moduleHash, path: '/opt/runsett/modules/operation.mjs', image: `sha256:${'c'.repeat(64)}` }] });
    // Runner cancellation is a structured ExecutionError. This isolates the SDK
    // boundary; real Docker cancellation is exercised by test:runner.
    const executor = Object.assign(async () => { throw new ExecutionError({ code: 'CANCELLED', message: 'External effect outcome unknown', retryable: false, diagnostics: [] }); }, { close() {}, reconcile: async () => [] });
    const context = { info: { workflowExecution: { workflowId: 'flow', runId: 'run' }, attempt: 1 }, cancellationSignal: AbortSignal.abort(), heartbeat() {} } as unknown as Context;
    await asyncLocalStorage.run(context, async () => {
      await assert.rejects(createActivities(deployment, executor).executeStep({ deploymentId: 'v1', stepId: 'step', block, input: {} }), error => {
        assert.ok(error instanceof CancelledFailure);
        assert.match(error.message, /outcome unknown/);
        return true;
      });
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
