import { readFileSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { assertCodeInvocation, assertJsonValue, type CodeInvocation } from '@runsett/contracts';
import { redact } from './diagnostics.js';
import { BoundedChannel, MAX_ENVELOPE_BYTES } from './protocol.js';

const abort = new AbortController();
process.on('SIGTERM', () => abort.abort());
let secrets: string[] = [];
try {
  const buffer = new BoundedChannel(MAX_ENVELOPE_BYTES);
  for await (const chunk of process.stdin) buffer.push(chunk as Buffer);
  const envelope = JSON.parse(buffer.buffer().toString()) as { invocation: CodeInvocation; path: string; credentials: Record<string, string> };
  const { invocation, path, credentials } = envelope;
  secrets = Object.values(credentials);
  assertCodeInvocation(invocation);
  if (createHash('sha256').update(readFileSync(path)).digest('hex') !== invocation.moduleHash) {
    writeSync(3, JSON.stringify({ error: { code: 'VALIDATION_ERROR', message: 'Immutable module content hash mismatch' } }));
  } else {
    const module = await import(pathToFileURL(path).href);
    if (typeof module.default !== 'function') throw new TypeError('Module must export a default function');
    const output: unknown = await module.default(invocation.input, Object.freeze({ operationKey: invocation.identity.operationKey, attempt: invocation.identity.attempt, signal: abort.signal, credentials: Object.freeze(credentials), log: (...args: unknown[]) => console.log(...args) }));
    try { assertJsonValue(output, invocation.limits.resultBytes); }
    catch (error) {
      writeSync(3, JSON.stringify({ error: { code: error instanceof RangeError ? 'OUTPUT_LIMIT' : 'RUNTIME_ERROR', message: error instanceof Error ? error.message : 'Unsupported output' } }));
      process.exit(0);
    }
    writeSync(3, JSON.stringify({ output }));
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  writeSync(3, JSON.stringify({ error: { code: 'RUNTIME_ERROR', message: redact(message, secrets).slice(0, 4096), stack: stack === undefined ? undefined : redact(stack, secrets).slice(0, 2000) } }));
}
// Open handles and spawned descendants cannot extend an invocation's lifetime.
process.exit(0);
