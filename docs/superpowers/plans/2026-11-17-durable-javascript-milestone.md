# Durable JavaScript execution implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a local, runnable Temporal-backed workflow slice with a first-class JavaScript Code node, observable results, and tested recovery behavior.

**Architecture:** A TypeScript SDK schedules Temporal activities and durable timers. A controlled runner executes immutable JavaScript modules in constrained containers. A CLI submits and inspects workflows; integration tests exercise a real Temporal service and PostgreSQL deployment.

**Tech Stack:** Node.js 24, TypeScript, npm workspaces, Temporal TypeScript SDK, PostgreSQL, Docker Compose, JSON Schema validation, Node's test runner.

**Spec:** [Self hosted workflow engine design](../specs/2026-11-17-workflow-engine-design.md)

## Global constraints

- Own project code is MIT licensed. Required runtime components must permit an entirely open-source, self-hosted installation without a vendor account.
- TypeScript for the SDK, workers, CLI, and product services. Node.js 24 is the initial supported runtime.
- Temporal owns durable execution state, timers, retry scheduling, and workflow lifecycle. PostgreSQL backs the initial Temporal deployment.
- Initial installation has trusted workflow authors. It is not a service for running hostile public submissions.
- JavaScript entry point: `export default async function(input, context)`.
- Limits: 30-second wall clock, 256 MiB memory, one CPU, 64 processes, 1 MiB input, 1 MiB result, 256 KiB combined stdout/stderr; two-second cancellation grace.
- Arbitrary JavaScript defaults to one execution attempt. Explicit opt-in enables retries for operations whose semantics permit them.
- Workflow source, module hashes, dependencies, and execution routing are immutable per deployment. No runtime package installation.
- Containers run non-root, read-only, without capabilities, privilege escalation, Docker socket, or control-plane credentials. Outbound networking is disabled unless explicitly enabled by deployment configuration.
- Do not publish packages or create external resources as part of local implementation. Product name is Runsett; use private @runsett workspace packages and a runsett CLI.

## Review focus

1. Unsupported or misleading JSON values: reject undefined, non-finite numbers, bigint, cycles, functions, and non-plain object instances instead of silently altering results.
2. Child processes, infinite loops, and log floods: enforce limits and terminate the full invocation container; bound parent buffering.
3. Worker dies after an external effect: stable operation identity across retries; recorded results survive; uncertain effects are never presented as safely absent.
4. Duplicate item/run identity or out-of-order completion: reject duplicate item keys before dispatch; preserve logical run identity and result ordering.
5. Missing old deployment or stale invocation: fail visibly or remain waiting for the correct version; never route to new code or leave unbounded orphan execution.

## Repository layout

All paths below are relative to `/workspace/workflow-engine`.

- `packages/contracts/src/`: JSON types, schemas, IDs, artifact references, errors, and runner limits.
- `packages/sdk/src/`: workflow-safe helpers and public block definitions.
- `packages/runner/src/`: module registry, container lifecycle, invocation protocol, diagnostics, and cleanup.
- `packages/runtime/src/`: Temporal activities, workers, version routing, client operations, and schedule management.
- `packages/cli/src/`: manual submission, inspection, cancellation, and fixture invocation.
- `examples/javascript/`: immutable JS modules and sample versioned workflows.
- `tests/unit/`, `tests/integration/`, `tests/fixtures/`: contract, runner, and real-service recovery tests.
- `deploy/`: Compose topology, container builds, environment example, and development volume configuration.
- `docs/`: developer guide, block authoring guide, operational boundaries, and test evidence.

Initialize an ordinary Git repository inside this project directory if none exists; `/workspace` itself is not a repository. Keep commits local. Resolve compatible current package/image versions, pin them in lockfiles/configuration, and record them in the README. Use no unbounded `latest` image tags in the finished configuration.

## Task 1: Contracts and validation

**Files:** Create root `package.json`, workspace `package.json` files, `tsconfig.json`, `LICENSE`, `.gitignore`, `packages/contracts/src/{json,execution,errors,limits}.ts`, and `tests/unit/contracts.test.ts`.

**Interfaces:**
- `JsonValue` is null, boolean, finite number, string, `JsonValue[]`, or string-keyed plain JSON object.
- `assertJsonValue(value: unknown, maxBytes: number): asserts value is JsonValue` enforces supported values and UTF-8 serialized size.
- `ExecutionIdentity = { workflowId: string; runId: string; stepId: string; attempt: number; operationKey: string; deploymentId: string }`.
- `CodeInvocation = { identity: ExecutionIdentity; moduleId: string; moduleHash: string; input: JsonValue; credentialBindings: string[]; networkMode: 'none' | 'configured'; limits: ExecutionLimits }`.
- `CodeResult = { output: JsonValue; diagnostics: DiagnosticRecord[]; moduleHash: string; startedAt: string; finishedAt: string }`.
- `ExecutionError` has a stable code, message, optional bounded stack, retryability flag, and diagnostics. Codes cover validation, runtime, timeout, cancellation, resources, output limits, and infrastructure.

