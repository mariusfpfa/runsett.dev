import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertExecutionIdentity, assertJsonValue } from '@runsett/contracts';
import type { ContainerRecord } from '@runsett/runner';
import { durableWrite, sha256 } from './storage.js';
export class ReconciliationAudit {
  constructor(readonly directory: string) {}
  acknowledge = async (records: readonly ContainerRecord[]): Promise<void> => {
    for (const record of records) {
      assertExecutionIdentity(record.identity);
      assertJsonValue(record, 262_144);
      const key = sha256(JSON.stringify([record.identity.workflowId, record.containerId, record.outcome]));
      await durableWrite(this.directory, `${key}.json`, JSON.stringify({ version: 1, recordedAt: new Date().toISOString(), record }));
    }
  };
  async read(workflowId: string): Promise<ContainerRecord[]> {
    let names: string[];
    try { names = await readdir(this.directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const records = await Promise.all(names.filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(async name => {
      const envelope = JSON.parse(await readFile(join(this.directory, name), 'utf8')) as { record: ContainerRecord };
      assertExecutionIdentity(envelope.record.identity);
      return envelope.record;
    }));
    return records.filter(record => record.identity.workflowId === workflowId);
  }
}
