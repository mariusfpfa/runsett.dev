import { inspectRun } from '@runsett/runtime';
import type { Options } from './options.js';
export async function inspect(context: Parameters<typeof inspectRun>[0], workflowId: string, options: Options) {
  return inspectRun(context, workflowId, { details: !!options.details, logs: !!options.logs,
    ...(options['max-events'] !== undefined ? { maxEvents: Number(options['max-events']) } : {}),
    ...(options['max-log-bytes'] !== undefined ? { maxLogBytes: Number(options['max-log-bytes']) } : {}),
  });
}
