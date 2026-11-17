import assert from 'node:assert/strict';
import { test } from 'node:test';
import { asyncLocalStorage, CancelledFailure, type Context } from '@temporalio/activity';
import { ExecutionError, type CodeInvocation } from '@runsett/contracts';
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

test('activity validation scopes repeated schema IDs to each deployment block', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'runsett-schema-activity-'));
  try {
    const blocks = ['number', 'string'].map(type => defineBlock({ name: type, version: '1', moduleId: 'operation', moduleHash: 'a'.repeat(64), inputSchema: { $id: 'urn:runsett:activity', $defs: { value: { type } }, $ref: '#/$defs/value' }, outputSchema: { $id: 'urn:runsett:activity', type }, effect: 'pure', credentialBindings: [], networkMode: 'none' }));
    const deployment = await new DeploymentRegistry(directory).register({ deploymentId: 'v1', version: '1', workflowTypes: ['test'], workflowBundle: { code: 'fixture' }, dependencyHash: 'b'.repeat(64), blocks, modules: [{ moduleId: 'operation', moduleHash: 'a'.repeat(64), path: '/opt/runsett/modules/operation.mjs', image: `sha256:${'c'.repeat(64)}` }] });
    const executor = Object.assign(async (invocation: CodeInvocation) => ({ output: invocation.input, diagnostics: [], moduleHash: invocation.moduleHash, startedAt: '2026-11-17T00:00:00.000Z', finishedAt: '2026-11-17T00:00:00.000Z' }), { close() {}, reconcile: async () => [] });
    const context = { info: { workflowExecution: { workflowId: 'flow', runId: 'run' }, attempt: 1 }, cancellationSignal: new AbortController().signal, heartbeat() {} } as unknown as Context;
    await asyncLocalStorage.run(context, async () => {
      const activities = createActivities(deployment, executor);
      for (const block of deployment.blocks) {
        const input = block.name === 'number' ? 3 : 'text';
        const request = { deploymentId: 'v1', stepId: block.name, block, input };
        assert.equal((await activities.executeStep(request)).output, input);
        await assert.rejects(activities.executeStep({ ...request, input: block.name === 'number' ? 'wrong' : 3 }), { type: 'VALIDATION_ERROR' });
      }
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
