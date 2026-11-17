# Runsett

Runsett is an MIT-licensed, self-hosted workflow engine under development.
The approved [design](docs/superpowers/specs/2026-11-17-workflow-engine-design.md)
and [milestone plan](docs/superpowers/plans/2026-11-17-durable-javascript-milestone.md)
describe the intended Temporal-backed execution architecture.

## Run locally

Use Node.js 24, npm 11 and Docker Compose. All `@runsett/*` workspace packages
are private. No vendor account is required.

```sh
npm ci --cache /tmp/runsett-npm-cache
npm run build
docker compose -f deploy/compose.yaml up -d --wait
npm run example:register
npm exec -- runsett --help
```

Follow [Getting started](docs/getting-started.md) to start a worker, submit a
fixture, inspect recorded results, cancel a run, and create/pause a fixture
schedule. Temporal's local operator UI is at <http://127.0.0.1:8080>.

Authoring guides: [JavaScript Code](docs/javascript-code-node.md) and
[Custom blocks](docs/custom-blocks.md). Low-level APIs and operational boundaries
are in the [runtime README](packages/runtime/README.md) and
[runner README](packages/runner/README.md).

```sh
npm run typecheck
npm test
npm run test:integration
```

Integration tests require real running Temporal/PostgreSQL Compose services and Docker, fail if missing, and run suites in series.
See [reliability evidence](docs/reliability.md) and [operations](docs/operations.md)
for failure boundaries, deployment retention and remaining production gates.
This first milestone implements the durable JavaScript vertical slice;
connectors, webhooks, shared artifact hosting and a custom graphical debugger
remain future work.

## License

[MIT](LICENSE), copyright (c) 2026 mariusfpfa.
