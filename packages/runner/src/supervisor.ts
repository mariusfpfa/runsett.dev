import { DEFAULT_EXECUTION_LIMITS, assertCodeInvocation, assertCodeResult, assertExecutionError, assertJsonValue, ExecutionError, type CodeInvocation, type CodeResult, type ExecutionErrorCode } from '@runsett/contracts';
import { randomUUID } from 'node:crypto';
import { ModuleRegistry } from './registry.js';
import { attachContainer, createContainer, reconcileContainers, removeContainer, terminateContainer, type ContainerRecord } from './container.js';
import { BoundedChannel, DiagnosticDecoder, MAX_CREDENTIAL_BYTES, MAX_METADATA_BYTES } from './protocol.js';
import { DiagnosticCollector, redact, redactJson } from './diagnostics.js';
export interface ExecutorOptions {
  registry: ModuleRegistry;
  credentials?: Readonly<Record<string, string>>;
  configuredNetwork?: string;
  scope?: string;
  reconciliationIntervalMs?: number;
  /** Persist these records outside the runner; unknown never implies no effects. */
  onReconciliation?: (records: readonly ContainerRecord[]) => void | Promise<void>;
}
export interface CodeExecutor {
  (invocation: CodeInvocation, signal?: AbortSignal): Promise<CodeResult>;
  close(): void;
  reconcile(): Promise<ContainerRecord[]>;
}
export function createCodeExecutor(options: ExecutorOptions): CodeExecutor {
  const owner = randomUUID();
  const scope = options.scope ?? 'default';
  const credentials = Object.freeze({ ...options.credentials });
  let closed = false;
  let reconciling: Promise<ContainerRecord[]> | undefined;
  const reconcile = () => reconciling ??= reconcileContainers(scope, Date.now(), owner).then(async records => { await options.onReconciliation?.(records); return records; }).finally(() => { reconciling = undefined; });
  const startup = reconcile();
  startup.catch(() => undefined);
  const timer = setInterval(() => { if (!closed) void reconcile().catch(() => undefined); }, options.reconciliationIntervalMs ?? 1000);
  timer.unref();
  const execute = async (invocation: CodeInvocation, signal?: AbortSignal): Promise<CodeResult> => {
    const selected: Record<string, string> = Object.create(null);
    let module;
    try {
      if (closed) throw new TypeError('Executor is closed');
      assertCodeInvocation(invocation);
      for (const key of Object.keys(DEFAULT_EXECUTION_LIMITS) as (keyof typeof DEFAULT_EXECUTION_LIMITS)[]) {
        if (invocation.limits[key] > DEFAULT_EXECUTION_LIMITS[key]) throw new TypeError(`Execution limit ${key} exceeds approved maximum`);
      }
      module = options.registry.resolve(invocation.moduleId, invocation.moduleHash);
      if (invocation.networkMode === 'configured' && (!options.configuredNetwork || ['host', 'container'].some(value => options.configuredNetwork!.startsWith(value)))) throw new TypeError('Outbound network not configured');
      for (const binding of invocation.credentialBindings) {
        if (!Object.hasOwn(credentials, binding) || !credentials[binding]) throw new TypeError('Unknown credential binding');
        selected[binding] = credentials[binding]!;
      }
      assertJsonValue(selected, MAX_CREDENTIAL_BYTES);
      assertJsonValue({ ...invocation, input: null, limits: invocation.limits }, MAX_METADATA_BYTES - 1024);
    } catch (error) { throw new ExecutionError({ code: 'VALIDATION_ERROR', message: error instanceof Error ? error.message : 'Invalid invocation', retryable: false, diagnostics: [] }); }
    const secrets = Object.values(selected);
    const logs = new DiagnosticCollector(invocation.limits.diagnosticBytes, secrets);
    const failure = (code: ExecutionErrorCode, message: string, stack?: string) => new ExecutionError({ code, message: redact(message, secrets), retryable: false, diagnostics: logs.finish(), ...(stack === undefined ? {} : { stack: redact(stack, secrets).slice(0, 2048) }) });
    if (signal?.aborted) throw failure('CANCELLED', 'Invocation cancelled before container start');
    const startedAt = new Date().toISOString();
    let id: string | undefined;
    try {
      await startup;
      id = await createContainer(invocation, module, scope, owner, invocation.networkMode === 'none' ? 'none' : options.configuredNetwork!);
      const containerId = id;
      const child = attachContainer(id);
      const output = new BoundedChannel(invocation.limits.resultBytes + 16 * 1024);
      const decoder = new DiagnosticDecoder((stream, data) => logs.push(stream, data));
      let forced: ExecutionError | undefined;
      let termination: Promise<void> | undefined;
      const stop = (code: ExecutionErrorCode, message: string) => {
        forced ??= failure(code, message);
        termination ??= terminateContainer(containerId, invocation.limits.cancellationGraceMs);
      };
      const cancel = () => stop('CANCELLED', 'Execution cancelled; external effects may have occurred');
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      const timeout = setTimeout(() => stop('TIMEOUT', 'Execution wall-clock deadline exceeded'), Math.max(0, Date.parse(startedAt) + invocation.limits.wallClockMs - Date.now()));
      child.stdin.on('error', () => undefined);
      child.stdin.end(JSON.stringify({ invocation, path: module.path, credentials: selected }));
      try {
        await new Promise<void>((resolve, reject) => {
          child.stdout.on('data', (chunk: Buffer) => { if (!forced) try { output.push(chunk); } catch { stop('OUTPUT_LIMIT', 'Result channel limit exceeded'); } });
          child.stderr.on('data', (chunk: Buffer) => { if (!forced) try { decoder.push(chunk); } catch (error) { stop(error instanceof RangeError ? 'OUTPUT_LIMIT' : 'INFRASTRUCTURE_ERROR', error instanceof Error ? error.message : 'Invalid diagnostics'); } });
          child.on('error', reject);
          child.on('close', code => code === 0 || forced ? resolve() : reject(new Error(`Container attach exited ${code}`)));
        });
        await termination;
        if (forced) throw forced;
        decoder.finish();
        const frame = JSON.parse(output.buffer().toString()) as { output?: unknown; error?: { code: ExecutionErrorCode; message: string; stack?: string } };
        if (frame.error) {
          const error = failure(frame.error.code, frame.error.message, frame.error.stack);
          assertExecutionError(error.toJSON());
          throw error;
        }
        const result: CodeResult = { output: frame.output as CodeResult['output'], moduleHash: invocation.moduleHash, startedAt, finishedAt: new Date().toISOString(), diagnostics: logs.finish() };
        assertCodeResult(result, invocation.limits);
        // Bound literal credentials are redacted from all persisted result fields.
        const redacted: CodeResult = { ...result, output: redactJson(result.output, secrets) };
        assertCodeResult(redacted, invocation.limits);
        return redacted;
      } finally { clearTimeout(timeout); signal?.removeEventListener('abort', cancel); }
    } catch (error) {
      if (error instanceof ExecutionError) throw error;
      throw failure('INFRASTRUCTURE_ERROR', error instanceof Error ? error.message : 'Container infrastructure failed');
    } finally { if (id) await removeContainer(id).catch(() => undefined); }
  };
  return Object.assign(execute, { close: () => { closed = true; clearInterval(timer); }, reconcile });
}
/** Empty by default: deployments must explicitly construct their immutable registry. */
export async function executeCode(invocation: CodeInvocation, signal?: AbortSignal): Promise<CodeResult> {
  const executor = createCodeExecutor({ registry: new ModuleRegistry([]) });
  try { return await executor(invocation, signal); } finally { executor.close(); }
}
