import { defineWorkflow, mapItems, type JsonValue } from '@runsett/sdk/workflow';
import { operation } from './blocks.js';
export const example = defineWorkflow(async (input, context) => {
  const parameters = input as { items: JsonValue[]; waitMs: number };
  const first = await context.step('prepare', operation, { stage: 'prepare' });
  await context.sleep(parameters.waitMs);
  const items = await mapItems(parameters.items, { key: item => JSON.stringify(item), concurrency: 2 },
    (value, key) => context.step(`item:${key}`, operation, { value }));
  const last = await context.step('finish', operation, { stage: 'finish' });
  return { version: '1', first, items, last };
});
