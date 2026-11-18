import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { DEFAULT_EXECUTION_LIMITS, ExecutionError, type JsonValue } from '@runsett/contracts';
import { createCodeExecutor, ModuleRegistry, type RegisteredModule } from '@runsett/runner';
import { DeploymentRegistry, ReconciliationAudit, type RegisteredDeployment } from '@runsett/runtime';
import { javaScriptBlock } from './block.js';
import { validateSource, type StepTestResult, type VisualStep } from './model.js';

const exec = promisify(execFile);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const modulePath = '/opt/runsett/modules/step.mjs';
const imageId = /^sha256:[a-f0-9]{64}$/;
const builds = new Map<string, Promise<string>>();

export function pinSources(steps: VisualStep[]) {
  const sources = new Map<string, string>();
  const pinned = steps.map((step) => {
    if (step.kind !== 'javascript') return step;
    const digest = hash(step.setting);
    sources.set(digest, step.setting);
    return { ...step, setting: digest };
  });
  return { steps: pinned, sources };
}

async function buildImage(tag: string, baseImage: string, source: string) {
  try {
    const { stdout } = await exec('docker', ['image', 'inspect', '--format', '{{.Id}}', tag], {
      timeout: 12_000,
    });
    if (!imageId.test(stdout.trim())) throw new Error('Invalid JavaScript runner image ID.');
    return stdout.trim();
  } catch (error) {
    if (!/no such (image|object)/i.test(String((error as { stderr?: string }).stderr))) throw error;
  }
  const directory = await mkdtemp(join(tmpdir(), 'runsett-js-'));
  try {
    const baseTag = 'runsett-studio-base:' + baseImage.slice('sha256:'.length);
    await exec('docker', ['image', 'tag', baseImage, baseTag], { timeout: 12_000 });
    // Only this fixed recipe and the module are sent to Docker. The build never runs author code.
    await Promise.all([
      writeFile(
        join(directory, 'Dockerfile'),
        'FROM ' + baseTag + '\nCOPY --chmod=0444 step.mjs ' + modulePath + '\n',
      ),
      writeFile(join(directory, 'step.mjs'), source),
    ]);
    const { stdout } = await exec(
      'docker',
      ['build', '--network=none', '--pull=false', '-q', '-t', tag, directory],
      {
        env: { ...process.env, DOCKER_BUILDKIT: '1' },
        timeout: 90_000,
        maxBuffer: 1024 * 1024,
      },
    );
    const image = stdout.trim();
    if (!imageId.test(image)) throw new Error('Docker did not return a pinned JavaScript image.');
    return image;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function packageJavaScript(baseImage: string, source: string): Promise<RegisteredModule> {
  validateSource(source);
  if (!imageId.test(baseImage)) throw new Error('JavaScript requires a pinned local runner image.');
  const moduleHash = hash(source);
  const tag = 'runsett-studio-js:' + hash(JSON.stringify([1, baseImage, moduleHash]));
  let build = builds.get(tag);
  if (!build) {
    build = buildImage(tag, baseImage, source).finally(() => builds.delete(tag));
    builds.set(tag, build);
  }
  return { moduleId: 'studio-js-' + moduleHash, moduleHash, path: modulePath, image: await build };
}

export async function prepareScriptDeployment(
  registry: DeploymentRegistry,
  base: RegisteredDeployment,
  sources: Map<string, string>,
): Promise<RegisteredDeployment> {
  if (!sources.size) return base;
  const hashes = [...sources.keys()].sort();
  const deploymentId = 'studio-js-' + hash(JSON.stringify([base.fingerprint, hashes])).slice(0, 24);
  try {
    return await registry.read(deploymentId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const modules = [...base.modules];
  for (const digest of hashes)
    modules.push(await packageJavaScript(base.modules[0]!.image, sources.get(digest)!));
  return registry.register({
    deploymentId,
    version: base.version,
    workflowTypes: base.workflowTypes,
    workflowBundle: base.workflowBundle,
    dependencyHash: base.dependencyHash,
    blocks: [...base.blocks, ...hashes.map(javaScriptBlock)],
    modules,
  });
}

export async function testJavaScript(
  baseImage: string,
  source: string,
  input: JsonValue,
  auditDirectory: string,
  signal: AbortSignal,
): Promise<StepTestResult> {
  const module = await packageJavaScript(baseImage, source);
  return testModule(module, input, auditDirectory, signal);
}

export async function testModule(
  module: RegisteredModule,
  input: JsonValue,
  auditDirectory: string,
  signal: AbortSignal,
): Promise<StepTestResult> {
  signal.throwIfAborted();
  const execute = createCodeExecutor({
    registry: new ModuleRegistry([module]),
    scope: 'studio-js-tests',
    onReconciliation: new ReconciliationAudit(auditDirectory).acknowledge,
  });
  const id = randomUUID();
  const start = Date.now();
  try {
    const result = await execute(
      {
        identity: {
          workflowId: 'studio-test-' + id,
          runId: id,
          stepId: 'preview',
          attempt: 1,
          operationKey: id,
          deploymentId: 'studio-js-test',
        },
        moduleId: module.moduleId,
        moduleHash: module.moduleHash,
        input,
        networkMode: 'none',
        credentialBindings: [],
        limits: DEFAULT_EXECUTION_LIMITS,
      },
      signal,
    );
    return {
      ok: true,
      output: result.output,
      diagnostics: result.diagnostics,
      durationMs: Date.now() - start,
    };
  } catch (error) {
    if (!(error instanceof ExecutionError)) throw error;
    const location = /\/opt\/runsett\/modules\/step\.mjs:(\d+)/.exec(error.stack ?? '');
    return {
      ok: false,
      error: { code: error.code, message: error.message, ...(location ? { line: Number(location[1]) } : {}) },
      diagnostics: error.diagnostics,
      durationMs: Date.now() - start,
    };
  } finally {
    execute.close();
  }
}
