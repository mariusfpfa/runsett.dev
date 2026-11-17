import { Client, WorkflowExecutionAlreadyStartedError, WorkflowIdConflictPolicy, WorkflowIdReusePolicy } from '@temporalio/client';
import { assertJsonValue, assertRecord, DEFAULT_EXECUTION_LIMITS, type JsonValue } from '@runsett/contracts';
import { DeploymentRegistry, taskQueueFor } from './versioning.js';
import { canonicalJson, sha256 } from './storage.js';
export interface StartRunRequest { workflowId: string; deploymentId: string; workflowType: string; input: JsonValue }
export class RunConflictError extends Error { override name = 'RunConflictError'; }
export function createRunClient(options: { client: Client; deployments: DeploymentRegistry }) {
  return {
    async startRun(request: StartRunRequest): Promise<{ workflowId: string; runId: string }> {
      assertRecord(request, ['workflowId', 'deploymentId', 'workflowType', 'input'], 'startRun request');
      for (const key of ['workflowId', 'deploymentId', 'workflowType'] as const) if (typeof request[key] !== 'string' || !request[key]) throw new TypeError(`Invalid ${key}`);
      assertJsonValue(request.input, DEFAULT_EXECUTION_LIMITS.inputBytes);
      request = JSON.parse(JSON.stringify(request)) as StartRunRequest;
      const deployment = await options.deployments.read(request.deploymentId);
      if (!deployment.workflowTypes.includes(request.workflowType)) throw new TypeError('Unknown workflow type for deployment');
      const fingerprint = sha256(canonicalJson({ version: 1, deploymentId: request.deploymentId, workflowType: request.workflowType, input: request.input }));
      try {
        const handle = await options.client.workflow.start(request.workflowType, {
          workflowId: request.workflowId, taskQueue: taskQueueFor(deployment), args: [request.input],
          workflowIdConflictPolicy: WorkflowIdConflictPolicy.FAIL,
          workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
          memo: { runsettRequest: { version: 1, fingerprint, deploymentId: request.deploymentId, workflowType: request.workflowType } },
        });
        return { workflowId: request.workflowId, runId: handle.firstExecutionRunId };
      } catch (error) {
        if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
        const handle = options.client.workflow.getHandle(request.workflowId, error.runId);
        const description = await handle.describe();
        const memo = description.memo?.runsettRequest as { version?: number; fingerprint?: string; deploymentId?: string; workflowType?: string } | undefined;
        if (description.type !== request.workflowType || memo?.version !== 1 || memo.fingerprint !== fingerprint || memo.deploymentId !== request.deploymentId || memo.workflowType !== request.workflowType) throw new RunConflictError('Workflow ID conflict: retained run does not match request identity');
        return { workflowId: request.workflowId, runId: description.runId };
      }
    },
    async cancelRun(workflowId: string): Promise<void> { await options.client.workflow.getHandle(workflowId).cancel(); },
  };
}
