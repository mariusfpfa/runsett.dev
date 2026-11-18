import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { JsonValue } from '@runsett/contracts';
import { DeploymentRegistry } from '@runsett/runtime';
import { visualBlock } from '../../packages/studio/src/block.js';
import { prepareStudioDeployment } from '../../packages/studio/src/javascript.js';
import {
  greeting,
  kindSettings,
  validateDocument,
  validateForRun,
  validateOperationTest,
} from '../../packages/studio/src/model.js';
import { StudioStore } from '../../packages/studio/src/store.js';

const { default: operate } = await import(
  new URL('../../packages/studio/modules/operation.mjs', import.meta.url).href
);

test('data nodes validate and execute with the same settings as a saved workflow', async () => {
  const run = (kind: string, config: unknown, input: JsonValue) => {
    const setting = config === undefined ? '' : JSON.stringify(config);
    const step = { id: 'data-step', kind, name: 'Data step', setting };
    const doc = validateDocument({ ...greeting(), steps: [step] });
    validateForRun(doc, input);
    validateOperationTest({ kind, setting, input });
    return operate({ kind, setting, value: input });
  };
  assert.deepEqual(await run('parse-json', undefined, '[false,0]'), [false, 0]);
  const initial = { lead: { name: 'Alex' }, other: false };
  assert.deepEqual(await run('set-field', { path: 'lead.score', value: 0 }, initial), {
    lead: { name: 'Alex', score: 0 },
    other: false,
  });
  assert.deepEqual(initial, { lead: { name: 'Alex' }, other: false });
  assert.deepEqual(await run('set-field', { path: 'a.b', value: null }, {}), { a: { b: null } });
  await assert.rejects(
    run('set-field', { path: 'lead.score.value', value: 1 }, { lead: { score: 0 } }),
    /object/i,
  );
  assert.throws(() => run('set-field', { path: '__proto__.project', value: 1 }, {}), /path/i);
  assert.deepEqual(
    await run('filter-list', { path: 'ok', equals: false }, [{ ok: false }, { ok: true }, {}, { ok: 0 }]),
    [{ ok: false }],
  );
  assert.deepEqual(await run('filter-list', { path: '', equals: { b: 2, a: 1 } }, [{ a: 1, b: 2 }, {}]), [
    { a: 1, b: 2 },
  ]);
  assert.equal(await run('choose', { path: 'missing', equals: null, then: 1, else: 0 }, {}), 0);
  assert.equal(await run('choose', { path: 'value', equals: null, then: 0, else: 1 }, { value: null }), 0);
  await assert.rejects(run('parse-json', undefined, 'incomplete'), /JSON/);
  assert.throws(() => validateOperationTest({ kind: 'parse-json', setting: '', input: undefined }), /input/i);
  for (const kind of ['parse-json', 'set-field', 'filter-list', 'choose', 'http', 'slack', 'teams'])
    assert.ok(Object.hasOwn(kindSettings, kind), kind);
});

test('automatic starts record their origin and preserve the historical input on retries', (t) => {
  const store = new StudioStore(':memory:');
  t.after(() => store.close());
  const doc = store.create(greeting());
  const key = randomUUID();
  const first = store.prepareRun(doc.id, 1, key, 'deployment', false, 'webhook');
  assert.equal(first.input.value, false);
  assert.equal(first.input.trigger, 'webhook');
  store.save(doc.id, 1, { ...doc.document, sampleInput: 'new default' });
  assert.deepEqual(store.prepareRun(doc.id, 1, key, 'deployment', false, 'webhook'), first);
  assert.throws(() => store.prepareRun(doc.id, 1, key, 'deployment', false, 'schedule'), /trigger/i);
  const scheduled = store.prepareRun(doc.id, 2, randomUUID(), 'deployment', undefined, 'schedule');
  assert.equal(scheduled.input.value, 'new default');
  assert.equal(scheduled.input.trigger, 'schedule');
});

test('only connector blocks get outbound networking and each message block binds its own connection', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'runsett-studio-nodes-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const registry = new DeploymentRegistry(directory);
  const digest = 'e'.repeat(64),
    connectorHash = 'a'.repeat(64),
    image = 'sha256:' + digest;
  const base = await registry.register({
    deploymentId: 'test-nodes',
    version: '1',
    workflowTypes: ['studioWorkflow'],
    workflowBundle: { code: '/* test */' },
    dependencyHash: digest,
    blocks: [visualBlock(digest)],
    modules: [
      { moduleId: 'studio-operation', moduleHash: digest, path: '/opt/runsett/modules/operation.mjs', image },
      {
        moduleId: 'studio-connector',
        moduleHash: connectorHash,
        path: '/opt/runsett/modules/connector.mjs',
        image,
      },
    ],
  });
  const slackId = 'slack-' + randomUUID(),
    teamsId = 'teams-' + randomUUID();
  const httpId = 'http-' + digest + '-' + randomUUID();
  const message = (kind: 'slack' | 'teams', id: string) => ({
    id: randomUUID(),
    kind,
    name: kind,
    setting: JSON.stringify({ connectionId: id, message: '{{value}}' }),
  });
  const steps = [
    { ...greeting().steps[0]! },
    {
      id: 'get',
      kind: 'http' as const,
      name: 'Fetch',
      setting: JSON.stringify({ method: 'GET', url: 'https://example.test' }),
    },
    {
      id: 'authenticated',
      kind: 'http' as const,
      name: 'Read API',
      setting: JSON.stringify({ method: 'GET', url: 'https://example.test', connectionId: httpId }),
    },
    message('slack', slackId),
    message('slack', slackId),
    message('teams', teamsId),
  ];
  const deployment = await prepareStudioDeployment(registry, base, new Map(), steps, 'test-network');
  assert.equal(deployment.configuredNetwork, 'test-network');
  const policies = deployment.blocks.map((b) => [
    b.name,
    b.networkMode,
    b.maximumAttempts,
    b.credentialBindings,
  ]);
  assert.deepEqual(policies, [
    ['Studio operation', 'none', 1, []],
    ['HTTP request', 'configured', 1, []],
    ['HTTP request', 'configured', 1, [httpId]],
    ['Send Slack message', 'configured', 1, [slackId]],
    ['Send Teams message', 'configured', 1, [teamsId]],
  ]);
  assert.equal(
    (await prepareStudioDeployment(registry, base, new Map(), [...steps].reverse(), 'test-network'))
      .deploymentId,
    deployment.deploymentId,
  );
  const replacement = await prepareStudioDeployment(
    registry,
    base,
    new Map(),
    [...steps, message('slack', 'slack-' + randomUUID())],
    'test-network',
  );
  assert.notEqual(replacement.deploymentId, deployment.deploymentId);
  assert.deepEqual(await registry.read(deployment.deploymentId), deployment);
});
