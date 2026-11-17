import type { createRunClient } from '@runsett/runtime';
export async function cancel(runs: ReturnType<typeof createRunClient>, workflowId: string) {
  await runs.cancelRun(workflowId); return { workflowId, cancellationRequested: true };
}
