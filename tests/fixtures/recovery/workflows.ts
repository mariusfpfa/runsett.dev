import { defineWorkflow, mapItems } from '@runsett/sdk/workflow';
export function recoveryVersion(version: string) {
  return defineWorkflow(async (raw, context) => {
    const input = raw as any;
    if (input.beforeMs) await context.sleep(input.beforeMs);
    const first = await context.step('first', input.block, { url: input.url, tag: `${input.tag}:first`, hold: input.hold ?? false, holdAttempt: input.holdAttempt ?? 0, fail: input.fail ?? 0, mode: input.mode ?? "" });
    if (input.waitMs) await context.sleep(input.waitMs);
    if (input.second) await context.step('second', input.block, { url: input.url, tag: `${input.tag}:second` });
    return { version, first };
  });
}
export const recovery = recoveryVersion('1');
export const fanout = defineWorkflow(async (raw, context) => {
  const input = raw as any;
  return mapItems(input.items, { concurrency: input.concurrency, key: String }, (value, key) => context.step(`item:${key}`, input.block, { url: input.url, tag: `${input.tag}:${value}`, hold: true }));
});
