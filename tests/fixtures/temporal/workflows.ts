import { defineWorkflow } from '@runsett/sdk/workflow';
import { operation, retryOperation } from '../../../examples/javascript/blocks.js';
export { example } from '../../../examples/javascript/workflow-v1.js';
export const oneStep = defineWorkflow((input, context) => context.step('operation', operation, input));
export const retryStep = defineWorkflow((input, context) => context.step('operation', retryOperation, input));
export const waiting = defineWorkflow(async (_input, context) => { await context.sleep(3_600_000); return null; });
export const invalidIteration = defineWorkflow(async (_input, context) => {
  const { mapItems } = await import('@runsett/sdk/workflow');
  await mapItems([1, 1], { concurrency: 2, key: String }, (value, key) => context.step(key, operation, { value }));
  return null;
});