- [ ] Write `contracts.test.ts`: valid nested values round-trip; unsupported values listed in Review Focus fail; UTF-8 byte boundaries enforce the 1 MiB limit; unknown error codes and invalid limit values fail.
- [ ] Run `npm run test:unit -- contracts`; verify failures are missing implementation assertions after dependencies/build scaffolding resolve.
- [ ] Implement contracts and runtime validation; isolate workflow-safe code from Node-only modules.
- [ ] Run `npm run typecheck` and `npm run test:unit -- contracts`; expect success.
- [ ] Commit contracts, toolchain, and MIT license with appropriate project-contributor attribution.

## Task 2: JavaScript module runner

**Files:** `packages/runner/src/{registry,protocol,container,supervisor,entrypoint,diagnostics}.ts`, runner Dockerfile, `tests/unit/runner.test.ts`, `tests/integration/runner-container.test.ts`, JS fixture modules.

**Consumes:** `CodeInvocation`, `CodeResult`, `ExecutionError`, and limits from Task 1.

**Produces:** `executeCode(invocation: CodeInvocation, signal?: AbortSignal): Promise<CodeResult>`; a registry resolving only known module IDs/hashes; container execution records identifiable by workflow/run/step/attempt.

- [ ] Write fixtures and tests for async transformation, packaged dependency import, syntax/runtime errors, unsupported outputs, log floods, oversize result/input, infinite loop, spawned descendants, cancellation, and module/path/hash mismatch. Verify unrelated environment secrets and Docker socket are absent in the execution container.
- [ ] Run `npm run test:runner`; verify the missing-runner failures.
- [ ] Implement module resolution and serialization. Use a dedicated result channel rather than interpreting ordinary console text as protocol messages. Bound output while streaming, before buffering or parsing the whole result.
- [ ] Implement container creation with the specified limits and hardening, explicit network mode, immutable code mount/image, and invocation-scoped writable storage. Resolve credential bindings only in the supervisor and pass only requested bindings to the invocation.
- [ ] Implement wall-clock enforcement and graceful-then-forced cancellation of the entire container. Label containers with identity and expiry. Startup/periodic reconciliation removes expired invocations and records unknown/terminated outcomes; do not presume a lost worker means no external effects occurred.
- [ ] Add tests for supervisor interruption and expired-container cleanup. Verify a restarted supervisor can account for existing labeled containers and does not exceed their configured lifetime without an explicit unavailable-supervisor limitation.
- [ ] Run runner unit and container tests and `npm run typecheck`; confirm no fixture containers remain.
- [ ] Commit runner and conformance fixtures.

## Task 3: SDK and durable execution integration

**Files:** `packages/sdk/src/{block,workflow,iteration}.ts`, `packages/runtime/src/{activities,worker,client,versioning}.ts`, `examples/javascript/{workflow-v1,workflow-v2}.ts`, `tests/unit/iteration.test.ts`, `tests/integration/temporal.test.ts`, `deploy/compose.yaml`.

**Consumes:** `executeCode`, contracts, module registry, immutable deployment configuration.

**Produces:**
- `BlockDefinition = { name: string; version: string; moduleId: string; moduleHash: string; inputSchema: JsonSchema; outputSchema: JsonSchema; effect: 'pure' | 'read' | 'write'; maximumAttempts: number; credentialBindings: string[]; networkMode: 'none' | 'configured' }`. `JsonSchema` is a JSON Schema 2020-12 object validated by the selected validator; SDK definitions must be serializable and cannot contain executable validator closures. `maximumAttempts` defaults to one and must be a positive integer; pure/read classification alone does not silently enable retries.
- `StartRunRequest = { workflowId: string; deploymentId: string; workflowType: string; input: JsonValue }`. The caller supplies a stable workflow ID as the submission deduplication key. Reusing it returns the existing run only when deployment/type/input fingerprint matches; otherwise reject the conflict. Retain deduplication records for the declared local retention window and document that IDs must not be reused after history expiry. The implementation must choose one durable registry/engine-supported conflict mechanism, not an in-memory map.
- `defineBlock(definition: BlockDefinition): BlockDefinition`, including schemas, module identity, and effect/retry declarations.
- Workflow context `step(id: string, block: BlockDefinition, input: JsonValue): Promise<JsonValue>` and `sleep(milliseconds: number): Promise<void>`.
- `mapItems<T, R>(items: readonly T[], options: { key: (item: T) => string; concurrency: number }, fn: (item: T, key: string) => Promise<R>): Promise<R[]>`, with 1–100 concurrency, prevalidated keys, stable order, and fail-fast semantics.
- `startRun(request: StartRunRequest): Promise<{ workflowId: string; runId: string }>` and `cancelRun(workflowId: string): Promise<void>`.

