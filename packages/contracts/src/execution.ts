import { assertJsonValue, assertRecord, utf8ByteLength } from './json.js';
import type { JsonValue } from './json.js';
import { assertExecutionLimits, DEFAULT_EXECUTION_LIMITS } from './limits.js';
import type { ExecutionLimits } from './limits.js';

export interface ExecutionIdentity {
  workflowId: string;
  runId: string;
  stepId: string;
  attempt: number;
  operationKey: string;
  deploymentId: string;
}

export interface CodeInvocation {
  identity: ExecutionIdentity;
  moduleId: string;
  moduleHash: string;
  input: JsonValue;
  credentialBindings: string[];
  networkMode: 'none' | 'configured';
  limits: ExecutionLimits;
}

export interface DiagnosticRecord {
  stream: 'stdout' | 'stderr';
  message: string;
  timestamp: string;
}

export interface CodeResult {
  output: JsonValue;
  diagnostics: DiagnosticRecord[];
  moduleHash: string;
  startedAt: string;
  finishedAt: string;
}

function assertNonemptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a nonempty string`);
}

function assertTimestamp(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical ISO-8601 UTC timestamp`);
  }
}

export function assertExecutionIdentity(value: unknown): asserts value is ExecutionIdentity {
  const stringFields = ['workflowId', 'runId', 'stepId', 'operationKey', 'deploymentId'];
  assertRecord(value, [...stringFields, 'attempt'], 'identity');
  for (const key of stringFields) assertNonemptyString(value[key], `identity.${key}`);
  if (!Number.isSafeInteger(value.attempt) || (value.attempt as number) < 1) {
    throw new TypeError('identity.attempt must be a positive safe integer');
  }
}

export function assertCodeInvocation(value: unknown): asserts value is CodeInvocation {
  assertRecord(value, ['identity', 'moduleId', 'moduleHash', 'input', 'credentialBindings', 'networkMode', 'limits'], 'invocation');
  assertExecutionIdentity(value.identity);
  assertNonemptyString(value.moduleId, 'moduleId');
  assertNonemptyString(value.moduleHash, 'moduleHash');
  assertExecutionLimits(value.limits);
  assertJsonValue(value.input, value.limits.inputBytes);
  assertJsonValue(value.credentialBindings, Number.MAX_SAFE_INTEGER);
  if (!Array.isArray(value.credentialBindings)) throw new TypeError('credentialBindings must be an array');
  for (const binding of value.credentialBindings) assertNonemptyString(binding, 'credential binding');
  if (new Set(value.credentialBindings).size !== value.credentialBindings.length) throw new TypeError('credentialBindings must be unique');
  if (value.networkMode !== 'none' && value.networkMode !== 'configured') throw new TypeError('networkMode must be none or configured');
}

/** Bounds the sum of captured stdout/stderr message bytes, without truncation. */
export function assertDiagnostics(value: unknown, maxBytes = DEFAULT_EXECUTION_LIMITS.diagnosticBytes): asserts value is DiagnosticRecord[] {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new TypeError('Diagnostic byte limit must be a positive safe integer');
  if (!Array.isArray(value)) throw new TypeError('diagnostics must be an array');
  assertJsonValue(value, Number.MAX_SAFE_INTEGER);
  let bytes = 0;
  for (const record of value) {
    assertRecord(record, ['stream', 'message', 'timestamp'], 'diagnostic');
    if (record.stream !== 'stdout' && record.stream !== 'stderr') throw new TypeError('Invalid diagnostic stream');
    if (typeof record.message !== 'string') throw new TypeError('Diagnostic message must be a string');
    assertTimestamp(record.timestamp, 'diagnostic.timestamp');
    bytes += utf8ByteLength(record.message);
    if (bytes > maxBytes) throw new RangeError(`Combined diagnostics exceed ${maxBytes} bytes`);
  }
}

export function assertCodeResult(value: unknown, limits: ExecutionLimits = DEFAULT_EXECUTION_LIMITS): asserts value is CodeResult {
  assertExecutionLimits(limits);
  assertRecord(value, ['output', 'diagnostics', 'moduleHash', 'startedAt', 'finishedAt'], 'result');
  assertJsonValue(value.output, limits.resultBytes);
  assertDiagnostics(value.diagnostics, limits.diagnosticBytes);
  assertNonemptyString(value.moduleHash, 'moduleHash');
  assertTimestamp(value.startedAt, 'startedAt');
  assertTimestamp(value.finishedAt, 'finishedAt');
  if (value.finishedAt < value.startedAt) throw new TypeError('finishedAt cannot precede startedAt');
}
