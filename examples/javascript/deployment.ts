import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { bundleWorkflowCode } from '@temporalio/worker';
import { DeploymentRegistry } from '@runsett/runtime';
import { operation } from './blocks.js';
/** Build-time helper: run after build and after baking modules into an image.
 * The caller supplies its content-addressed Docker image ID, never a mutable tag.
 */
export async function registerExample(options: { registryDirectory: string; deploymentId: string; version: '1' | '2'; image: string }) {
  const workflowBundle = await bundleWorkflowCode({ workflowsPath: resolve(`examples/javascript/workflow-v${options.version}.ts`) });
  const dependencyHash = createHash('sha256').update(await readFile('package-lock.json')).digest('hex');
  return new DeploymentRegistry(options.registryDirectory).register({
    deploymentId: options.deploymentId, version: options.version, workflowTypes: ['example'], workflowBundle, dependencyHash,
    blocks: [operation], modules: [{ moduleId: operation.moduleId, moduleHash: operation.moduleHash, path: '/opt/runsett/modules/operation.mjs', image: options.image }],
  });
}
