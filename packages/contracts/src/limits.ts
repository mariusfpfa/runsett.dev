import { assertRecord } from './json.js';

export interface ExecutionLimits {
  wallClockMs: number;
  memoryBytes: number;
  cpus: number;
  pids: number;
  inputBytes: number;
  resultBytes: number;
  diagnosticBytes: number;
  cancellationGraceMs: number;
}

export const DEFAULT_EXECUTION_LIMITS: Readonly<ExecutionLimits> = Object.freeze({
  wallClockMs: 30_000,
  memoryBytes: 256 * 1024 * 1024,
  cpus: 1,
  pids: 64,
  inputBytes: 1024 * 1024,
  resultBytes: 1024 * 1024,
  diagnosticBytes: 256 * 1024,
  cancellationGraceMs: 2_000,
});

export function assertExecutionLimits(value: unknown): asserts value is ExecutionLimits {
  assertRecord(value, Object.keys(DEFAULT_EXECUTION_LIMITS), 'limits');
  for (const key of Object.keys(DEFAULT_EXECUTION_LIMITS)) {
    const limit = value[key];
    if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0 ||
      (key !== 'cpus' && !Number.isSafeInteger(limit))) {
      throw new TypeError(`limits.${key} must be a positive ${key === 'cpus' ? 'finite number' : 'safe integer'}`);
    }
  }
}
