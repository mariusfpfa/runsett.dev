import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeploymentRegistry, taskQueueFor } from '../../packages/runtime/src/versioning.js';
import { defineBlock } from '../../packages/sdk/src/block.js';
import { ReconciliationAudit } from '../../packages/runtime/src/audit.js';
const deployment = { deploymentId: 'test/v1', version: '1', workflowTypes: ['sample'], workflowBundle: { code: 'exports.sample = async () => 1' }, dependencyHash: 'a'.repeat(64), blocks: [], modules: [] };
test('same deployment names in independent registries never route changed content to the original queue', async () => {
  const path = await mkdtemp(join(tmpdir(), 'runsett-content-routing-'));
  try {
    const module = { moduleId: 'operation', moduleHash: 'c'.repeat(64), path: '/opt/runsett/modules/operation.mjs', image: `sha256:${'d'.repeat(64)}` };
    const definition = { ...deployment, modules: [module] };
    const original = await new DeploymentRegistry(join(path, 'original')).register(definition);
    for (const [index, change] of [{ workflowBundle: { code: 'exports.sample = async () => 2' } }, { dependencyHash: 'b'.repeat(64) }, { configuredNetwork: 'bridge' }, { modules: [{ ...module, image: `sha256:${'e'.repeat(64)}` }] }].entries()) {
      const changed = await new DeploymentRegistry(join(path, String(index))).register({ ...definition, ...change });
      assert.notEqual(taskQueueFor(original), taskQueueFor(changed));
    }
  } finally { await rm(path, { recursive: true, force: true }); }
});
test('immutable deployments persist across instances, pin bundle/dependencies and reject changed IDs', async () => {
  const path = await mkdtemp(join(tmpdir(), 'runsett-registry-'));
  try {
    const registry = new DeploymentRegistry(path);
    const one = await registry.register(deployment);
    assert.deepEqual(await new DeploymentRegistry(path).read(deployment.deploymentId), one);
    assert.deepEqual(await registry.register(deployment), one);
    assert.notEqual(taskQueueFor(one), taskQueueFor({ ...one, deploymentId: 'test/v2', version: '2' }));
    for (const changed of [{ workflowBundle: { code: 'changed' } }, { dependencyHash: 'b'.repeat(64) }, { workflowTypes: ['other'] }, { configuredNetwork: 'changed-network' }]) {
      await assert.rejects(registry.register({ ...deployment, ...changed }), /immutable/);
    }
    const filenames = await readdir(path);
    assert.ok(filenames.every(name => !name.includes('test')));
    await writeFile(join(path, filenames[0]!), '{}');
    await assert.rejects(registry.read(deployment.deploymentId));
  } finally { await rm(path, { recursive: true, force: true }); }
});
test('audit durably round-trips unknown outcomes and rejects storage failures', async () => {
  const path = await mkdtemp(join(tmpdir(), 'runsett-audit-'));
  const record = { containerId: 'c1', identity: { workflowId: '../../private', runId: 'r', stepId: 's', attempt: 1, operationKey: 'k', deploymentId: 'v1' }, expiresAt: 123, outcome: 'terminated-unknown' as const };
  try {
    await new ReconciliationAudit(join(path, 'audit')).acknowledge([record]);
    assert.deepEqual(await new ReconciliationAudit(join(path, 'audit')).read('../../private'), [record]);
    const files = await readdir(join(path, 'audit'));
    assert.equal(files.length, 1);
    assert.ok(!files[0]!.includes('private'));
    assert.deepEqual(JSON.parse(await readFile(join(path, 'audit', files[0]!), 'utf8')).record, record);
    await writeFile(join(path, 'blocked'), 'file');
    await assert.rejects(new ReconciliationAudit(join(path, 'blocked')).acknowledge([record]));
  } finally { await rm(path, { recursive: true, force: true }); }
});

test('deployment storage revalidates ID-bearing schemas after registration and reload', async () => {
  const path = await mkdtemp(join(tmpdir(), 'runsett-schema-registry-'));
  try {
    const blocks = ['number', 'string'].map(type => defineBlock({ name: type, version: '1', moduleId: 'operation', moduleHash: 'c'.repeat(64), inputSchema: { $id: 'urn:runsett:deployment', type }, outputSchema: { $id: 'urn:runsett:deployment', type }, effect: 'pure', credentialBindings: [], networkMode: 'none' }));
    const definition = { ...deployment, blocks, modules: [{ moduleId: 'operation', moduleHash: 'c'.repeat(64), path: '/opt/runsett/modules/operation.mjs', image: `sha256:${'d'.repeat(64)}` }] };
    const registry = new DeploymentRegistry(path);
    const registered = await registry.register(definition);
    assert.deepEqual(await registry.read(deployment.deploymentId), registered);
    assert.deepEqual(await registry.register(JSON.parse(JSON.stringify(definition))), registered);
    assert.equal((await new DeploymentRegistry(path).list())[0]!.blocks.length, 2);
  } finally { await rm(path, { recursive: true, force: true }); }
});
