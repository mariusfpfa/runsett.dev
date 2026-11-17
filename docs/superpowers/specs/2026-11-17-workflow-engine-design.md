# Runsett workflow engine design

The project is an MIT licensed, self-hosted automation platform for developers. Workflows are TypeScript code with explicit steps. Any coding agent can author workflows and blocks through files, documentation, and a structured CLI/API. The interface explains and controls execution; a visual workflow authoring canvas is not required.

The user accepted the Temporal-based architecture on 2026-11-17 and explicitly added a JavaScript Code node as a critical first component. The working product name is Runsett; the user reports runsett.dev is available. Domain registration is outside this implementation. This document records that architecture and proposes concrete first-milestone boundaries and defaults for review.

## Goals and constraints

- Own project code is MIT licensed. Required runtime components must permit an entirely open-source, self-hosted installation without a vendor account.
- TypeScript for the SDK, workers, CLI, and product services. Node.js 24 is the initial supported runtime.
- Temporal owns durable execution state, timers, retry scheduling, and workflow lifecycle. PostgreSQL backs the initial Temporal deployment.
- Preserve progress across worker failure. Distinguish repeated attempts from completed effects; never promise exactly-once arbitrary external writes.
- Make JavaScript execution a first-class block with inputs, outputs, diagnostics, cancellation, and resource limits.
- Preserve workflow/dependency versions for running executions. New deployments must not silently alter sleeping runs.
- Expose inspectable steps and per-item outcomes through machine-readable interfaces usable by any agent.
- Initial installation has trusted workflow authors. It is not a service for running hostile public submissions.
- Single-host restart recovery and high availability are separate deployment promises.

## Approaches

The user chose a code-first SDK with explicit steps over an entirely declarative graph or unrestricted orchestration code without recorded boundaries. This preserves developer flexibility while giving the runtime points at which to record progress and diagnostics.

Temporal is the accepted execution foundation. Its MIT server and TypeScript SDK provide durable execution, timers, schedules, and versioning. Its additional operational footprint is acceptable for the reliability goal. DBOS was considered for its smaller PostgreSQL-based footprint, but distributed operations and some resource-management features require additional coordination or proprietary components. Restate's current server license does not meet the open-source default-stack goal. Building on pg-boss or BullMQ would leave substantially more recovery and versioning machinery to implement.

## System boundaries

The TypeScript SDK exposes recorded steps, durable waits, branch/iteration helpers, child workflows, and workflow definitions. Deterministic workflow code schedules operations; activities execute external effects. Schema validation checks runtime inputs and results, independently of TypeScript compile-time types.

Temporal remains the source of truth for execution. Product metadata and searchable views may later live in a separate PostgreSQL database. They must not become a second execution state machine. Logs and attempt diagnostics supplement engine history; sampled traces cannot replace it.

Workers execute immutable deployment bundles. Each bundle fixes code and dependency versions. Separate versioned task queues are an acceptable first-milestone routing strategy; current Temporal Worker Versioning can be evaluated later. A run keeps its queue/build identity. Old workers remain available until their runs complete. No automatic in-place migration is promised.

Artifact storage holds large files and results. First milestone uses a dedicated local volume with atomic writes and content hashes. Distributed execution later requires shared storage. Engine histories store small serializable values or artifact references, never open streams, sockets, or database connections.

## JavaScript Code node

The node executes ordinary asynchronous JavaScript as an ESM module, not an expression-only language. Its entry point is `export default async function(input, context)`. The module returns one JSON-compatible value. Per-item execution comes from the workflow's loop primitive; the code node itself receives exactly the input specified by its caller.

Source lives in the deployment bundle and is identified by a logical module ID and content hash. Callers cannot supply arbitrary filesystem paths at invocation time. Code is not fetched or installed during execution. Dependencies are declared and locked at build time; they are included in the runner image or bundle. Production package installation is never an implicit side effect of running a node.

The context exposes an operation key stable across attempts, attempt number, structured logging, an abort signal, and explicitly provided configuration/credential bindings. Secret values must not be recorded in workflow history or invocation manifests. Credentials come from the runner's configured bindings and only the selected bindings are passed to the child. Automatic redaction is best effort for trusted code, not a guarantee against malicious exfiltration.

JavaScript can call approved external services using Node APIs or packaged libraries. Such code is an activity and can run again after failure. The default retry policy for arbitrary code is one attempt. Authors opt into retries only after declaring and testing appropriate idempotency or reconciliation behavior. A single code node is one recovery boundary; it cannot checkpoint arbitrary local variables or resume halfway through a function. Long waits and multi-step orchestration belong in workflow primitives.

Initial configurable defaults, proposed by the implementer: 30-second wall-clock timeout, 256 MiB container memory, one CPU, 64 process limit, 1 MiB each for input and result, and 256 KiB combined captured stdout/stderr. Exceeding input/result/log limits fails with a structured error rather than truncating a result into apparently valid data. Cancellation first requests graceful termination, then kills the complete execution container after two seconds. These defaults are operational guardrails, not a hostile-code security certification.

Production-style local execution uses a dedicated container per invocation. The container runs non-root, with a read-only root filesystem, bounded tmpfs, dropped capabilities, no privilege escalation, no Docker socket, and no control-plane credentials. The runner supervisor alone owns container lifecycle privileges. A local subprocess backend may exist for development with an explicit warning that it is not an isolation boundary. Timeout, process cleanup, network policy, filesystem restrictions, and output limits are part of runner conformance tests.

Network access defaults to disabled for a code invocation; authors explicitly enable the deployment's configured outbound network mode. Internal service access is possible by configuration, including MySQL. This is not a URL filtering guarantee: a future per-destination policy must cover redirects, DNS, and arbitrary library sockets.

