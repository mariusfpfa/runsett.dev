import { opendir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { assertExecutionIdentity } from '@runsett/contracts';
import type { ContainerRecord } from '@runsett/runner';
/** Audit supplements engine history. Bounds include unrelated records in a shared directory. */
export async function inspectAudit(directory: string, workflowId: string, runId: string) {
  const records: { stepId: string; attempt: number; outcome: string; sideEffectOutcome: 'unknown' }[] = [];
  let scanned = 0;
  try {
    const entries = await opendir(directory);
    for await (const entry of entries) {
      if (++scanned > 1000) return { availability: 'partial', truncated: true, records };
      if (!/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
      const file = await open(join(directory, entry.name), 'r');
      try {
        if ((await file.stat()).size > 262_144) return { availability: 'partial', truncated: true, records };
        const bytes = Buffer.alloc(262_145); const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
        if (bytesRead > 262_144) return { availability: 'partial', truncated: true, records };
        const record = (JSON.parse(bytes.subarray(0, bytesRead).toString()) as { record: ContainerRecord }).record;
        assertExecutionIdentity(record.identity);
        if (!['unknown', 'terminated-unknown'].includes(record.outcome)) throw new Error('Invalid audit outcome');
        if (record.identity.workflowId === workflowId && record.identity.runId === runId) records.push({ stepId: record.identity.stepId, attempt: record.identity.attempt, outcome: record.outcome, sideEffectOutcome: 'unknown' });
      } finally { await file.close(); }
    }
    return { availability: 'available', truncated: false, records };
  } catch (error) {
    return { availability: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not-recorded' : 'unavailable', truncated: false, records };
  }
}
