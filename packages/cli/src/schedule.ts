import type { createScheduleClient } from '@runsett/runtime';
import { readInput, required, type Options } from './options.js';
export async function schedule(schedules: ReturnType<typeof createScheduleClient>, action: string, positional: string[], options: Options) {
  if (action === 'pause' && positional.length === 1) return schedules.pause(positional[0]!);
  if (action !== 'create' || positional.length) throw new TypeError('Use schedule create or schedule pause ID');
  return schedules.create({ scheduleId: required(options, 'id'), deploymentId: required(options, 'deployment'), workflowType: required(options, 'workflow'), cron: required(options, 'cron'), input: await readInput(options), ...(options.timezone ? { timezone: required(options, 'timezone') } : {}) });
}
