import { DEFAULT_EXECUTION_LIMITS, assertCodeInvocation, assertCodeResult, assertExecutionError, assertJsonValue, ExecutionError, type CodeInvocation, type CodeResult, type ExecutionErrorCode } from '@runsett/contracts';
import { randomUUID } from 'node:crypto';
import { ModuleRegistry } from './registry.js';
import { containerRuntime, reconcileContainers, type ContainerRecord, type ContainerRuntime } from './container.js';
import { BoundedChannel, DiagnosticDecoder, MAX_CREDENTIAL_BYTES, MAX_METADATA_BYTES, RUNNER_READY } from './protocol.js';
import { DiagnosticCollector, redact, redactJson } from './diagnostics.js';
import { InvocationLifetime, boundedCleanup } from './lifecycle.js';
export interface ExecutorOptions {
  registry: ModuleRegistry;
  credentials?: Readonly<Record<string, string>>;
  configuredNetwork?: string;
  scope?: string;
  reconciliationIntervalMs?: number;
  /** Must resolve only after durable recording. Failure retains Docker evidence. */
  onReconciliation?: (records: readonly ContainerRecord[]) => void | Promise<void>;
  runtime?: Partial<ContainerRuntime>;
}
export interface CodeExecutor {
  (invocation: CodeInvocation, signal?: AbortSignal): Promise<CodeResult>;
  close(): void;
  reconcile(): Promise<ContainerRecord[]>;
}
export function createCodeExecutor(options: ExecutorOptions): CodeExecutor {
  const { registry, configuredNetwork, onReconciliation } = options;
  const owner = randomUUID();
  const scope = options.scope ?? 'default';
  const credentials = Object.freeze({ ...options.credentials });
  const runtime = { ...containerRuntime, ...options.runtime };
  const active = new Set<string>();
  let closed = false;
  let reconciling: Promise<ContainerRecord[]> | undefined;
  const reconcile = () => reconciling ??= reconcileContainers(scope, Date.now(), { active, remove: runtime.remove, ...(onReconciliation ? { acknowledge: onReconciliation } : {}) }).finally(() => { reconciling = undefined; });
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
      module = registry.resolve(invocation.moduleId, invocation.moduleHash);
      if (invocation.networkMode === 'configured' && (!configuredNetwork || ['host', 'container'].some(value => configuredNetwork.startsWith(value)))) throw new TypeError('Outbound network not configured');
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
    const startedAt = new Date().toISOString();
    const lifetime = new InvocationLifetime(invocation.limits.wallClockMs, () => failure('CANCELLED', 'Execution cancelled; external effects may have occurred'), () => failure('TIMEOUT', 'Execution wall-clock deadline exceeded'), signal);
    const name = `runsett-${randomUUID()}`;
    let id: string | undefined;
    let creating = false;
    let settled = false;
    let inputDelivered = false;
    let termination: Promise<void> | undefined;
    const abort = () => {
      // Before readiness/input delivery there can be no user code. Force removal
      // in finally owns cleanup, avoiding a stop racing a delayed daemon start.
      if (id && inputDelivered) termination ??= runtime.terminate(id, invocation.limits.cancellationGraceMs).catch(() => undefined);
    };
    lifetime.signal.addEventListener('abort', abort, { once: true });
    try {
      await lifetime.wait(startup);
      lifetime.check();
      active.add(name);
      creating = true;
      const creation = runtime.create(invocation, module, scope, owner, invocation.networkMode === 'none' ? 'none' : configuredNetwork!, { name, deadline: lifetime.deadline, signal: lifetime.signal });
      // A daemon may complete an already-submitted create after local cancellation.
      // Its known name and original expiry remain recoverable even if the CLI dies.
      void creation.then(lateId => { if (settled) void runtime.remove(lateId).catch(() => undefined); }, () => undefined);
      id = await lifetime.wait(creation);
      active.add(id);
      lifetime.check();
      const child = await lifetime.wait(Promise.resolve(runtime.attach(id, lifetime.signal)));
      const output = new BoundedChannel(invocation.limits.resultBytes + 16 * 1024);
      const decoder = new DiagnosticDecoder((stream, data) => logs.push(stream, data));
      let readyBytes = 0;
      let ready!: () => void;
      const readiness = new Promise<void>(resolve => { ready = resolve; });
      const exited = new Promise<void>((resolve, reject) => {
        child.stdout.on('data', (chunk: Buffer) => {
          if (lifetime.signal.aborted) return;
          try {
            let offset = 0;
            while (readyBytes < RUNNER_READY.length && offset < chunk.length) {
              if (chunk[offset++] !== RUNNER_READY[readyBytes++]) throw new TypeError('Invalid container readiness protocol');
              if (readyBytes === RUNNER_READY.length) ready();
            }
            if (offset < chunk.length) output.push(chunk.subarray(offset));
          } catch (error) { lifetime.stop(failure(error instanceof RangeError ? 'OUTPUT_LIMIT' : 'INFRASTRUCTURE_ERROR', error instanceof Error ? error.message : 'Invalid result channel')); }
        });
        child.stderr.on('data', (chunk: Buffer) => {
          if (!lifetime.signal.aborted) try { decoder.push(chunk); }
          catch (error) { lifetime.stop(failure(error instanceof RangeError ? 'OUTPUT_LIMIT' : 'INFRASTRUCTURE_ERROR', error instanceof Error ? error.message : 'Invalid diagnostics')); }
        });
        child.on('error', reject);
        child.on('close', code => {
          if (readyBytes < RUNNER_READY.length) reject(new Error('Container attach closed before complete readiness protocol'));
          else if (code === 0) resolve();
          else reject(new Error(`Container attach exited ${code}`));
        });
      });
      // Observe failures even while the caller is waiting for readiness.
      exited.catch(error => lifetime.stop(failure('INFRASTRUCTURE_ERROR', error instanceof Error ? error.message : 'Attach failed')));
      child.stdin.on('error', () => undefined);
      await lifetime.wait(readiness);
      lifetime.check();
      inputDelivered = true;
      child.stdin.end(JSON.stringify({ invocation, path: module.path, credentials: selected }));
      await lifetime.wait(exited);
      lifetime.check();
      decoder.finish();
      const frame = JSON.parse(output.buffer().toString()) as { output?: unknown; error?: { code: ExecutionErrorCode; message: string; stack?: string } };
      if (frame.error) {
        const error = failure(frame.error.code, frame.error.message, frame.error.stack);
        assertExecutionError(error.toJSON());
        throw error;
      }
      const result: CodeResult = { output: frame.output as CodeResult['output'], moduleHash: invocation.moduleHash, startedAt, finishedAt: new Date().toISOString(), diagnostics: logs.finish() };
      assertCodeResult(result, invocation.limits);
      const redacted: CodeResult = { ...result, output: redactJson(result.output, secrets) };
      assertCodeResult(redacted, invocation.limits);
      return redacted;
    } catch (error) {
      if (lifetime.signal.aborted) throw lifetime.signal.reason;
      if (error instanceof ExecutionError) throw error;
      throw failure('INFRASTRUCTURE_ERROR', error instanceof Error ? error.message : 'Container infrastructure failed');
    } finally {
      settled = true;
      lifetime.close();
      lifetime.signal.removeEventListener('abort', abort);
      if (termination) await boundedCleanup(termination, invocation.limits.cancellationGraceMs + 500);
      if (creating) await boundedCleanup(runtime.remove(id ?? name).catch(() => undefined), 1000);
      // Inactive owned containers must be visible to subsequent cleanup retries.
      active.delete(name);
      if (id) active.delete(id);
    }
  };
  return Object.assign(execute, { close: () => { closed = true; clearInterval(timer); }, reconcile });
}
export async function executeCode(invocation: CodeInvocation, signal?: AbortSignal): Promise<CodeResult> {
  const executor = createCodeExecutor({ registry: new ModuleRegistry([]) });
  try { return await executor(invocation, signal); } finally { executor.close(); }
}
