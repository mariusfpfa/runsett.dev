import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { CodeInvocation } from '@runsett/contracts';
import type { RegisteredModule } from './registry.js';
import { BoundedChannel } from './protocol.js';

export async function docker(args: readonly string[]): Promise<string> {
  const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout = new BoundedChannel(1024 * 1024);
  const stderr = new BoundedChannel(8192);
  return await new Promise((resolve, reject) => {
    let error: unknown;
    const capture = (channel: BoundedChannel, chunk: Buffer) => { try { channel.push(chunk); } catch (cause) { error = cause; child.kill(); } };
    child.stdout.on('data', chunk => capture(stdout, chunk));
    child.stderr.on('data', chunk => capture(stderr, chunk));
    child.on('error', reject);
    child.on('close', code => error ? reject(error) : code === 0 ? resolve(stdout.buffer().toString().trim()) : reject(new Error(`Docker command failed: ${stderr.buffer().toString().slice(0, 4096)}`)));
  });
}
export interface ContainerRecord {
  containerId: string;
  identity: CodeInvocation['identity'];
  expiresAt: number;
  outcome: 'unknown' | 'terminated-unknown';
}
export async function createContainer(invocation: CodeInvocation, module: RegisteredModule, scope: string, owner: string, network: string): Promise<string> {
  const expiresAt = Date.now() + invocation.limits.wallClockMs + invocation.limits.cancellationGraceMs;
  const labels = { 'runsett.managed': 'true', 'runsett.scope': scope, 'runsett.owner': owner, 'runsett.expiresAt': String(expiresAt), ...Object.fromEntries(Object.entries(invocation.identity).map(([key, value]) => [`runsett.${key}`, String(value)])) };
  return await docker(['create', '--name', `runsett-${randomUUID()}`, '-i', '--user', '1000:1000', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--network', network,
    '--memory', String(invocation.limits.memoryBytes), '--memory-swap', String(invocation.limits.memoryBytes), '--cpus', String(invocation.limits.cpus), '--pids-limit', String(invocation.limits.pids),
    '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=16777216,mode=1777', '--log-driver', 'none', '--stop-timeout', String(Math.ceil(invocation.limits.cancellationGraceMs / 1000)),
    ...Object.entries(labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]), module.image,
    String(expiresAt - invocation.limits.cancellationGraceMs), String(invocation.limits.cancellationGraceMs), String(invocation.limits.resultBytes), String(invocation.limits.diagnosticBytes)]);
}
export function attachContainer(id: string): ChildProcessWithoutNullStreams {
  return spawn('docker', ['start', '-a', '-i', id], { stdio: ['pipe', 'pipe', 'pipe'] });
}
export async function terminateContainer(id: string, graceMs: number): Promise<void> {
  // stop targets container PID1; its independent watchdog sends SIGTERM to the
  // executor then exits. Docker kills all remaining namespace descendants.
  try { await docker(['stop', '--time', String(Math.ceil(graceMs / 1000)), id]); } catch { await docker(['kill', id]).catch(() => undefined); }
}
export async function removeContainer(id: string): Promise<void> { await docker(['rm', '-f', id]); }
export async function reconcileContainers(scope: string, now = Date.now(), owner?: string): Promise<ContainerRecord[]> {
  const ids = (await docker(['ps', '-aq', '--filter', 'label=runsett.managed=true', '--filter', `label=runsett.scope=${scope}`])).split('\n').filter(Boolean);
  const records: ContainerRecord[] = [];
  for (const id of ids) {
    let info: { Id: string; Config: { Labels: Record<string, string> }; State: { Running: boolean; Status: string } };
    try { [info] = JSON.parse(await docker(['inspect', id])); } catch { continue; }
    const labels = info!.Config.Labels;
    if (owner && labels['runsett.owner'] === owner) continue;
    const expiresAt = Number(labels['runsett.expiresAt']);
    const expired = !Number.isFinite(expiresAt) || expiresAt <= now;
    const terminated = ['exited', 'dead'].includes(info!.State.Status);
    const identity = { workflowId: labels['runsett.workflowId']!, runId: labels['runsett.runId']!, stepId: labels['runsett.stepId']!, attempt: Number(labels['runsett.attempt']), operationKey: labels['runsett.operationKey']!, deploymentId: labels['runsett.deploymentId']! };
    records.push({ containerId: info!.Id, identity, expiresAt, outcome: expired || terminated ? 'terminated-unknown' : 'unknown' });
    if (expired || terminated) await removeContainer(id).catch(() => undefined);
  }
  return records;
}
