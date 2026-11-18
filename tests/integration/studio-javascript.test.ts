import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DeploymentRegistry } from '@runsett/runtime';
import { visualBlock } from '../../packages/studio/src/block.js';
import {
  packageJavaScript,
  prepareScriptDeployment,
  testJavaScript,
} from '../../packages/studio/src/javascript.js';

test('Studio tests and workflow deployments use the same pinned Docker module across source edits', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'runsett-studio-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const image = execFileSync(
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
      encoding: 'utf8',
      env: { ...process.env, DOCKER_BUILDKIT: '1' },
    },
  ).trim();
  const digest = createHash('sha256')
    .update(await readFile('packages/studio/modules/operation.mjs'))
    .digest('hex');
  const registry = new DeploymentRegistry(join(directory, 'deployments'));
  const base = await registry.register({
    deploymentId: 'studio-test-base',
    version: '1',
    workflowTypes: ['studioWorkflow'],
    workflowBundle: { code: '/* Module packaging fixture */' },
    dependencyHash: digest,
    blocks: [visualBlock(digest)],
    modules: [
      { moduleId: 'studio-operation', moduleHash: digest, path: '/opt/runsett/modules/operation.mjs', image },
    ],
  });
  const source = 'export default async function (input, context) { context.log("testing"); return input; }';
  const preview = (code: string) =>
    testJavaScript(image, code, false, join(directory, 'audit'), new AbortController().signal);
  const first = await packageJavaScript(image, source);
  const deployment = await prepareScriptDeployment(registry, base, new Map([[first.moduleHash, source]]));
  assert.deepEqual(deployment.modules[1], first);
  assert.equal(deployment.blocks[1]?.networkMode, 'none');
  assert.equal(deployment.blocks[1]?.maximumAttempts, 1);
  assert.deepEqual(deployment.blocks[1]?.credentialBindings, []);
  const success = await preview(source);
  assert.ok(success.ok);
  assert.equal(success.output, false);
  assert.match(success.diagnostics[0]!.message, /testing/);

  const edited =
    'export default function () {\n  console.error("checking input");\n  throw new Error("Missing amount");\n}';
  const second = await packageJavaScript(image, edited);
  const next = await prepareScriptDeployment(registry, base, new Map([[second.moduleHash, edited]]));
  assert.notEqual(deployment.deploymentId, next.deploymentId);
  assert.notEqual(first.image, second.image);
  assert.deepEqual((await registry.read(deployment.deploymentId)).modules[1], first);
  const failure = await preview(edited);
  assert.ok(!failure.ok);
  assert.deepEqual(failure.error, { code: 'RUNTIME_ERROR', message: 'Missing amount', line: 3 });
  assert.equal(failure.diagnostics[0]?.stream, 'stderr');
  assert.match(failure.diagnostics[0]!.message, /checking input/);
  const syntax = await preview('export default function (');
  assert.ok(!syntax.ok && syntax.error.code === 'RUNTIME_ERROR');
});
