import { Context } from '@temporalio/activity';
import { ApplicationFailure, CancelledFailure } from '@temporalio/common';
import { DEFAULT_EXECUTION_LIMITS, ExecutionError, type CodeResult, type JsonValue } from '@runsett/contracts';
import { defineBlock, validateBlockValue, type BlockDefinition } from '@runsett/sdk';
import type { StepRequest } from '@runsett/sdk/workflow';
import type { CodeExecutor } from '@runsett/runner';
import { assertRegisteredDeployment, type RegisteredDeployment } from './versioning.js';
import { canonicalJson, sha256 } from './storage.js';
export function createActivities(deployment: RegisteredDeployment, executeCode: CodeExecutor) {
  assertRegisteredDeployment(deployment);
  return {
    async executeStep(request: StepRequest): Promise<CodeResult> {
      const context = Context.current();
      const { info } = context;
      if (!info.workflowExecution) throw ApplicationFailure.nonRetryable('Workflow activity required', 'VALIDATION_ERROR');
      let block: BlockDefinition;
      try {
        block = defineBlock(request.block);
        if (request.deploymentId !== deployment.deploymentId || !deployment.blocks.some(allowed => canonicalJson(allowed as unknown as JsonValue) === canonicalJson(block as unknown as JsonValue))) throw new TypeError('Block is not registered for immutable deployment');
        validateBlockValue(block.inputSchema, request.input);
      } catch { throw ApplicationFailure.nonRetryable('Invalid deployment block or input schema', 'VALIDATION_ERROR'); }
      const operationKey = sha256(JSON.stringify(['runsett-operation-v1', info.workflowExecution.workflowId, info.workflowExecution.runId, deployment.deploymentId, request.stepId]));
      const identity = { ...info.workflowExecution, stepId: request.stepId, attempt: info.attempt, operationKey, deploymentId: deployment.deploymentId };
      const timer = setInterval(() => context.heartbeat(), 1000);
      try {
        const result = await executeCode({ identity, moduleId: block.moduleId, moduleHash: block.moduleHash, input: request.input, credentialBindings: block.credentialBindings, networkMode: block.networkMode, limits: DEFAULT_EXECUTION_LIMITS }, context.cancellationSignal);
        try { validateBlockValue(block.outputSchema, result.output); }
        catch { throw ApplicationFailure.nonRetryable('Result does not match block output schema', 'VALIDATION_ERROR'); }
        return result;
      } catch (error) {
        if (error instanceof ExecutionError) {
          if (error.code === 'CANCELLED') throw new CancelledFailure(error.message, [error.toJSON()]);
          // Retry permission belongs to the explicit block policy. Validation/cancellation stay terminal.
          throw ApplicationFailure.create({ message: error.message, type: error.code, nonRetryable: ['VALIDATION_ERROR', 'OUTPUT_LIMIT'].includes(error.code), details: [error.toJSON()] });
        }
        throw error;
      } finally { clearInterval(timer); }
    },
  };
}
