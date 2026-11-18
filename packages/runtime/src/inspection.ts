import { Client } from '@temporalio/client';
import { defaultPayloadConverter } from '@temporalio/common';
import type { temporal } from '@temporalio/proto';
import { DeploymentRegistry } from './versioning.js';
import { inspectAudit } from './inspection-audit.js';
import { readRequestIdentity } from './request-identity.js';
type Payloads = temporal.api.common.v1.IPayloads | null | undefined;
type Failure = temporal.api.failure.v1.IFailure | null | undefined;
type Event = temporal.api.history.v1.IHistoryEvent;
export interface InspectionOptions {
  details?: boolean; logs?: boolean; maxEvents?: number; maxLogBytes?: number;
  runId?: string;
  /** Reserve the detail budget for one step, or use null for the final workflow output. */
  outputStepId?: string | null;
}
export interface InspectionStep {
  stepId: string; scheduledEventId: string; inputRef: string; moduleHash?: string; state: string;
  observedAttempts: number[]; attemptHistory: 'incomplete'; outputRef?: string; output?: unknown; input?: unknown;
  error?: { code: string; message?: string }; diagnostics?: unknown[];
}
function decode(payloads: Payloads): any { return payloads?.payloads?.[0] ? defaultPayloadConverter.fromPayload(payloads.payloads[0]) : undefined; }
function id(value: unknown) { return String(value ?? ''); }
function timestamp(value: { seconds?: unknown; nanos?: number | null } | null | undefined) {
  return value?.seconds == null ? undefined : new Date(Number(value.seconds) * 1000 + (value.nanos ?? 0) / 1e6).toISOString();
}
export async function inspectRun(options: { client: Client; deployments: DeploymentRegistry; auditDirectory: string }, workflowId: string, settings: InspectionOptions = {}) {
  const maxEvents = settings.maxEvents ?? 200; const maxLogBytes = settings.maxLogBytes ?? 65_536;
  if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > 1000) throw new TypeError('maxEvents must be between 1 and 1000');
  if (!Number.isSafeInteger(maxLogBytes) || maxLogBytes < 1 || maxLogBytes > 262_144) throw new TypeError('maxLogBytes must be between 1 and 262144');
  const description = await options.client.workflow.getHandle(workflowId, settings.runId).describe();
  const rawMemo = description.memo?.runsettRequest as { deploymentId?: unknown } | undefined;
  const memo = readRequestIdentity(rawMemo);
  let deployment: { deploymentId?: string; version?: string; fingerprint?: string; availability: string } = {
    ...(typeof rawMemo?.deploymentId === 'string' ? { deploymentId: rawMemo.deploymentId } : {}), availability: 'unsupported',
  };
  if (memo) {
    deployment = { deploymentId: memo.deploymentId, fingerprint: memo.deploymentFingerprint, availability: 'missing' };
    try {
      const stored = await options.deployments.read(memo.deploymentId);
      if (stored.fingerprint === memo.deploymentFingerprint) { deployment.version = stored.version; deployment.availability = 'available'; }
      else deployment.availability = 'mismatch';
    }
    catch (error) { deployment.availability = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unavailable'; }
  }
  const steps = new Map<string, InspectionStep>(); const timers = new Map<string, string | undefined>();
  let eventsRead = 0; let historyBytes = 0; let logBytes = 0; let detailBytes = 0; let logsTruncated = false; let detailsTruncated = false;
  let historyAvailability = 'available'; let truncated = false; let nextPageToken: Uint8Array = new Uint8Array();
  let output: unknown; let outputRef: string | undefined; let error: { code: string; message?: string } | undefined; let inputRef: string | undefined; let input: unknown;
  let intendedAt: string | undefined;
  function detail(value: unknown, outputStepId?: string | null) {
    if (!settings.details || value === undefined || (settings.outputStepId !== undefined && settings.outputStepId !== outputStepId)) return undefined;
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (detailBytes + bytes > 2_097_152) { detailsTruncated = true; return undefined; }
    detailBytes += bytes; return value;
  }
  function logs(value: any): unknown[] | undefined {
    if (!settings.logs || !Array.isArray(value)) return undefined;
    const result: unknown[] = [];
    for (const record of value) {
      if (!record || typeof record.message !== 'string') continue;
      const bytes = Buffer.byteLength(JSON.stringify(record));
      if (bytes + logBytes > maxLogBytes) { logsTruncated = true; continue; }
      logBytes += bytes; result.push(record);
    }
    return result;
  }
  function failure(value: Failure, includeDiagnostics = true): { error: { code: string; message?: string }; diagnostics?: unknown[] } {
    let current = value; let depth = 0;
    while (current?.cause && ++depth < 16) current = current.cause;
    const data = decode(current?.applicationFailureInfo?.details ?? current?.canceledFailureInfo?.details);
    const code = data?.code ?? current?.applicationFailureInfo?.type ?? (current?.canceledFailureInfo ? 'CANCELLED' : current?.timeoutFailureInfo ? 'TIMEOUT' : 'UNKNOWN');
    const diagnostics = includeDiagnostics ? logs(data?.diagnostics) : undefined;
    return { error: { code, ...(settings.details ? { message: String(data?.message ?? current?.message ?? '').slice(0, 8192) } : {}) }, ...(diagnostics ? { diagnostics } : {}) };
  }
  function observe(event: Event) {
    const eventId = id(event.eventId);
    const start = event.workflowExecutionStartedEventAttributes;
    if (start) {
      inputRef = `history:${eventId}:input`; input = detail(decode(start.input));
      const scheduled = start.searchAttributes?.indexedFields?.TemporalScheduledStartTime;
      if (scheduled) { const value = defaultPayloadConverter.fromPayload(scheduled); if (typeof value === 'string') intendedAt = value; }
    }
    const scheduled = event.activityTaskScheduledEventAttributes;
    if (scheduled) {
      const request = decode(scheduled.input);
      const step: InspectionStep = { stepId: scheduled.activityId ?? '', scheduledEventId: eventId, inputRef: `history:${eventId}:input`, state: 'SCHEDULED', observedAttempts: [], attemptHistory: 'incomplete' };
      if (request?.block?.moduleHash) step.moduleHash = request.block.moduleHash;
      const value = detail(request?.input); if (value !== undefined) step.input = value;
      steps.set(eventId, step);
    }
    const started = event.activityTaskStartedEventAttributes;
    if (started) { const step = steps.get(id(started.scheduledEventId)); if (step) { step.state = 'STARTED'; if (started.attempt) step.observedAttempts.push(started.attempt); } }
    const completed = event.activityTaskCompletedEventAttributes;
    if (completed) {
      const step = steps.get(id(completed.scheduledEventId));
      if (step) { const result = decode(completed.result); step.state = 'COMPLETED'; step.outputRef = `history:${eventId}:result`; const value = detail(result?.output, step.stepId); if (value !== undefined) step.output = value; const diagnostics = logs(result?.diagnostics); if (diagnostics) step.diagnostics = diagnostics; }
    }
    const failed = event.activityTaskFailedEventAttributes ?? event.activityTaskTimedOutEventAttributes;
    if (failed) { const step = steps.get(id(failed.scheduledEventId)); if (step) { step.state = event.activityTaskTimedOutEventAttributes ? 'TIMED_OUT' : 'FAILED'; Object.assign(step, failure(failed.failure)); } }
    const cancelled = event.activityTaskCanceledEventAttributes;
    if (cancelled) { const step = steps.get(id(cancelled.scheduledEventId)); if (step) { step.state = 'CANCELLED'; const data = decode(cancelled.details); step.error = { code: 'CANCELLED' }; const diagnostics = logs(data?.diagnostics); if (diagnostics) step.diagnostics = diagnostics; } }
    if (event.timerStartedEventAttributes) timers.set(event.timerStartedEventAttributes.timerId ?? '', timestamp(event.eventTime));
    const endedTimer = event.timerFiredEventAttributes ?? event.timerCanceledEventAttributes;
    if (endedTimer) timers.delete(endedTimer.timerId ?? '');
    if (event.workflowExecutionCompletedEventAttributes) { outputRef = `history:${eventId}:result`; output = detail(decode(event.workflowExecutionCompletedEventAttributes.result), null); }
    if (event.workflowExecutionFailedEventAttributes) error = failure(event.workflowExecutionFailedEventAttributes.failure, false).error;
  }
  try {
    await options.client.connection.withDeadline(Date.now() + 10_000, async () => {
      do {
        const page = await options.client.workflowService.getWorkflowExecutionHistory({ namespace: options.client.options.namespace, execution: { workflowId, runId: description.runId }, maximumPageSize: Math.min(20, maxEvents - eventsRead), nextPageToken, waitNewEvent: false });
        for (const event of page.history?.events ?? []) {
          historyBytes += Buffer.byteLength(JSON.stringify(event));
          if (eventsRead >= maxEvents || historyBytes > 8_388_608) { truncated = true; break; }
          eventsRead++; observe(event);
        }
        nextPageToken = page.nextPageToken ?? new Uint8Array();
        if (nextPageToken.length && eventsRead >= maxEvents) truncated = true;
      } while (nextPageToken.length && !truncated);
    });
  } catch { historyAvailability = 'unavailable'; }
  // Temporal compacts intermediate activity retries. No attempt timeline is reconstructed.
  const rawStart = description.raw.workflowExecutionInfo?.searchAttributes?.indexedFields?.TemporalScheduledStartTime;
  if (!intendedAt && rawStart) { const value = defaultPayloadConverter.fromPayload(rawStart); if (typeof value === 'string') intendedAt = value; }
  return { workflowId, runId: description.runId, state: description.status.name, observedAt: new Date().toISOString(), workflowType: description.type, deployment,
    inputRef, ...(input !== undefined ? { input } : {}), outputRef, outputAvailability: outputRef ? 'recorded' : 'unavailable', ...(output !== undefined ? { output } : {}), ...(error ? { error } : {}),
    history: { availability: historyAvailability, truncated, eventsRead, byteLimit: 8_388_608 },
    diagnostics: { availability: settings.logs ? historyAvailability === 'available' && !truncated ? 'recorded-observations-only' : 'partial-or-unavailable' : 'not-requested', truncated: logsTruncated, bytes: logBytes, byteLimit: maxLogBytes },
    details: { requested: !!settings.details, truncated: detailsTruncated, byteLimit: 2_097_152 }, steps: [...steps.values()],
    wait: description.status.name !== 'RUNNING' ? null : historyAvailability !== 'available' || truncated ? { reason: 'unknown' } : timers.size ? { reason: 'durable-timer', timers: [...timers.keys()] } : { reason: 'activity-or-workflow-task', observation: 'No active timer observed; queue/worker availability is not inferred' },
    ...(intendedAt ? { schedule: { intendedAt, actualStartedAt: description.startTime.toISOString() } } : {}),
    reconciliation: await inspectAudit(options.auditDirectory, workflowId, description.runId),
  };
}
