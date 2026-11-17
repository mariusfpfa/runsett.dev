# Local durable runtime

This milestone uses Node.js 24, Temporal TypeScript SDK 1.26.0, Temporal Server
1.29.1 and PostgreSQL 16. All components can run locally without a vendor account.
The Compose topology is for development: one database, one Temporal node,
plaintext gRPC, and development database credentials. Both exposed endpoints bind
to loopback. PostgreSQL state persists in `runsett_postgres-data`.

```sh
npm ci --cache /tmp/runsett-npm-cache
npm run build
docker compose -f deploy/compose.yaml up -d --wait
npm run test:temporal
```

Tests require actual Docker and the running PostgreSQL-backed Temporal service.
They fail if infrastructure is absent. `TEMPORAL_ADDRESS` overrides the default
`127.0.0.1:7233`; the integration target uses the `default` namespace. Compose
creates that namespace with seven-day closed-history retention. Keep database
volumes when stopping with `docker compose -f deploy/compose.yaml down`; `down -v`
deletes local history and ends the deduplication guarantee.

Workflow authors import `defineWorkflow`, `mapItems`, and types from
`@runsett/sdk/workflow`, then export the returned workflow function under a
configured workflow type. `@runsett/sdk` provides serializable `defineBlock` and
`mapItems` without importing Temporal workflow APIs. Schemas use JSON Schema
2020-12 with Ajv strict validation; unresolved external references and asynchronous
validator schemas are rejected. No executable validators enter deployment data.
`context.step` returns JSON output; the recorded activity result contains the full
`CodeResult`, including bounded redacted diagnostics and immutable module hash.
Input/output validation errors and author workflow exceptions terminate the run.

`DeploymentRegistry(directory).register(definition)` durably stores a built
workflow bundle, dependency lock hash, block definitions, module content hashes,
immutable image identities, and optional configured Docker network. Registration
uses atomic no-overwrite publication and file/directory fsync. Reusing a deployment
ID with changed content fails. Read/list exports support inspection and later CLI
work. Use a persistent dedicated directory on local POSIX storage, with trusted
owner-only write access; this milestone does not provide shared artifact storage.
`examples/javascript/deployment.ts` exports a build-time `registerExample` helper.
It bundles the selected v1/v2 workflow once; workers then load the stored code and
never rebuild from a mutable source path. Build module images using:

```sh
docker build -q -f packages/runner/Dockerfile \
  --build-arg MODULE_BUNDLE=examples/javascript/modules .
```

Supply the returned immutable image ID to `registerExample`, alongside a unique
deployment ID, version `1` or `2`, and registry directory. Call it through a small
TypeScript setup script importing that helper. The example's module SHA-256 is
pinned in `examples/javascript/blocks.ts`; module changes require new hashes and
new deployment IDs. Locked dependencies are baked at image build time. The helper
hashes the actual `package-lock.json`. Workers do not install dependencies.

`createRunsettWorker({ deployment, auditDirectory, address?, namespace?,
credentials? })` creates a configurable worker. `run()`, `shutdown()`, and `close()`
control its lifecycle; await the running promise before closing the connection.
Each deployment/version has its own deterministic queue (`taskQueueFor`). Two
versions coexist, and activities/retries stay on their workflow's recorded queue.
A missing old worker leaves its runs waiting; it does not select newer code.
The standalone worker is runnable after build:

```sh
RUNSETT_DEPLOYMENT_ID=example-v1 \
RUNSETT_DEPLOYMENTS_DIR=/persistent/runsett/deployments \
RUNSETT_AUDIT_DIR=/persistent/runsett/audit \
node packages/runtime/dist/entrypoint.js
```

`TEMPORAL_NAMESPACE` defaults to `default`. Optional `RUNSETT_CREDENTIALS_FILE`
points to a worker-local JSON object mapping reference names to secret strings.
Only those names enter workflow/activity payloads. The runner selects values at
the worker boundary and transmits them over ephemeral stdin; never put secrets in
workflow inputs or deployment definitions. Optional network selection is pinned
in the deployment, and disabled otherwise.

`createRunClient({ client: temporalClient, deployments: registry })` returns
`startRun(request)` and `cancelRun(workflowId)`. Callers choose a stable unique
workflow ID and repeat the same deployment/type/input after an ambiguous transport
failure. Start is atomic in Temporal; a reserved `runsettRequest` memo stores a
versioned canonical JSON SHA-256 fingerprint. Matching retained submissions return
the original run (including closed runs), and conflicts/missing metadata reject.
No visibility search or in-memory deduplication registry is used. A vanished history
while inspecting a duplicate propagates an indeterminate service error rather than
starting another execution. Deduplication lasts while history remains retained;
**never intentionally reuse workflow IDs, including after history expiry**.

`runsettRequest` is runtime-reserved: direct Temporal memo mutation is unsupported.
Trusted authors must not reset workflows, Continue-as-New, or configure workflow
retries in this milestone. Activity attempts default to one even for pure/read
blocks. Retry opt-in is `maximumAttempts`; operation keys hash workflow ID, run ID,
deployment ID, and step ID, excluding attempt. Side-effecting receivers must honor
that stable key if retrying effects. Step IDs must be unique within a run.

`ReconciliationAudit(directory)` durably records Docker unknown-outcome evidence
before cleanup acknowledgement; `read(workflowId)` provides later inspection.
Hashed filenames avoid using raw workflow IDs as paths. Publication is atomic,
file and directory sync precede acknowledgement, and storage failures propagate
so the runner retains its Docker evidence. Keep this directory on its own durable
local volume along with deployment artifacts. Audit evidence supplements Temporal;
an unknown outcome never proves that an external side effect did not happen.
