import { DEFAULT_EXECUTION_LIMITS } from '@runsett/contracts';
import { ModuleRegistry } from '../../../packages/runner/src/registry.js';
import { createCodeExecutor } from '../../../packages/runner/src/supervisor.js';
const [image, scope, moduleHash] = process.argv.slice(2) as [string, string, string];
const execute = createCodeExecutor({ scope, registry: new ModuleRegistry([{ moduleId: 'main', moduleHash, image, path: '/opt/runsett/modules/main.mjs' }]) });
await execute({ identity: { workflowId: scope, runId: 'orphan', stepId: 'loop', attempt: 1, operationKey: 'orphan', deploymentId: 'v1' }, moduleId: 'main', moduleHash, input: { mode: 'loop' }, credentialBindings: [], networkMode: 'none', limits: { ...DEFAULT_EXECUTION_LIMITS, wallClockMs: 10000, cancellationGraceMs: 100 } });
