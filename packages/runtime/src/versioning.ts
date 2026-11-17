import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { assertJsonValue } from '@runsett/contracts';
import { defineBlock, type BlockDefinition } from '@runsett/sdk';
import { ModuleRegistry, type RegisteredModule } from '@runsett/runner';
import { canonicalJson, durableWrite, sha256, syncDirectory } from './storage.js';
export interface DeploymentDefinition {
  deploymentId: string; version: string; workflowTypes: string[];
  workflowBundle: { code: string }; dependencyHash: string;
  blocks: BlockDefinition[]; modules: RegisteredModule[]; configuredNetwork?: string;
}
export interface RegisteredDeployment extends DeploymentDefinition { fingerprint: string }
function normalize(definition: DeploymentDefinition): DeploymentDefinition {
  assertJsonValue(definition, 32 * 1024 * 1024);
  const copy = JSON.parse(JSON.stringify(definition)) as DeploymentDefinition;
  if (!copy.deploymentId || !copy.version || !copy.workflowBundle?.code || !/^[a-f0-9]{64}$/.test(copy.dependencyHash) ||
      !Array.isArray(copy.workflowTypes) || !copy.workflowTypes.length || copy.workflowTypes.some(type => !type || typeof type !== 'string') || new Set(copy.workflowTypes).size !== copy.workflowTypes.length) throw new TypeError('Invalid deployment identity, bundle or workflow types');
  if (copy.configuredNetwork !== undefined && (typeof copy.configuredNetwork !== 'string' || !copy.configuredNetwork || /^(host|container)/.test(copy.configuredNetwork))) throw new TypeError('Invalid deployment network');
  const registry = new ModuleRegistry(copy.modules);
  copy.blocks = copy.blocks.map(defineBlock);
  for (const block of copy.blocks) {
    registry.resolve(block.moduleId, block.moduleHash);
    if (block.networkMode === 'configured' && !copy.configuredNetwork) throw new TypeError('Configured block network requires deployment network');
  }
  return copy;
}
function fingerprint(definition: DeploymentDefinition): string {
  return sha256(canonicalJson(definition as unknown as import('@runsett/contracts').JsonValue));
}
export function assertRegisteredDeployment(value: RegisteredDeployment): void {
  const { fingerprint: recorded, ...definition } = value;
  if (fingerprint(normalize(definition)) !== recorded) throw new TypeError('Deployment integrity check failed');
}
export function taskQueueFor(deployment: Pick<RegisteredDeployment, 'deploymentId' | 'version'>): string {
  return `runsett-${sha256(JSON.stringify([deployment.deploymentId, deployment.version]))}`;
}
export class DeploymentRegistry {
  constructor(readonly directory: string) {}
  async register(definition: DeploymentDefinition): Promise<RegisteredDeployment> {
    const normalized = normalize(definition);
    const registered = { ...normalized, fingerprint: fingerprint(normalized) };
    try { await durableWrite(this.directory, `${sha256(normalized.deploymentId)}.json`, JSON.stringify(registered), true); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await this.read(normalized.deploymentId);
      if (existing.fingerprint !== registered.fingerprint) throw new Error('Deployment is immutable: ID already contains different content');
      await syncDirectory(this.directory);
      return existing;
    }
    return this.read(normalized.deploymentId);
  }
  async read(deploymentId: string): Promise<RegisteredDeployment> {
    const value = JSON.parse(await readFile(join(this.directory, `${sha256(deploymentId)}.json`), 'utf8')) as RegisteredDeployment;
    assertRegisteredDeployment(value);
    if (value.deploymentId !== deploymentId) throw new TypeError('Deployment ID mismatch');
    return value;
  }
  async list(): Promise<RegisteredDeployment[]> {
    let names: string[];
    try { names = await readdir(this.directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    return Promise.all(names.filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(async name => {
      const value = JSON.parse(await readFile(join(this.directory, name), 'utf8')) as RegisteredDeployment;
      return this.read(value.deploymentId);
    }));
  }
}
