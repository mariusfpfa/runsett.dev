import { assertRecord, utf8ByteLength } from './json.js';
import { assertDiagnostics } from './execution.js';
import type { DiagnosticRecord } from './execution.js';

export const EXECUTION_ERROR_CODES = Object.freeze([
  'VALIDATION_ERROR', 'RUNTIME_ERROR', 'TIMEOUT', 'CANCELLED',
  'RESOURCE_LIMIT', 'OUTPUT_LIMIT', 'INFRASTRUCTURE_ERROR',
] as const);
export type ExecutionErrorCode = typeof EXECUTION_ERROR_CODES[number];
export const MAX_ERROR_STACK_BYTES = 8192;

export interface ExecutionErrorData {
  code: ExecutionErrorCode;
  message: string;
  stack?: string;
  retryable: boolean;
  diagnostics: DiagnosticRecord[];
}

/** Validates the plain, serializable representation, rather than Error instances. */
export function assertExecutionError(value: unknown): asserts value is ExecutionErrorData {
  assertRecord(value, ['code', 'message', 'stack', 'retryable', 'diagnostics'], 'execution error');
  if (!EXECUTION_ERROR_CODES.includes(value.code as ExecutionErrorCode)) throw new TypeError(`Unknown execution error code: ${String(value.code)}`);
  if (typeof value.message !== 'string') throw new TypeError('Execution error message must be a string');
  if (typeof value.retryable !== 'boolean') throw new TypeError('Execution error retryable must be boolean');
  if (Object.hasOwn(value, 'stack') && (typeof value.stack !== 'string' || utf8ByteLength(value.stack) > MAX_ERROR_STACK_BYTES)) {
    throw new TypeError(`Execution error stack must be a string of at most ${MAX_ERROR_STACK_BYTES} UTF-8 bytes`);
  }
  assertDiagnostics(value.diagnostics);
}

export class ExecutionError extends Error implements ExecutionErrorData {
  readonly code: ExecutionErrorCode;
  readonly retryable: boolean;
  readonly diagnostics: DiagnosticRecord[];

  constructor(data: ExecutionErrorData) {
    assertExecutionError(data);
    super(data.message);
    this.name = 'ExecutionError';
    this.code = data.code;
    this.retryable = data.retryable;
    this.diagnostics = data.diagnostics.map((record) => ({ ...record }));
    // Do not serialize the host-generated stack or grow an already bounded stack.
    if (data.stack !== undefined) this.stack = data.stack;
    else delete this.stack;
  }

  toJSON(): ExecutionErrorData {
    return {
      code: this.code,
      message: this.message,
      ...(this.stack === undefined ? {} : { stack: this.stack }),
      retryable: this.retryable,
      diagnostics: this.diagnostics.map((record) => ({ ...record })),
    };
  }
}
