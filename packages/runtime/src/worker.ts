import { NativeConnection, Worker } from '@temporalio/worker';
import { createCodeExecutor, ModuleRegistry, type CredentialSource } from '@runsett/runner';
import { createActivities } from './activities.js';
import { ReconciliationAudit } from './audit.js';
import { assertRegisteredDeployment, taskQueueFor, type RegisteredDeployment } from './versioning.js';
export async function createRunsettWorker(options: {
  deployment: RegisteredDeployment; auditDirectory: string; address?: string; namespace?: string;
  credentials?: Readonly<Record<string, CredentialSource>>;
}) {
  assertRegisteredDeployment(options.deployment);
  // Snapshot to prevent mutation by the embedding caller while the worker runs.
  const deployment = JSON.parse(JSON.stringify(options.deployment)) as RegisteredDeployment;
  const connection = await NativeConnection.connect({ address: options.address ?? '127.0.0.1:7233' });
  const executor = createCodeExecutor({ registry: new ModuleRegistry(deployment.modules), scope: taskQueueFor(deployment), onReconciliation: new ReconciliationAudit(options.auditDirectory).acknowledge, ...(options.credentials ? { credentials: options.credentials } : {}), ...(deployment.configuredNetwork ? { configuredNetwork: deployment.configuredNetwork } : {}) });
  try {
    await executor.reconcile();
    const worker = await Worker.create({ connection, namespace: options.namespace ?? 'default', taskQueue: taskQueueFor(deployment), workflowBundle: deployment.workflowBundle, activities: createActivities(deployment, executor) });
    return { worker, run: () => worker.run(), shutdown: () => worker.shutdown(), close: async () => { executor.close(); await connection.close(); } };
  } catch (error) { executor.close(); await connection.close(); throw error; }
}
