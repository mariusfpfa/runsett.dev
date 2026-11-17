import { type DiagnosticRecord, type JsonValue } from '@runsett/contracts';
import { BoundedChannel } from './protocol.js';
export function redact(text: string, secrets: readonly string[]): string {
  for (const secret of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) text = text.split(secret).join('[REDACTED]');
  return text;
}
export class DiagnosticCollector {
  private readonly channels = { stdout: new BoundedChannel(Number.MAX_SAFE_INTEGER), stderr: new BoundedChannel(Number.MAX_SAFE_INTEGER) };
  private bytes = 0;
  constructor(private readonly limit: number, private readonly secrets: readonly string[]) {}
  push(stream: 'stdout' | 'stderr', chunk: Buffer): void {
    if (this.bytes + chunk.length > this.limit) throw new RangeError('Combined diagnostic limit exceeded');
    this.bytes += chunk.length;
    this.channels[stream].push(chunk);
  }
  finish(): DiagnosticRecord[] {
    const records: DiagnosticRecord[] = [];
    let remaining = this.limit;
    for (const stream of ['stdout', 'stderr'] as const) {
      if (!this.channels[stream].bytes) continue;
      // Redaction may expand a short credential. Rebound the final messages.
      let text = redact(this.channels[stream].buffer().toString('utf8'), this.secrets);
      while (Buffer.byteLength(text) > remaining) text = text.slice(0, Math.max(0, Math.floor(text.length * remaining / Buffer.byteLength(text))));
      remaining -= Buffer.byteLength(text);
      records.push({ stream, message: text, timestamp: new Date().toISOString() });
    }
    return records;
  }
}

export function redactJson(value: JsonValue, secrets: readonly string[]): JsonValue {
  if (typeof value === 'string') return redact(value, secrets);
  if (Array.isArray(value)) return value.map(item => redactJson(item, secrets));
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key, secrets), redactJson(item, secrets)]));
  return value;
}
