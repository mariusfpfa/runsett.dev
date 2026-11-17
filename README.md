# Runsett

Runsett is an MIT-licensed, self-hosted workflow engine under development.
The approved [design](docs/superpowers/specs/2026-11-17-workflow-engine-design.md)
and [milestone plan](docs/superpowers/plans/2026-11-17-durable-javascript-milestone.md)
describe the intended Temporal-backed execution architecture.

## Local development

Use Node.js 24 and npm 11 (verified with Node 24.22.1 and npm 11.9.0).
All `@runsett/*` workspace packages are private.

```sh
npm ci
npm run build
npm run typecheck
npm run test:unit
npm run test:unit -- contracts
```

The initial contracts package exports JSON, invocation/result/error validation,
and configurable execution limits. Its built ESM entry points are
`@runsett/contracts`, `@runsett/contracts/json`, `@runsett/contracts/execution`,
`@runsett/contracts/errors`, and `@runsett/contracts/limits`. They have no Node
runtime imports and can be imported by deterministic workflow code. Validation
throws actionable `TypeError` or `RangeError` instances; execution failures use
the serializable `ExecutionErrorData` representation and `ExecutionError` class.

Pinned development dependencies: TypeScript 5.9.3, tsx 4.23.15, and
`@types/node` 24.19.2. `package-lock.json` pins their transitive dependencies.
The remaining workspace manifests reserve the SDK, runner, runtime, and CLI
packages for later milestone tasks.

## License

[MIT](LICENSE), copyright (c) 2026 mariusfpfa.
