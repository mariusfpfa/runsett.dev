import { open } from 'node:fs/promises';
import { DEFAULT_EXECUTION_LIMITS, assertJsonValue, type JsonValue } from '@runsett/contracts';
export type Options = Record<string, string | boolean>;
export function parseOptions(args: string[], allowed: string[]) {
  const options: Options = {}; const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const key = arg.slice(2);
    if (!allowed.includes(key) || Object.hasOwn(options, key)) throw new TypeError('Unknown or duplicate option');
    if (['json', 'details', 'logs'].includes(key)) options[key] = true;
    else { const value = args[++i]; if (!value || value.startsWith('--')) throw new TypeError('Option requires a value'); options[key] = value; }
  }
  return { options, positional };
}
export function required(options: Options, name: string): string {
  const value = options[name]; if (typeof value !== 'string' || !value) throw new TypeError(`--${name} is required`); return value;
}
export async function readInput(options: Options): Promise<JsonValue> {
  if (options.input !== undefined && options['input-file'] !== undefined) throw new TypeError('Choose --input or --input-file');
  let source = '{}';
  if (options['input-file'] !== undefined) {
    const file = await open(required(options, 'input-file'), 'r');
    try {
      const bytes = Buffer.alloc(DEFAULT_EXECUTION_LIMITS.inputBytes + 1);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead > DEFAULT_EXECUTION_LIMITS.inputBytes) throw new RangeError('Input exceeds 1 MiB');
      source = bytes.subarray(0, bytesRead).toString('utf8');
    } finally { await file.close(); }
  } else if (options.input !== undefined) source = required(options, 'input');
  if (Buffer.byteLength(source) > DEFAULT_EXECUTION_LIMITS.inputBytes) throw new RangeError('Input exceeds 1 MiB');
  const input: unknown = JSON.parse(source); assertJsonValue(input, DEFAULT_EXECUTION_LIMITS.inputBytes); return input;
}
