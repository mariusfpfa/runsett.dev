# Run a local JavaScript workflow

Runsett's first milestone is an MIT licensed, self-hosted durable execution slice.
Use Linux, Node.js 24, npm 11, Docker with working memory/CPU/PID limits, and
Docker Compose. No vendor account or package publication is needed. This local
single-node installation has no authentication or high availability; published
ports bind only to loopback. Run all commands from the repository root.

## Install and register the fixture

```sh
npm ci --cache /tmp/runsett-npm-cache
npm run build
docker compose -f deploy/compose.yaml up -d --wait
npm run example:register
```

The registration command builds the runner image with the checked-in async
module, records its immutable image ID, bundles the workflow and dependencies,
and stores deployment `example-v1` in `.runsett/deployments`. It prints only
identity metadata. Repeating an identical registration is safe; changed code,
lockfiles, network configuration or image identity require a new deployment ID.
Keep this directory and its pinned images for the lifetime of sleeping runs.
`.runsett/` is local, ignored data; it is not an execution-state database.

Temporal's existing operator UI is at <http://127.0.0.1:8080>. PostgreSQL persists
Temporal state in the Compose volume. `docker compose down` preserves it;
`down -v` deletes it. The development namespace retains closed history for seven
days. The UI exposes engine payloads to local operators; treat access accordingly.

## Start a worker

In a second terminal in the repository root:

```sh
export RUNSETT_DEPLOYMENT_ID=example-v1
export RUNSETT_DEPLOYMENTS_DIR=.runsett/deployments
export RUNSETT_AUDIT_DIR=.runsett/audit
node packages/runtime/dist/entrypoint.js
```

The worker loads the stored bundle and routes only that immutable deployment.
Defaults are `TEMPORAL_ADDRESS=127.0.0.1:7233` and
`TEMPORAL_NAMESPACE=default`; those variables also configure the CLI.
Credential bindings, if required by your own blocks, are supplied only to the
worker via `RUNSETT_CREDENTIALS_FILE` (a local reference-name-to-value JSON file).
Keep that file outside version control; never put secrets in arguments or inputs.
The fixture needs no credentials or outbound network.

## Submit and inspect

In the first terminal:

```sh
npm exec -- runsett run --id local-example-001 --deployment example-v1 --workflow example --input '{"items":[1,2,3],"waitMs":1000}' --json
npm exec -- runsett inspect local-example-001 --json
npm exec -- runsett inspect local-example-001 --details --logs --json
```

Submission prints `workflowId` and `runId`, then returns without waiting for
completion. Repeat inspection until `state` is `COMPLETED`. The fixture returns
`output.version: "1"`, `first`/`last` step results, and `items` containing values
1, 2 and 3 plus their attempt/operation-key metadata. You can submit before starting a worker and
observe queued work; engine state does not imply worker availability. `--input-file
path.json` accepts a bounded UTF-8 JSON file instead of `--input`.

Repeating the same ID/type/deployment/input returns the retained original run.
Changing its identity fails with a nonzero exit. Deduplication is bounded by
Temporal retention: never intentionally reuse workflow IDs after history expires.
Use your own unique IDs for new runs. The recurring schedule below generates IDs
through Temporal's occurrence timestamps under a schedule-specific hashed prefix.

Ordinary inspection prints references, identities, engine state, observed attempts,
and wait reason. `--details` opts into recorded input/output/error messages;
`--logs` opts into recorded diagnostic messages. These values may contain sensitive
application data: trusted code and redaction cannot guarantee secret-free output.
Neither option executes workflow or module code, invokes Docker, nor dispatches a
step. Inspection still works when the original deployment is missing and reports
that separately from engine state. Missing/corrupt history or audit observations
are reported as unavailable; a truncated history is not a complete timeline.
Intermediate Temporal activity retries may be compacted: `observedAttempts` are
only observed numbers and `attemptHistory` is explicitly `incomplete`.

Bounds: default 200 history events (`--max-events 1..1000`), 8 MiB serialized
history budget, pages of at most 20 events, ten-second history RPC deadline;
64 KiB diagnostics (`--max-log-bytes 1..262144`, including record metadata),
2 MiB aggregate detail payloads, and at most 1000 audit directory entries of
256 KiB each. Flags report truncation explicitly. Diagnostics are observations,
not proof that all attempts logged. Docker reconciliation evidence reports unknown
external side-effect outcome independently of success/failure in Temporal.

Cancel a long wait with:

```sh
npm exec -- runsett run --id local-wait-001 --deployment example-v1 --workflow example --input '{"items":[7],"waitMs":3600000}' --json
npm exec -- runsett cancel local-wait-001 --json
npm exec -- runsett inspect local-wait-001 --json
```

Cancellation acknowledges a request, not immediate termination. Inspect for the
final engine state. Cancellation never undoes external writes.

## Schedule an explicit fixture cadence

This example is a synthetic local fixture, not a configured CSV integration.
Choose your own cadence/timezone before creating a real source schedule:

```sh
npm exec -- runsett schedule create --id local-fixture-hourly --deployment example-v1 --workflow example --cron '0 * * * *' --timezone UTC --input '{"items":[1],"waitMs":1000}' --json
npm exec -- runsett schedule pause local-fixture-hourly --json
```

Temporal Schedules owns recurrence. Defaults are UTC, overlap `SKIP`, and a
one-hour catch-up window. `--timezone` accepts an IANA timezone; `--cron` is caller
supplied and validated by Temporal. Creating an existing schedule ID fails rather
than silently updating it. A schedule action preserves deployment metadata and
version routing. Each occurrence gets a distinct workflow ID; it does not reuse
a closed manual run ID. For a scheduled run, inspect `schedule.intendedAt`
separately from `schedule.actualStartedAt`. Pause stops future occurrences and
does not cancel existing runs. Manage deletion/resumption in the local operator UI.

All commands accept `--json`; successful commands emit one JSON document and
failures emit an error document with a nonzero exit. Inspection of a failed run
succeeds because its state was retrieved. Error messages avoid echoing payloads,
credential paths, workflow bundles, and remote failure details. Use explicit
inspection flags for recorded application details.

## Verify fixtures

```sh
npm run typecheck
npm test
npm run test:cli
npm run test:temporal
npm run test:runner
```

Integration suites require real running Compose Temporal and Docker and fail if
unavailable. They never silently skip. See [JavaScript Code](javascript-code-node.md)
and [custom blocks](custom-blocks.md) before writing an external-effect block.
