# Authoring custom blocks and workflows

Custom and built-in blocks share `@runsett/sdk`. A block definition is immutable,
serializable metadata: name/version, module ID/hash, input/output JSON Schema
2020-12, effect (`pure`, `read`, or `write`), `maximumAttempts`, credential
reference names and network mode. See the checked-in
[`blocks.ts`](../examples/javascript/blocks.ts) fixture for working definitions.
Async schemas and external schema references are unsupported; internal `$defs`
references work. Schema documents have independent reference registries.

```ts
import { defineWorkflow, mapItems } from '@runsett/sdk/workflow';
import { operation } from './blocks.js';
export const example = defineWorkflow(async (input, context) => {
  const values = (input as { items: number[] }).items;
  const output = await mapItems(values, { concurrency: 2, key: String },
    (value, key) => context.step(`item:${key}`, operation, { value }));
  await context.sleep(1000);
  return output;
});
```

Workflow code is deterministic orchestration running in Temporal's workflow
sandbox, not the JavaScript Code execution container. Perform external I/O only
inside activities/modules. Use durable `context.sleep`, not process timers for
long waits. Step IDs must be unique within a run. Keyed iteration rejects
duplicate keys before dispatch, bounds concurrency and returns results in input
order; choose stable business keys. A failure stops further dispatch; already
started external effects require reconciliation.

Package your workflow through `bundleWorkflowCode`, then register its actual
bundle, locked dependency hash, allowed workflow exports, blocks, module hashes,
immutable image identities and optional configured network with
`DeploymentRegistry`. The [executable fixture](../examples/javascript/register.ts)
and [getting started](getting-started.md) provide complete local commands.
A worker loads that saved bundle and derived deployment/version queue. Do not
mutate stored artifacts or replace old image IDs when deploying v2. Use distinct
workers for retained deployment versions.

Use `@runsett/runtime`'s `createRunClient` for manual submission and cancellation,
`inspectRun` for read-only bounded observations and `createScheduleClient` for
Temporal recurrence. `runsettRequest` memo is reserved deployment/submission
identity; direct mutation, workflow resets, Continue-as-New, workflow-level
retries and ad-hoc starts bypassing the supported metadata are unsupported in
this milestone. Activity retries are supported explicitly. Temporal is the
execution-state store; the deployment registry and reconciliation audit are
configuration/evidence, not a second workflow state machine.

Default to one execution attempt. Opt in to retries only when the effect's
semantics allow it. Pass `context.operationKey` to external APIs/transactions as
an idempotency key and enforce uniqueness there. The key is stable across
attempts but is not by itself a guarantee that a remote operation runs once.
A process can fail after the remote write and before recording acknowledgement;
unknown Docker outcomes stay unknown. Blind append retries are unsafe. Neither
cancellation nor a later retry undoes earlier writes.

Credentials are named bindings in metadata and worker-local values in
`RUNSETT_CREDENTIALS_FILE`. Only selected bindings enter the invocation. The default
network mode is `none`; configured egress must be pinned per deployment. Keep
secrets out of fixtures, commits, CLI arguments, histories and diagnostic output.
See [JavaScript Code](javascript-code-node.md) for exact limits and isolation.

Test the block with captured synthetic JSON fixtures, schema errors, expected
classified failures and external-effect idempotency cases. Run a real registered
workflow against Compose Temporal and the Docker runner; verify recorded
results survive and inspection works without executing modules. Include missing
version/worker behavior, cancellation, and opt-in retry observations. Do not
replace the real engine with an in-memory state machine or silently skip service
failures. Shared artifact storage, authenticated production control planes,
connectors and custom graphical debugging follow later milestones.
