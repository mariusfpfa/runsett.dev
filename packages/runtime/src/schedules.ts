import { Client, ScheduleOverlapPolicy } from '@temporalio/client';
import { assertJsonValue, DEFAULT_EXECUTION_LIMITS } from '@runsett/contracts';
import type { StartRunRequest } from './client.js';
import { DeploymentRegistry, taskQueueFor } from './versioning.js';
import { sha256 } from './storage.js';
import { createRequestIdentity } from './request-identity.js';
export interface CreateScheduleRequest extends Omit<StartRunRequest, 'workflowId'> { scheduleId: string; cron: string; timezone?: string }
export function createScheduleClient(options: { client: Client; deployments: DeploymentRegistry }) {
  return {
    async create(request: CreateScheduleRequest) {
      for (const key of ['scheduleId', 'deploymentId', 'workflowType', 'cron'] as const) if (typeof request[key] !== 'string' || !request[key].trim()) throw new TypeError(`Invalid ${key}`);
      assertJsonValue(request.input, DEFAULT_EXECUTION_LIMITS.inputBytes);
      request = JSON.parse(JSON.stringify(request)) as CreateScheduleRequest;
      const timezone = request.timezone ?? 'UTC';
      new Intl.DateTimeFormat('en-US', { timeZone: timezone });
      const deployment = await options.deployments.read(request.deploymentId);
      if (!deployment.workflowTypes.includes(request.workflowType)) throw new TypeError('Unknown workflow type for deployment');
      const identity = createRequestIdentity(deployment, request.workflowType, request.input);
      await options.client.schedule.create({ scheduleId: request.scheduleId,
        spec: { cronExpressions: [request.cron], timezone },
        policies: { overlap: ScheduleOverlapPolicy.SKIP, catchupWindow: '1h' },
        action: { type: 'startWorkflow', workflowType: request.workflowType,
          // Temporal appends the occurrence timestamp to this namespace-isolated base.
          workflowId: `runsett-schedule-${sha256(request.scheduleId)}`, taskQueue: taskQueueFor(deployment), args: [request.input],
          memo: { runsettRequest: identity } },
      });
      return { scheduleId: request.scheduleId, timezone, overlap: 'SKIP', catchupWindowMs: 3_600_000 };
    },
    async pause(scheduleId: string) {
      if (!scheduleId) throw new TypeError('Schedule ID required');
      await options.client.schedule.getHandle(scheduleId).pause('Paused via Runsett CLI');
      return { scheduleId, paused: true };
    },
  };
}
