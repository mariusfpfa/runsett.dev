import { Client, WorkflowExecutionAlreadyStartedError, WorkflowIdConflictPolicy, WorkflowIdReusePolicy } from '@temporalio/client';
import { assertJsonValue, assertRecord, DEFAULT_EXECUTION_LIMITS, type JsonValue } from '@runsett/contracts';
import { DeploymentRegistry, taskQueueFor } from './versioning.js';
import { createRequestIdentity, readRequestIdentity } from './request-identity.js';
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
      const identity = createRequestIdentity(deployment, request.workflowType, request.input);
      try {
        const handle = await options.client.workflow.start(request.workflowType, {
          workflowId: request.workflowId, taskQueue: taskQueueFor(deployment), args: [request.input],
          workflowIdConflictPolicy: WorkflowIdConflictPolicy.FAIL,
          workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
          memo: { runsettRequest: identity },
        });
        return { workflowId: request.workflowId, runId: handle.firstExecutionRunId };
      } catch (error) {
        if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
        const handle = options.client.workflow.getHandle(request.workflowId, error.runId);
        const description = await handle.describe();
        const memo = readRequestIdentity(description.memo?.runsettRequest);
        if (!memo) throw new RunConflictError('Workflow ID conflict: retained run has unsupported deployment identity metadata');
        if (description.type !== request.workflowType || memo.fingerprint !== identity.fingerprint || memo.deploymentFingerprint !== deployment.fingerprint || memo.deploymentId !== request.deploymentId || memo.workflowType !== request.workflowType) throw new RunConflictError('Workflow ID conflict: retained run does not match request identity');
        return { workflowId: request.workflowId, runId: description.runId };
      }
    },
    async cancelRun(workflowId: string): Promise<void> { await options.client.workflow.getHandle(workflowId).cancel(); },
  };
}
