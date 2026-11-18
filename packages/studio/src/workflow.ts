import { defineQuery, setHandler } from '@temporalio/workflow';
import { defineWorkflow } from '@runsett/sdk/workflow';
import { connectorBinding, connectorBlock, javaScriptBlock, visualBlock } from './block.js';
import type { RunInput } from './model.js';

export const studioWorkflow = defineWorkflow(async (input, context) => {
  const plan = input as RunInput & { moduleHash: string; connectorHash?: string };
  const block = visualBlock(plan.moduleHash);
  let value = plan.value;
  let completed = 0;
  setHandler(defineQuery<number>('studioCompletedSteps'), () => completed);
  for (const step of plan.steps) {
    if (step.kind === 'wait') await context.sleep(Number(step.setting) * 1000);
    else if (step.kind === 'javascript')
      value = await context.step(step.id, javaScriptBlock(step.setting), value);
    else if (step.kind === 'http' || step.kind === 'slack' || step.kind === 'teams') {
      if (!plan.connectorHash) throw new Error('The connector module is missing from this deployment.');
      const action = connectorBlock(plan.connectorHash, step.kind, connectorBinding(step.kind, step.setting));
      value = await context.step(step.id, action, { kind: step.kind, setting: step.setting, value });
    } else value = await context.step(step.id, block, { kind: step.kind, setting: step.setting, value });
    completed++;
  }
  return value;
});
