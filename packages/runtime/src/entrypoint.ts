import { readFile } from 'node:fs/promises';
import { DeploymentRegistry } from './versioning.js';
import { createRunsettWorker } from './worker.js';
const deploymentId = process.env.RUNSETT_DEPLOYMENT_ID;
const registryDirectory = process.env.RUNSETT_DEPLOYMENTS_DIR;
const auditDirectory = process.env.RUNSETT_AUDIT_DIR;
if (!deploymentId || !registryDirectory || !auditDirectory) throw new TypeError('RUNSETT_DEPLOYMENT_ID, RUNSETT_DEPLOYMENTS_DIR and RUNSETT_AUDIT_DIR are required');
const deployment = await new DeploymentRegistry(registryDirectory).read(deploymentId);
const credentials: unknown = process.env.RUNSETT_CREDENTIALS_FILE ? JSON.parse(await readFile(process.env.RUNSETT_CREDENTIALS_FILE, 'utf8')) : {};
if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials) || Object.values(credentials).some(value => typeof value !== 'string')) throw new TypeError('Credential file must contain an object of reference names to strings');
const worker = await createRunsettWorker({ credentials: credentials as Record<string, string>, deployment, auditDirectory, address: process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233', namespace: process.env.TEMPORAL_NAMESPACE ?? 'default' });
// Worker.run handles SIGINT/SIGTERM and waits for activity cancellation/cleanup.
try { await worker.run(); } finally { await worker.close(); }
