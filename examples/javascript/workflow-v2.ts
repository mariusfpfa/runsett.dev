import { defineWorkflow, mapItems, type JsonValue } from '@runsett/sdk/workflow';
import { operation } from './blocks.js';
export const example = defineWorkflow(async (input, context) => {
  const parameters = input as { items: JsonValue[]; waitMs: number };
  const first = await context.step('prepare-v2', operation, { stage: 'prepare', version: '2' });
  await context.sleep(parameters.waitMs);
  const items = await mapItems(parameters.items, { key: item => JSON.stringify(item), concurrency: 3 },
    (value, key) => context.step(`item:${key}`, operation, { value }));
  const last = await context.step('finish-v2', operation, { stage: 'finish', version: '2' });
  return { version: '2', first, items, last };
});
