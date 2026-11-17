import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, link, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { JsonValue } from '@runsett/contracts';
export function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`).join(',')}}`;
  return JSON.stringify(value);
}
export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
export async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
/** Acknowledge only after file and directory are synced. Local POSIX storage. */
export async function durableWrite(directory: string, filename: string, data: string, immutable = false): Promise<void> {
  directory = resolve(directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // Re-sync ancestors even after a previous attempt created them but failed its
  // fsync. A later successful acknowledgement must make that directory durable.
  let current = directory;
  while (true) {
    await syncDirectory(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
    if (immutable) await link(temporary, join(directory, filename));
    else await rename(temporary, join(directory, filename));
    await syncDirectory(directory);
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
