# Runsett

**Code-first automation. Self-hosted. MIT licensed.**

Runsett is a workflow engine for developers. Write TypeScript workflows with
explicit steps, author JavaScript blocks yourself or with any AI coding agent,
and inspect what happened through a structured CLI and Temporal's operator UI.
The runtime runs on your own infrastructure without a vendor account.

Runsett Studio is the local browser editor. Create a workflow, add and configure
steps on the canvas, and select **Run workflow** to see the execution and output.
Open **Step library** to search the available nodes. The **Welcome message**
workflow is ready to try.

| Node | What it does |
| --- | --- |
| Manual trigger | Starts on demand with the saved text or JSON input. |
| Schedule | Starts at a recurring interval in minutes using the saved input. |
| Webhook | Starts a run from the JSON body sent to its private local POST URL. |
| HTTP request | Sends GET, POST, PUT, PATCH, or DELETE and returns the status and response body. |
| Send Slack message | Posts as the signed-in Slack user to a channel selected from their workspace. |
| Send Teams message | Posts as the signed-in Microsoft user to a channel in one of their teams. |
| Parse JSON / Read field | Converts JSON text to a value or reads a dotted field path. |
| Set field / Filter list | Sets a nested object field or keeps array items matching a JSON value. |
| Choose value | Compares an input field and returns one of two configured values. |
| Format text / Compose message | Formats a string or inserts the previous value into a message. |
| Wait / JavaScript | Waits for a duration or runs a custom JavaScript function. |

Each workflow can have a manual, schedule, and webhook trigger active together.
Open the trigger in the library to configure it. Enabling a webhook creates a
private URL. Send JSON with `Content-Type: application/json` and optionally an
`Idempotency-Key` to reuse the same submission when retrying a request.
Disabling the webhook revokes that URL. Studio listens on loopback. A service
on another machine needs a route to the webhook endpoint.

Schedules run while Studio and the engine are online. The scheduler stores the
next occurrence on disk. On restart it can submit one missed occurrence and
then resumes the configured interval. Run history and the recorded-input picker
show which trigger started the run.

To send a message, add **Send Slack message** or **Send Teams message** in the
step library. Sign in from the step inspector, then choose the channel. For
Teams, choose a team first. Enter a message and use `{{value}}` anywhere you
want the previous step’s output. The live test in the step inspector sends one
message to that channel.

The first sign-in for each provider requires a public application client ID.
The setup dialog shows the exact localhost redirect URL for this Studio instance.

- **Slack** — Select **Create a Slack app for Runsett**, choose your workspace,
  and confirm the prefilled app. It includes the redirect URL, PKCE, and the
  `channels:read`, `groups:read`, and `chat:write` user scopes. Copy the
  **Client ID** from **Basic Information** and paste it into Studio.
  [Slack app manifests](https://docs.slack.dev/app-manifests/configuring-apps-with-app-manifests/) ·
  [Slack desktop authorization](https://docs.slack.dev/authentication/using-pkce/)
- **Microsoft Teams** — In Microsoft Entra **App registrations**, register an
  app for accounts in any organizational directory. Under **Authentication**,
  add the **Mobile and desktop applications** platform with Studio’s redirect
  URL. Add the Microsoft Graph delegated permissions `User.Read`,
  `Team.ReadBasic.All`, `Channel.ReadBasic.All`, and `ChannelMessage.Send`,
  then paste the **Application (client) ID** into Studio. Sign in with a work
  or school account. Your organization may require administrator consent.
  [Microsoft desktop app registration](https://learn.microsoft.com/en-us/entra/identity-platform/scenario-desktop-app-registration) ·
  [Teams channel messaging](https://learn.microsoft.com/en-us/graph/api/channel-post-messages?view=graph-rest-1.0)

Studio keeps provider tokens in its local connection database. Each workflow
stores a reference to its account and selected channel. You can reuse a signed-in
account across workflows and reconnect it from the inspector. Previously saved
incoming-webhook connections still deliver to their configured destinations.

The HTTP node accepts headers, the previous value as a JSON body, or a custom
text body. For bearer authentication, create a named connection for the API's
HTTPS origin. Studio attaches that token to requests for that origin. Use
the header fields for non-secret values. JSON responses are decoded. Other response bodies are
returned as text. Requests and messages use one attempt, and their individual
test buttons make a real request. Connectors run on a Docker bridge. Set
`RUNSETT_STUDIO_NETWORK` to use an existing Docker network when reaching a
local service by container name. Authored JavaScript and data nodes run with
networking disabled.

Choose **Add step → JavaScript** to open the code editor. Write an exported
default function that receives the previous step’s value as `input`. Enter a
Text or JSON sample, or click **Use previous step output** for the latest
available value. **Source run** lists this workflow’s 50 most recent runs.
Pick a run, choose **Source step**, and click **Load selected output** to use
that execution’s trigger input, a step’s output, or the final result. The step
list uses the names and order saved with that run. You can edit the imported
sample before clicking **Test step**.

Other steps have a **Test step** button in their inspector. **Test with input…**
opens the same picker for the whole workflow. **Run workflow with this input**
starts a new execution using the test value. The saved manual trigger keeps
its configured input. JavaScript and built-in action tests use the workflow’s
local Docker runner. Standalone wait tests wait for the configured duration.

On macOS, double-click [Runsett Studio.command](<Runsett Studio.command>) in
Finder. On Linux, start Docker and run `npm run dev` from the repository root.
The launcher uses Node.js 24, installs missing dependencies, starts the included
Compose services and runs the Studio worker. Open [Runsett Studio](http://localhost:4310).
Workflow drafts and their run snapshots are stored in `.runsett/studio/`.
Temporal records executions, including the workflow revision submitted with each run.

The first engine milestone implements durable JavaScript execution, schedules,
inspection, and recovery tests. This is an early foundation, with
[production readiness work](docs/operations.md) still ahead. Built-in CSV,
database, and Google Sheets connectors and custom webhook response delivery are
planned next.

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
| `@runsett/studio` | Local visual workflow editor, worker, and run history |

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
