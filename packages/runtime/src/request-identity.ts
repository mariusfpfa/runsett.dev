import type { JsonValue } from '@runsett/contracts';
import type { RegisteredDeployment } from './versioning.js';
import { canonicalJson, sha256 } from './storage.js';

/** Version 1 did not bind deployment content and cannot safely identify a run. */
export interface RunRequestIdentity {
  version: 2; fingerprint: string; deploymentId: string; deploymentFingerprint: string; workflowType: string;
}
export function createRequestIdentity(deployment: RegisteredDeployment, workflowType: string, input: JsonValue): RunRequestIdentity {
  const identity = { version: 2 as const, deploymentId: deployment.deploymentId, deploymentFingerprint: deployment.fingerprint, workflowType };
  return { ...identity, fingerprint: sha256(canonicalJson({ ...identity, input })) };
}
export function readRequestIdentity(value: unknown): RunRequestIdentity | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const memo = value as Partial<RunRequestIdentity>;
  if (memo.version !== 2 || typeof memo.deploymentId !== 'string' || !memo.deploymentId || typeof memo.workflowType !== 'string' || !memo.workflowType ||
      typeof memo.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(memo.fingerprint) ||
      typeof memo.deploymentFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(memo.deploymentFingerprint)) return undefined;
  return memo as RunRequestIdentity;
}
