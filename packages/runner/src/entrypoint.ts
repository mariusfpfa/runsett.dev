import { spawn } from 'node:child_process';
import { BoundedChannel, diagnosticFrame, FRAME_BYTES, MAX_ENVELOPE_BYTES } from './protocol.js';

// This PID1 remains independent of the host supervisor and never imports user
// modules. Exiting PID1 causes Docker to terminate every namespace descendant.
const [deadline, grace, resultLimit, diagnosticLimit] = process.argv.slice(2).map(Number) as [number, number, number, number];
const child = spawn(process.execPath, ['/opt/runsett/runner/executor.js'], { stdio: ['pipe', 'pipe', 'pipe', 'pipe'], env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOSTNAME: process.env.HOSTNAME ?? 'runsett' } });
let stopping = false;
let finished = false;
let stopFrame: Buffer | undefined;
function finish(frame: Buffer): void {
  if (finished) return;
  finished = true;
  process.stderr.write('', () => process.stdout.end(frame, () => process.exit(0)));
}
function stop(code: 'TIMEOUT' | 'CANCELLED' | 'OUTPUT_LIMIT'): void {
  if (stopping) return;
  stopping = true;
  stopFrame = Buffer.from(JSON.stringify({ error: { code, message: code === 'TIMEOUT' ? 'Execution wall-clock deadline exceeded' : code === 'CANCELLED' ? 'Execution cancelled; external effects may have occurred' : 'Execution output limit exceeded' } }));
  child.kill('SIGTERM');
  setTimeout(() => finish(stopFrame!), grace);
}
process.on('SIGTERM', () => stop('CANCELLED'));
setTimeout(() => stop('TIMEOUT'), Math.max(0, deadline - Date.now()));
const input = new BoundedChannel(MAX_ENVELOPE_BYTES);
process.stdin.on('data', chunk => { try { input.push(chunk); } catch { stop('OUTPUT_LIMIT'); } });
process.stdin.on('end', () => { if (!stopping) child.stdin.end(input.buffer()); });
child.stdin.on('error', () => undefined);
let diagnosticBytes = 0;
for (const [stream, pipe] of [['stdout', child.stdout], ['stderr', child.stderr]] as const) {
  pipe!.on('data', (data: Buffer) => {
    if (stopping) return;
    diagnosticBytes += data.length;
    if (diagnosticBytes > diagnosticLimit) { stop('OUTPUT_LIMIT'); return; }
    for (let i = 0; i < data.length; i += FRAME_BYTES) process.stderr.write(diagnosticFrame(stream, data.subarray(i, i + FRAME_BYTES)));
  });
}
const result = new BoundedChannel(resultLimit + 16 * 1024);
child.stdio[3]!.on('data', (chunk: Buffer) => { if (!stopping) { try { result.push(chunk); } catch { stop('OUTPUT_LIMIT'); } } });
child.on('error', () => finish(Buffer.from(JSON.stringify({ error: { code: 'INFRASTRUCTURE_ERROR', message: 'Could not start module executor' } }))));
child.on('close', code => {
  if (stopping) { finish(stopFrame!); return; }
  if (result.bytes) finish(result.buffer());
  else finish(Buffer.from(JSON.stringify({ error: { code: 'RESOURCE_LIMIT', message: `Executor terminated without result (exit ${code})` } })));
});
