import { proxyActivities, sleep, workflowInfo, ActivityCancellationType, ApplicationFailure, TemporalFailure } from '@temporalio/workflow';
import { assertJsonValue, DEFAULT_EXECUTION_LIMITS, type CodeResult, type JsonValue } from '@runsett/contracts';
import { defineBlock, type BlockDefinition } from './block.js';
export { defineBlock } from './block.js';
export type { BlockDefinition, JsonSchema } from './block.js';
export { mapItems } from './iteration.js';
export type { JsonValue } from '@runsett/contracts';
export interface StepRequest { deploymentId: string; stepId: string; block: BlockDefinition; input: JsonValue }
export interface WorkflowContext {
  step(id: string, block: BlockDefinition, input: JsonValue): Promise<JsonValue>;
  sleep(milliseconds: number): Promise<void>;
}
/** Authors export the returned function under any declared Temporal workflow type.
 * Deployment identity is reserved memo from startRun, never caller arguments.
 */
export function defineWorkflow(handler: (input: JsonValue, context: WorkflowContext) => Promise<JsonValue>): (input: JsonValue) => Promise<JsonValue> {
  return async input => {
    try {
      assertJsonValue(input, DEFAULT_EXECUTION_LIMITS.inputBytes);
      const memo = workflowInfo().memo?.runsettRequest as { deploymentId?: string } | undefined;
      if (!memo?.deploymentId) throw new TypeError('Workflow requires Runsett deployment memo');
      const deploymentId = memo.deploymentId;
      const steps = new Set<string>();
      const context: WorkflowContext = {
        async step(id, definition, value) {
          if (typeof id !== 'string' || !id || steps.has(id)) throw new TypeError('Step IDs must be nonempty and unique within a run');
          const block = defineBlock(definition);
          assertJsonValue(value, DEFAULT_EXECUTION_LIMITS.inputBytes);
          steps.add(id);
          const activity = proxyActivities<{ executeStep(request: StepRequest): Promise<CodeResult> }>({
            activityId: id, startToCloseTimeout: '35s', heartbeatTimeout: '5s',
            cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
            retry: { maximumAttempts: block.maximumAttempts, initialInterval: '100ms', maximumInterval: '1s' },
          });
          return (await activity.executeStep({ deploymentId, stepId: id, block, input: value })).output;
        },
        async sleep(milliseconds) {
          if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) throw new TypeError('sleep requires nonnegative integer milliseconds');
          await sleep(milliseconds);
        },
      };
      const result = await handler(input, context);
      assertJsonValue(result, DEFAULT_EXECUTION_LIMITS.resultBytes);
      return result;
    } catch (error) {
      if (error instanceof TemporalFailure) throw error;
      throw ApplicationFailure.nonRetryable(error instanceof Error ? error.message : String(error), 'WORKFLOW_ERROR');
    }
  };
}
