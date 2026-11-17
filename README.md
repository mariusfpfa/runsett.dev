# Runsett

**Code-first automation. Self-hosted. MIT licensed.**

Runsett is a workflow engine for developers. Write TypeScript workflows with
explicit steps, author JavaScript blocks yourself or with any AI coding agent,
and inspect what happened through a structured CLI and Temporal's operator UI.
The runtime runs on your own infrastructure without a vendor account.

The first milestone is implemented: durable JavaScript execution, schedules,
inspection, and recovery tests. This is an early foundation, with
[production readiness work](docs/operations.md) still ahead. Built-in CSV,
database, HTTP, and Google Sheets connectors, webhook response delivery, and a
custom graphical debugger are planned next.

## What works today

- **TypeScript workflows:** explicit steps, durable sleep, and bounded iteration
  with stable item keys and ordered results.
- **JavaScript blocks:** async ESM modules, JSON Schema input/output validation,
  packaged dependencies, and explicitly selected credential bindings.
- **Container execution:** non-root, read-only Docker containers with resource
  and output limits; networking is disabled unless configured.
- **Durable execution:** Temporal backed by PostgreSQL records progress, manages
  timers and cancellation, and schedules explicitly enabled retries.
- **Immutable deployments:** workflow bundles, module images, and dependencies
  are fingerprinted; execution stays bound to its original deployment content.
- **Scheduling and debugging:** recurring schedules plus CLI commands to submit,
  inspect, and cancel runs. Inspection reads recorded results and bounded logs
  without executing code again.

Arbitrary JavaScript defaults to one attempt. Retrying an external write still
requires idempotency or reconciliation at the receiving service; Runsett does not
promise exactly-once external effects. See [reliability](docs/reliability.md) for
the tested guarantees and their limits.

## A workflow is code

From the [JavaScript example](examples/javascript/workflow-v1.ts), using its
[registered operation block](examples/javascript/blocks.ts):

```ts
import { defineWorkflow, mapItems, type JsonValue } from '@runsett/sdk/workflow';
import { operation } from './blocks.js';

export const example = defineWorkflow(async (input, context) => {
  const parameters = input as { items: JsonValue[]; waitMs: number };
  const first = await context.step('prepare', operation, { stage: 'prepare' });

  await context.sleep(parameters.waitMs);

  const items = await mapItems(
    parameters.items,
    { key: item => JSON.stringify(item), concurrency: 2 },
    (value, key) => context.step(`item:${key}`, operation, { value }),
  );

  const last = await context.step('finish', operation, { stage: 'finish' });
  return { version: '1', first, items, last };
});
```

Each `context.step` is a recorded recovery boundary. `context.sleep` uses an
engine timer and survives worker restarts. Each item's key must be unique within
the batch. See [custom blocks](docs/custom-blocks.md) for schemas, module hashes,
dependency packaging, retry semantics, and testing your own blocks.

## Quickstart

Requirements: Linux, Node.js 24, npm 11, Docker, and Docker Compose. Docker must
support the configured memory, CPU, and PID limits. The included Compose stack is
for local development and exposes its ports on loopback.

Clone, build, start the services, and register the example deployment:

```sh
git clone https://github.com/mariusfpfa/runsett.dev.git
cd runsett.dev
npm ci
npm run build
docker compose -f deploy/compose.yaml up -d --wait
npm run example:register
```

Start a worker from the repository root in a second terminal:

```sh
export RUNSETT_DEPLOYMENT_ID=example-v1
export RUNSETT_DEPLOYMENTS_DIR=.runsett/deployments
export RUNSETT_AUDIT_DIR=.runsett/audit
node packages/runtime/dist/entrypoint.js
```

Submit and inspect the example from the first terminal:

```sh
npm exec -- runsett run --id quickstart-001 --deployment example-v1 --workflow example --input '{"items":[1,2,3],"waitMs":1000}' --json
npm exec -- runsett inspect quickstart-001 --details --logs --json
```

Submission returns immediately with the workflow and run IDs. Repeat inspection
until `state` is `COMPLETED`. Repeating the same submission returns its retained
run; use a new workflow ID for new work. Temporal's operator UI is at
<http://127.0.0.1:8080>.

Follow [Getting started](docs/getting-started.md) for cancellation, schedules,
credentials, configuration, and inspection options. Keep PostgreSQL volumes,
deployment artifacts, and pinned images for retained runs; see
[Operations](docs/operations.md) before changing deployments or removing data.

## Development and verification

All `@runsett/*` packages are private npm workspaces used directly from this
repository; there is no package publication required for local development.

```sh
npm run typecheck
npm test
npm run test:integration
```

Integration tests require the real running Temporal/PostgreSQL Compose services
and Docker. They fail if infrastructure is missing and run suites in series.
Coverage includes worker termination, durable timers, checkpoint preservation,
receiver-side deduplication, deployment isolation, cancellation, and runner limits.
The [reliability report](docs/reliability.md) records observed recovery behavior.

| Package | Responsibility |
| --- | --- |
| `@runsett/contracts` | JSON execution contracts, limits, and error types |
| `@runsett/sdk` | Block definitions, workflow steps, and iteration |
| `@runsett/runner` | Container lifecycle and bounded JavaScript execution |
| `@runsett/runtime` | Temporal workers, deployment identity, schedules, and inspection |
| `@runsett/cli` | Run submission, inspection, cancellation, and schedule commands |

## Documentation

- [Getting started](docs/getting-started.md)
- [JavaScript Code node](docs/javascript-code-node.md)
- [Creating custom blocks](docs/custom-blocks.md)
- [Reliability and recovery evidence](docs/reliability.md)
- [Operations and production gates](docs/operations.md)
- [Runtime APIs](packages/runtime/README.md) and [runner internals](packages/runner/README.md)
- [Architecture](docs/superpowers/specs/2026-11-17-workflow-engine-design.md)
  and [first milestone plan](docs/superpowers/plans/2026-11-17-durable-javascript-milestone.md)

## License

[MIT](LICENSE), copyright (c) 2026 mariusfpfa.
