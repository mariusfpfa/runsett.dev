# Local operations

Use Node.js 24, npm 11 and Docker/Compose. The runtime is open-source and self-hosted; local operation requires no vendor account. PostgreSQL, Temporal and its optional UI use pinned images. The Compose setup is for local development with development database credentials and loopback-bound ports.

## Start and stop

```sh
npm ci
npm run build
docker compose -f deploy/compose.yaml config
docker compose -f deploy/compose.yaml up -d --wait --wait-timeout 180
npm run example:register
```

Use the deployment ID printed by registration:

```sh
export RUNSETT_DEPLOYMENT_ID='<registered-id>'
export RUNSETT_DEPLOYMENTS_DIR='.runsett/deployments'
export RUNSETT_AUDIT_DIR='.runsett/audit'
export TEMPORAL_ADDRESS='127.0.0.1:7233'
node packages/runtime/dist/entrypoint.js
```

See [getting started](getting-started.md) for submission, inspection and schedules. Set `NO_PROXY=localhost,127.0.0.1,::1` and `no_proxy` likewise if inherited proxies interfere with local gRPC. Compose clears proxies for its internal service traffic. Credentials may be supplied using `RUNSETT_CREDENTIALS_FILE`, a JSON object mapping explicit credential references to strings; protect this file. No ambient control-plane credentials enter runner containers.

SIGTERM/SIGINT lets the worker shut down and clean active work. SIGKILL tests crash recovery. Stop local services without deleting stored state:

```sh
docker compose -f deploy/compose.yaml stop
# Or remove service containers while retaining the named database volume:
docker compose -f deploy/compose.yaml down
```

`docker compose ... down -v` deletes the PostgreSQL volume and history. Use it only for deliberate local reset or ephemeral CI cleanup. The local history retention is seven days; idempotent submissions cannot rely on retained history forever.

## Persistence and deployment retention

Keep the Compose `postgres-data` volume, deployment registry directory, reconciliation audit directory, immutable runner images and any explicitly bound credential files. PostgreSQL holds Temporal's durable state. The filesystem deployment registry contains the workflow bundle, module hashes, dependency lock hash, exact image ID and routing metadata. It must survive worker replacement independently of mutable source checkout. The audit directory holds fsynced unknown-outcome evidence before container deletion. A single-host local volume is not shared artifact storage or a backup.

Retain each old deployment record and exact image while any run or schedule references it, including sleeping, retrying and waiting runs. Keep version 1 workers available until its work drains; version 2 workers use a distinct deployment queue and do not substitute new code for old work. Restart an old worker with its original ID and registry record. If the artifact/image is missing, restore it; rebuilding current source is not a valid recovery strategy. Verify schedules are migrated or paused before retiring their deployment.

## Inspect and recover

Use `runsett inspect <workflow-id> --json` to see engine state, original deployment, recorded steps, active timers and audit availability. Add `--details --logs` only when payloads are needed. A pending task is visible, but this API does not prove permanent worker absence or reconstruct every retry. Compare the deployment queue with the actual process/deployment inventory.

After a worker crash, start the same stored deployment. Temporal supplies recorded completed results and durable timers; active Activities may fail or retry under their declared policy. Sticky workflow task and heartbeat timeouts contribute to elapsed recovery. The worker reconciles owned expired containers and durably acknowledges unknown outcomes before removing them. Investigate external effects using receiver operation keys, workflow/run/step IDs and actual attempt records. Do not blindly replay a write that used the default single attempt.

Run `npm run test:integration` with one suite at a time; its aggregator and CI already serialize Docker-heavy tests. Logs and measurements are explained in [reliability](reliability.md). The harness deliberately withholds a real HTTP response after receiver acceptance before killing the worker. It leaves production runtime networking unchanged.

Bounded concurrency limits outstanding work; it does not remove Temporal aggregate command, payload or history limits. Use batching and artifact references for long or large workflows. There is currently no Continue-As-New support, and this milestone does not establish an aggregate capacity limit.

## Production readiness

Required gates are backup and restore drills, an authenticated and authorized control plane, shared durable deployment/image storage, global quotas across workers, and HA/failover validation for Temporal and PostgreSQL. Also define artifact/history retention, receiver idempotency storage and operational monitoring. Local process-crash evidence does not establish database disaster recovery, receiver crash durability or multi-node availability.