- [ ] Write tests for one-step execution, one-attempt default, opt-in retry with stable operation key, duplicate run submission, duplicate keys before dispatch, bounded parallelism, ordered results, and invalid concurrency.
- [ ] Add same-ID submissions with changed input/deployment and assert explicit conflict; add same-ID submissions with unchanged input and assert the original run is returned. Validate JSON Schema definitions and reject schemas or block metadata that cannot be serialized.
- [ ] Run unit/integration targets and verify missing implementation failures. Integration tests must explicitly require a running real service; they must not silently pass by skipping it.
- [ ] Create persistent PostgreSQL + Temporal development Compose deployment and health checks; keep database/service endpoints local. Document that this is a development topology.
- [ ] Implement SDK activity boundaries, engine timers, schema validation, operation-key derivation stable across attempts, and Temporal client request identity. Activity payloads carry credential reference names only.
- [ ] Implement version-specific task queues and immutable deployment registration. Version-one and version-two workers must be able to coexist. Retrying an existing run cannot silently select the new queue.
- [ ] Add a workflow with a recorded JS step, durable wait, bounded item processing, and a second JS step. Verify it completes against real Temporal and returns inspectable results.
- [ ] Run `npm run typecheck`, unit tests, and `npm run test:temporal`; commit integration.

## Task 4: CLI, schedules, and inspection

**Files:** `packages/cli/src/{main,submit,inspect,cancel,schedule}.ts`, `packages/runtime/src/{inspection,schedules}.ts`, `tests/integration/cli.test.ts`, `docs/{getting-started,javascript-code-node,custom-blocks}.md`.

**Consumes:** Task 3 client and workflow APIs, Task 2 diagnostics.

**Produces:** private CLI executable `runsett` with `run`, `inspect`, `cancel`, `schedule create`, and `schedule pause`; structured `--json` output and nonzero exit codes for failures.

- [ ] Write CLI tests proving submission IDs, JSON parseability, recorded output/error retrieval, cancellation, missing version visibility, and that inspect does not execute code. Add schedule tests for UTC, overlap skip, and one-hour catch-up configuration.
- [ ] Run `npm run test:cli`; verify failures before commands exist.
- [ ] Implement commands using runtime APIs, with bounded diagnostic retrieval. Separate run state from diagnostic availability; surface incomplete observations rather than fabricating attempt events.
- [ ] Implement schedule creation through Temporal Schedules. Use caller-supplied cadence and explicit defaults from the design; do not create a schedule for the user's real CSV source.
- [ ] Document async JS modules, dependency packaging, input/output contracts, credentials, network mode, limits, idempotency, durable sleep outside code nodes, and fixture-based testing. State subprocess/container isolation boundaries accurately.
- [ ] Run `npm run test:cli` and a documented example from a fresh checkout; commit commands and guides.

## Task 5: Failure harness and milestone evidence

**Files:** `tests/integration/{recovery,versioning,limits}.test.ts`, `tests/fixtures/{receiver,worker-controller}.ts`, `docs/{reliability,operations}.md`, CI workflow.

**Consumes:** complete local runtime, CLI, container runner, and versioned examples.

**Produces:** reproducible failure tests and an evidence report describing observed guarantees and remaining limitations.

- [ ] Add controlled worker termination before a step, after a completed step, during durable sleep, and after a receiver accepts an external request but before the activity result is recorded. Verify checkpointed work remains recorded and idempotency-aware receivers deduplicate repeated attempts.
- [ ] Add two live worker versions: version one sleeps, version two starts new runs, then version one resumes using its original code. Remove the old worker and verify its run waits visibly instead of executing new code.
- [ ] Add duplicate submission with lost client response, retry/cancel races, bounded fan-out saturation, runner log/result overflow, and expired-container cleanup tests.
- [ ] Run tests against the real Compose deployment. Record elapsed recovery, selected version, attempt IDs, and observed side effects. Fail if required integration infrastructure is absent.
- [ ] Execute `npm ci`, `npm run build`, `npm run typecheck`, `npm run test:unit`, `npm run test:integration`, and `docker compose -f deploy/compose.yaml config`. Report actual results; do not label unexecuted checks as passing.
- [ ] Document start/stop, volume persistence, deployment retention, recovery behavior, and the remaining production gates: restore drills, authenticated control plane, shared artifact storage, global quotas, and HA validation.
- [ ] Commit the verified milestone. No push, publication, or production deployment is included.

## Subsequent plans

The next plan delivers the CSV → MySQL → HTTP → Google Sheets reference workflow with artifact streaming, atomic claims, shared throttling, and ambiguous-write reconciliation. Another plan delivers webhook response semantics and the product debugger. Those plans must reuse this SDK and execution contract rather than introducing parallel runtime mechanisms.

## Review and execution choice

The builder check found no important unanswered questions. On 2026-11-17 the user approved this plan and explicitly selected implementation using subagents. Execute the five tasks continuously with task reviews; no additional plan approval is required.
