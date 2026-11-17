# Reliability evidence

Runsett stores execution history, step results, retry scheduling and durable timers in Temporal, backed by PostgreSQL. Workers and JavaScript containers can be replaced. A replacement must load the original immutable deployment record, workflow bundle and exact runner image; source files are never rebuilt to resume an old run.

## Reproduce the milestone

Use Node.js 24, npm 11 and Docker on Linux. Start the real services as described in [operations](operations.md), then run:

```sh
npm ci
npm run build
npm run typecheck
npm run test:unit
npm run test:integration
docker compose -f deploy/compose.yaml config
```

The integration command runs suites in series. It requires a healthy Compose PostgreSQL and Temporal service and real Docker; absence fails setup. Docker-heavy suites previously running concurrently missed a readiness bound; isolated Task4 runner tests passed 22/22. Serial execution is part of the reproducible test setup. CI uses the same real services and retains receiver observations, worker logs and Compose diagnostics.

The failure fixtures start the real stored-deployment entry process and send SIGKILL. Gates use recorded Temporal history, positive worker RUNNING logs, and receiver acceptance rather than an assumed delay. The HTTP receiver independently stores an accepted operation by operation key before withholding the response. After worker death, retry attempt IDs and receiver records must show two requests and one committed operation. Equal key strings alone do not establish deduplication.

On managed hosts, the Docker gateway may belong to a different network namespace from the test process. The harness enumerates local interfaces plus the Docker bridge gateway and probes its receiver's unique health token from the runner image. `RUNSETT_RECEIVER_HOST` can explicitly select a reachable host interface. This discovery belongs only to the test harness.

## Guarantees under test

| Boundary | Required observation |
| --- | --- |
| Before first step | Timer recorded, zero dispatched steps, killed worker replaced, first attempt succeeds |
| Completed step, durable sleep | Completed result recorded before kill; timer survives; first external operation is never reissued |
| Receiver accepted, no completed Activity | Actual committed side effect precedes kill; replacement retries; receiver stores one operation across attempts 1 and 2 |
| Two worker versions | Live v2 runs new code; killed v1 leaves original run RUNNING after timer fires; restored original deployment returns version 1 |
| Same ID/version, different registries | Changed content has a distinct queue; its live worker cannot resume the old sleeping run; the original worker returns version 1 |
| Deployment identity | Changed-content same-ID submission conflicts; inspection reports artifact mismatch; manual and schedule metadata retain the full fingerprint; legacy metadata remains unsupported |
| Submission response discarded | Same-ID retry returns the accepted run; one workflow and one external operation |
| Retry/cancel race | Cancellation reaches terminal engine state; receiver still commits at most one operation |
| Fan-out saturation | Two held external requests, no third Activity until capacity releases; all five items complete |
| Log/result overflow | OUTPUT_LIMIT recorded on attempt 1 even for an explicit retry policy |
| Expired orphan | Durable unknown-outcome audit is acknowledged before removal |

Worker absence is controlled in the versioning test: the harness knows it killed v1, v2 positively completes another run, and v1 has pending recorded work on a distinct queue. Inspection reports RUNNING, the original deployment version and a pending activity/workflow task. It does not infer permanent worker absence from recent pollers or assert that an unknown external effect did not happen.

The content-collision regression uses two real local registries with identical deployment ID/version but different stored workflow code. It kills the original worker during a durable timer, proves the replacement worker executes new code, observes the original run waiting after its timer fires, then restores the original worker and result. Queue identity binds the registered content fingerprint rather than trusting names across registry directories. See the [prerelease migration boundary](operations.md#prerelease-migration-boundary) for older unbound metadata and queues.

Concrete measurements and command outcomes for this checkout are recorded in `.superpowers/sdd/durable-javascript/task-5-report.md`, with raw logs and JSONL observations alongside it in `task-5-evidence/`. These are local milestone observations, not a latency SLA or a production HA claim. Recovery time includes engine timeout, process readiness and work completion.

## Observed local milestone run

On 2026-11-17, Node 24.22.1/npm 11.9.0 with Docker 29.9.2/Compose 2.40.3 passed the required fresh install, build, typecheck and Compose configuration checks, plus 50/50 unit and 39/39 serial real-infrastructure integration cases (zero skips). Integration took 327.220s. Hosted CI has not been executed as part of this local verification.

Final-review fixes on the same date passed a fresh install, build, typecheck, Compose configuration, 53/53 unit tests and 48/48 reported serial integration tests (42 top-level cases plus six identity/legacy subtests; zero skips). These add same-name cross-registry isolation, retained content identity, schedule metadata and early attachment-exit regressions. Commands and raw evidence are in `.superpowers/sdd/durable-javascript/final-fix-report.md` and `final-fix-evidence/`. The measurements below remain the earlier Task5 observations, not fresh latency guarantees.

| SIGKILL boundary | Kill to final result | Selected version |
| --- | --- | --- |
| Before first step | 19370ms | 1 |
| Completed step, durable timer | 16635ms | 1 |
| Receiver accepted before checkpoint | 17415ms | 1 |
| Old version absent, then restored | 38109ms | 1 |

The accepted-effect case observed attempts 1 and 2 with receiver duplicate flags false/true and one committed operation. The retry/cancel case reached CANCELLED after attempts 1 and 2. Fan-out held at most 2 requests while completing 5 items. Both log/result overflows recorded terminal OUTPUT_LIMIT on attempt 1. The old-version measurement includes its intentional 30s timer and time without its worker; these measurements are observations from one local run.

## Execution and effect semantics

A completed step is an Activity result in Temporal history. Replay returns that result. A running Activity interrupted before completion may have committed an external effect; engine history alone cannot prove otherwise. Arbitrary JavaScript defaults to one attempt. Retries require explicit opt-in and receiver-side idempotency where effects matter. Receiver deduplication must be durable and atomic in a production receiver; the fixture's independent in-memory store survives worker death, but this milestone does not kill the receiver.

Cancellation is a request, followed by a terminal workflow outcome. It cannot reverse an already accepted external effect. Reconciliation records unknown outcomes durably before deleting expired containers. Diagnostic absence is not evidence of no effect. Inspection deliberately reports incomplete retry history because Temporal may compact intermediate Activity retries.

Per-node JSON and log limits and bounded fan-out do not bound total Temporal command batches, payloads or history. Long or large workflows need application batching and artifact references; a continuation/Continue-As-New design remains future work. This milestone establishes no unbounded workflow capacity or measured aggregate engine limit.

## Remaining production gates

Before production use: perform PostgreSQL backup/restore drills that restore Temporal state and matching immutable deployment artifacts; authenticate and authorize the control plane; provide shared durable artifact/image storage and retention; enforce global quotas across workers; and validate Temporal/PostgreSQL/control-plane high availability under node and network failures. This milestone kills worker processes, not database nodes, receiver storage or an entire cluster. Trusted workflow authors remain the installation model.
