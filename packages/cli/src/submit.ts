import type { createRunClient } from '@runsett/runtime';
import { readInput, required, type Options } from './options.js';
export async function submit(runs: ReturnType<typeof createRunClient>, options: Options) {
  return runs.startRun({ workflowId: required(options, 'id'), deploymentId: required(options, 'deployment'), workflowType: required(options, 'workflow'), input: await readInput(options) });
}
