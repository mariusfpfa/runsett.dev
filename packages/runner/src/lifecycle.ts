/** Bounds asynchronous setup as well as active execution with one abort source. */
export class InvocationLifetime {
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  readonly signal = this.controller.signal;
  readonly deadline: number;
  constructor(wallClockMs: number, private readonly cancelled: () => Error, timeout: () => Error, private readonly external?: AbortSignal) {
    this.deadline = Date.now() + wallClockMs;
    this.timer = setTimeout(() => this.stop(timeout()), wallClockMs);
    external?.addEventListener('abort', this.cancel, { once: true });
    if (external?.aborted) this.cancel();
  }
  private readonly cancel = () => this.stop(this.cancelled());
  stop(reason: Error): void { if (!this.signal.aborted) this.controller.abort(reason); }
  check(): void { this.signal.throwIfAborted(); }
  async wait<T>(operation: Promise<T>): Promise<T> {
    return await new Promise<T>((resolve, reject) => {
      const abort = () => reject(this.signal.reason);
      this.signal.addEventListener('abort', abort, { once: true });
      operation.then(resolve, reject).finally(() => this.signal.removeEventListener('abort', abort));
      if (this.signal.aborted) abort();
    });
  }
  close(): void { clearTimeout(this.timer); this.external?.removeEventListener('abort', this.cancel); }
}
/** Cleanup itself cannot leave a cancelled caller blocked on an unavailable daemon. */
export async function boundedCleanup(operation: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([operation, new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs); })]); }
  finally { if (timer) clearTimeout(timer); }
}
