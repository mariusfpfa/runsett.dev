import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeploymentRegistry, taskQueueFor } from '../../packages/runtime/src/versioning.js';
import { ReconciliationAudit } from '../../packages/runtime/src/audit.js';
const deployment = { deploymentId: 'test/v1', version: '1', workflowTypes: ['sample'], workflowBundle: { code: 'exports.sample = async () => 1' }, dependencyHash: 'a'.repeat(64), blocks: [], modules: [] };
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
