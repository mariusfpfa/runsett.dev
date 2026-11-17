# JavaScript Code modules

Bake an ESM module into the runner image at deployment build time. Its entry point
is async and receives JSON input plus an explicit invocation context:

```js
export default async function(input, context) {
  context.log(`attempt ${context.attempt}`);
  return { answer: await Promise.resolve(input.value * 2) };
}
```

Input and output must be strict JSON: no `undefined`, functions, cycles, BigInt,
NaN, Infinity, or sparse arrays. Await all work before returning. Input and result
are each limited to 1 MiB; block JSON Schemas validate both. Structured errors
classify validation, runtime, timeout, cancellation, resource, output-limit and
infrastructure failures. Inspect stored results/errors with `--details`, and
captured redacted stdout/stderr with `--logs`. Logs are not a durable side-effect
acknowledgement. Failed code may already have changed an external system.

Context exposes `operationKey` (stable across retry attempts), `attempt`,
`signal`, `credentials`, and `log`. Use `console.error` for stderr. Only declared
credential reference names are resolved into `context.credentials` by the worker. Values are never stored in
invocation manifests or workflow history by the runtime. Avoid logging values or
embedding them in output, errors, workflow inputs, module source or command-line
arguments. Redaction is best effort for trusted authors; it is not a defense
against hostile code or derived/encoded secrets.

Dependencies must be installed at image build time and included in the immutable
module image. Workflow dependency identity is pinned by the lockfile hash and
stored workflow bundle; module source has its own SHA-256. Runtime package
installation is unsupported. Use `packages/runner/Dockerfile` and
`npm run example:register` as a concrete packaging fixture. New source,
dependencies or routing need a new deployment ID; retain old bundles/images and
workers to resume old runs.

Each invocation has a 30-second wall-clock limit, 256 MiB memory, one CPU,
64 processes, 256 KiB combined stdout/stderr, and a two-second cancellation grace.
Containers run non-root with a read-only root, bounded writable tmpfs, no
capabilities, no privilege escalation, Docker socket or control-plane credentials.
The supervisor alone owns Docker lifecycle privileges. The default network is
`none`; outbound access requires a block with `networkMode: 'configured'` and an
explicit named network pinned in the deployment. Network policy is not an
application-level host allowlist. Do not use the host network.

The optional subprocess runner is a development convenience, **not an isolation
boundary**. Container conformance tests exercise the production-style local
boundary. This milestone trusts workflow/module authors and is not a service for
hostile public submissions. A subprocess test cannot establish container memory,
filesystem, credential, process or network confinement.

Long waits belong in deterministic workflow code using `await context.sleep(ms)`.
Temporal persists that timer outside the code invocation. A sleep or unawaited
background task inside this module is bounded by the same 30-second invocation
limit and does not become durable. An abort signal gives cooperative cancellation;
the runner enforces cleanup after the grace period. Cancellation does not roll
back external effects.

Use fixtures with known JSON, deterministic responses and synthetic credentials
before real integrations. Run both ordinary success and failure fixtures, schema
rejection, unsupported output, log/output limits, timeout and cancellation against
the actual container. For write retries test that repeated attempts use the same
operation key and the target enforces idempotency. Default `maximumAttempts: 1`
prevents automatic blind retries; enabling retries is an explicit semantic choice.