Results and errors include execution/step/attempt identity, module identity, timestamps, and bounded diagnostic output. Errors distinguish validation, syntax/runtime failure, timeout, cancellation, resource termination, output overflow, and infrastructure failure. History does not contain raw secrets. Inspecting a past result does not execute code again.

## Essential functional coverage

The initial product baseline includes manual/API/webhook/schedule triggers; HTTP requests and downloads; CSV/JSON validation and transformations; conditions; keyed diff/dedup; sequential and bounded-parallel iteration; batching and joins; child workflows; durable waits and callbacks; retries and cancellation; artifact storage; JavaScript Code; MySQL/PostgreSQL connectors; and Google Sheets read/update/batch/append operations. Built-ins and external blocks use the same SDK.

The first milestone implements only the durable execution vertical slice: SDK contracts, JavaScript Code, durable sleep, bounded iteration, configurable retries, manual CLI submission/inspection/cancellation, a schedule example, version routing, and failure tests. MySQL, CSV, HTTP, Sheets, webhook response delivery, shared rate limits, and the custom graphical debugger follow in subsequent milestones. This is a staged implementation of the accepted baseline, not a claim that milestone one is an n8n replacement.

## Scheduling and concurrency

Use Temporal Schedules, not process-local cron timers. Schedule definitions specify IANA timezone, overlap policy, catch-up window, and schedule ID. Initial examples use UTC, skip overlap, and a bounded catch-up window of one hour. The actual user CSV schedule is not configured until its cadence/timezone are supplied. Show intended occurrence separately from actual start time.

Bound workflow fan-out. Each item has a stable unique business key within its batch; duplicate item keys fail validation before work begins. Parallelism is a positive integer with a documented maximum of 100 in the first helper. Concurrency within one run does not imply a fleet-wide API quota. Shared rate limits, fairness, and admission control must be implemented separately before being advertised.

Durable sleep uses engine timers and survives workers being replaced. The code-node timeout still bounds one active invocation. Cancellation is cooperative at the workflow level and enforced by the runner for its execution container; cancellation does not undo completed external writes.

## Reference automation

The first connector milestone captures an immutable CSV artifact, validates it, identifies rows by a business key, checks the external MySQL ledger in chunks, atomically claims unprocessed records, invokes an external check, records its branch decision, writes to Sheets, and records completion. Download retries must not silently substitute a different input after processing starts.

MySQL transactions do not remain open across HTTP requests or sleeps. A unique-key claim prevents concurrent runs from selecting the same work. Persisted write intent and reconciliation handle a successful Sheets write followed by a lost acknowledgement. Blind append retries are not safe; keyed, controlled updates are preferred. No transaction spans Sheets and MySQL.

## HTTP response semantics

Webhook acceptance is acknowledged only after durable submission. Immediate mode returns a run ID. Explicit-response mode waits for a designated response step, sends at most one response, and permits the workflow to continue. Connections have deadlines and cannot survive a server restart; stored response results and status polling support later retrieval. Completing a response is independent of completing a workflow.

## Debugging and agent interfaces

The first milestone exposes submit/status/history/cancel through a CLI with JSON output and Temporal's existing operator UI. It must show recorded step identity, attempts where observed, bounded logs, error classification, input/output references, deployment identity, and wait reason. Crash gaps in instrumentation are represented as unknown, not fabricated success.

A subsequent product UI visualizes actual execution paths and loop-item outcomes. Arbitrary TypeScript cannot always yield a complete static graph; do not promise one. Resuming an unchanged run, starting a new run with new code, and rerunning a single block against a fixture are distinct actions with separate identities.

## Reliability verification

Milestone one must test schema rejection; async JS execution; JS exceptions; unsupported result values; input/output/log limits; timeout and container cleanup; cancellation; credential isolation from process environment/history; bounded iteration; durable sleep through worker restart; recorded step results surviving restart; stable operation keys across retries; duplicate run submission; and version-one runs resuming on version-one workers after version two is deployed.

Tests use a real local Temporal service for integration and deliberately terminate workers at controlled boundaries. A fake external receiver records operation keys to demonstrate deduplication and the ambiguity after a successful external action before its checkpoint. Unit tests alone do not establish durability.

Compose is initially a development/validation topology with persistent PostgreSQL storage, Temporal, operator UI, and application workers. Before a production claim, complete database/artifact/key backup and restore drills, migration/upgrade tests, resource limits, authentication, and host-loss recovery. HA and hostile multi-tenant execution are separate later projects.

## Builder decisions and remaining choices

The builder may choose exact compatible dependency versions, build tooling, internal file decomposition, fixture implementation, and UI styling. Pin resolved dependencies and container images during implementation. Repository hosting, actual CSV credentials/source, external API semantics, and deployment sizing remain user choices and do not block the first local milestone. Do not publish packages or create external resources as part of local implementation.

## Primary references

- [Temporal MIT server](https://github.com/temporalio/temporal/blob/main/LICENSE)
- [Temporal MIT TypeScript SDK](https://github.com/temporalio/sdk-typescript/blob/main/LICENSE)
- [Workflow determinism](https://docs.temporal.io/workflow-definition)
- [Activity retries and idempotency](https://docs.temporal.io/activity-definition)
- [Temporal Schedules](https://docs.temporal.io/schedule)
- [Workflow versioning](https://docs.temporal.io/develop/typescript/workflows/versioning)
- [Node VM limitations](https://nodejs.org/api/vm.html)
- [Google Sheets append semantics](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/append)
- [PostgreSQL point in time recovery](https://www.postgresql.org/docs/current/continuous-archiving.html)
