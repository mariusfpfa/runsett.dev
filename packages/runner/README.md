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
values are redacted before child error truncation, and again by the supervisor,
from diagnostic messages, errors and returned JSON strings
and keys. Redaction is best effort for trusted authors; intentionally encoded
or transformed secrets are outside that guarantee.

Limits may be reduced from the contracts defaults, never raised. Each invocation
gets a non-root, read-only, capability-free container, 16 MiB writable `/tmp`,
no Docker socket, no swap beyond its memory allocation, and disabled Docker log
storage. Networking is `none` unless both invocation and deployment explicitly
select a configured Docker network. Host/container network sharing is rejected.
Cancellation and one absolute deadline cover reconciliation, creation and start.
A PID1 readiness handshake gates delivery of the invocation input, so cancellation
during setup cannot leave input queued for a late Docker start. A known container
name and original expiry allow late create completion to be cleaned up.
The executor's fd3 is reserved for results; ordinary stdout/stderr travel through
a separate bounded diagnostic stream. Both are bounded before whole-message
parsing. The PID1 watchdog is independent of the supervisor: the absolute
wall-clock deadline includes container creation/startup, and timeout/cancellation
allow at most the configured grace before exiting PID1 and killing descendants.

Startup and periodic reconciliation report surviving invocations as `unknown`,
and expired/exited invocations as `terminated-unknown`. The `onReconciliation`
hook must resolve only after durable persistence; cleanup occurs after that
acknowledgement. A rejected hook retains Docker identity/outcome labels for retry.
Without the hook, `reconcile()` performs discovery only and returns the records.
The lower-level `reconcileContainers` likewise requires an explicit
`acknowledge` callback before removing evidence. An unknown outcome never
establishes that no external effect occurred. A live supervisor excludes only
its active container names/IDs; inactive owned containers remain eligible for
periodic cleanup retries after transient removal failures.
The independent watchdog bounds a running orphan even while all supervisors are
down. Stopped container metadata is removed when a supervisor returns. Docker
or host failure can delay cleanup and outcome reporting; this runner cannot
provide availability when its host/daemon is unavailable. Docker is a shared
kernel isolation boundary, and this installation assumes trusted workflow authors.
