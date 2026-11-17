# JavaScript runner

`createCodeExecutor({ registry, credentials, scope, onReconciliation })` returns
an `executeCode(invocation, signal?)` function. Call `close()` when shutting down
the supervisor. The standalone `executeCode` export has an empty registry and
rejects invocations until a deployment provides its own configured executor.

Register logical module IDs with SHA-256 content hashes, absolute image paths
under `/opt/runsett/modules/`, and immutable Docker image IDs or repository
content digests. Invocation paths, mutable image tags and unregistered hashes
are rejected. The executor verifies the actual entry module hash before import.
The image digest also pins all relative imports and packaged dependencies.

Run `npm run build`, then `docker build -f packages/runner/Dockerfile .` for the
conformance image. `MODULE_BUNDLE` selects a different ESM directory at build
time. A deployment may derive its own image from the built runner image and
COPY its modules and lockfile-installed production dependencies into
`/opt/runsett/modules` and `/opt/runsett/node_modules`. Register the resulting
image ID, not a tag. Files must be readable by UID 1000. No packages are
installed at invocation time. The fixture dependency is MIT-licensed
`is-number@7.0.0`; Node's base image is pinned by digest.

Only selected credential binding values are sent through ephemeral stdin, never
Docker environment, arguments, labels or files. The module context contains
`operationKey`, `attempt`, `signal`, `log(...values)` and `credentials`. The child
receives only PATH and HOSTNAME environment variables. Known credential literal
values are redacted from diagnostic messages, errors and returned JSON strings
and keys. Redaction is best effort for trusted authors; intentionally encoded
or transformed secrets are outside that guarantee.

Limits may be reduced from the contracts defaults, never raised. Each invocation
gets a non-root, read-only, capability-free container, 16 MiB writable `/tmp`,
no Docker socket, no swap beyond its memory allocation, and disabled Docker log
storage. Networking is `none` unless both invocation and deployment explicitly
select a configured Docker network. Host/container network sharing is rejected.
The executor's fd3 is reserved for results; ordinary stdout/stderr travel through
a separate bounded diagnostic stream. Both are bounded before whole-message
parsing. The PID1 watchdog is independent of the supervisor: the absolute
wall-clock deadline includes container creation/startup, and timeout/cancellation
allow at most the configured grace before exiting PID1 and killing descendants.

Startup and periodic reconciliation report surviving invocations as `unknown`,
and expired/exited invocations as `terminated-unknown` before cleanup. Use the
`onReconciliation` hook to persist these records in the surrounding runtime;
`reconcile()` also returns them directly. An unknown outcome never establishes
that no external effect occurred. A live supervisor excludes its own active
containers from orphan cleanup; a replacement receives a new owner identity.
The independent watchdog bounds a running orphan even while all supervisors are
down. Stopped container metadata is removed when a supervisor returns. Docker
or host failure can delay cleanup and outcome reporting; this runner cannot
provide availability when its host/daemon is unavailable. Docker is a shared
kernel isolation boundary, and this installation assumes trusted workflow authors.
