#!/usr/bin/env node
import { Client, Connection } from '@temporalio/client';
import { DeploymentRegistry, createRunClient, createScheduleClient } from '@runsett/runtime';
import { parseOptions } from './options.js';
import { submit } from './submit.js';
import { inspect } from './inspect.js';
import { cancel } from './cancel.js';
import { schedule } from './schedule.js';
const help = `Runsett — local durable workflow CLI (Node.js 24)
runsett run --id ID --deployment ID --workflow TYPE [--input JSON | --input-file PATH]
runsett inspect ID [--details] [--logs] [--max-events 1..1000] [--max-log-bytes 1..262144]
runsett cancel ID
runsett schedule create --id ID --deployment ID --workflow TYPE --cron '0 * * * *' [--timezone UTC] [--input JSON | --input-file PATH]
runsett schedule pause ID
All commands accept --json. Payloads require --details; diagnostic messages require --logs.
Configuration: TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE, RUNSETT_DEPLOYMENTS_DIR, RUNSETT_AUDIT_DIR.
`;
async function main() {
  const args = process.argv.slice(2); const json = args.includes('--json'); let connection: Connection | undefined;
  try {
    if (args.length === 0 || args[0] === '--help' || args[0] === 'help') { process.stdout.write(json ? JSON.stringify({ help }) + '\n' : help); return; }
    const command = args.shift()!; const action = command === 'schedule' ? args.shift() : undefined;
    const allowed = command === 'run' ? ['id', 'deployment', 'workflow', 'input', 'input-file'] : command === 'inspect' ? ['details', 'logs', 'max-events', 'max-log-bytes'] : command === 'schedule' && action === 'create' ? ['id', 'deployment', 'workflow', 'cron', 'timezone', 'input', 'input-file'] : [];
    const { options, positional } = parseOptions(args, [...allowed, 'json']);
    if (!['run', 'inspect', 'cancel', 'schedule'].includes(command)) throw new TypeError('Unknown command; use runsett --help');
    if ((command === 'run' && positional.length) || (['inspect', 'cancel'].includes(command) && positional.length !== 1)) throw new TypeError('Invalid command arguments; use runsett --help');
    connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233', connectTimeout: '5s' });
    const client = new Client({ connection, namespace: process.env.TEMPORAL_NAMESPACE ?? 'default' });
    const deployments = new DeploymentRegistry(process.env.RUNSETT_DEPLOYMENTS_DIR ?? '.runsett/deployments');
    const runs = createRunClient({ client, deployments });
    const result = await connection.withDeadline(Date.now() + 15_000, async () => {
      if (command === 'run') return submit(runs, options);
      if (command === 'inspect') return inspect({ client, deployments, auditDirectory: process.env.RUNSETT_AUDIT_DIR ?? '.runsett/audit' }, positional[0]!, options);
      if (command === 'cancel') return cancel(runs, positional[0]!);
      return schedule(createScheduleClient({ client, deployments }), action ?? '', positional, options);
    });
    process.stdout.write(JSON.stringify(result, null, json ? undefined : 2) + '\n');
  } catch (error) {
    // Never echo payloads, module bundles, credential paths/values, or remote failure details.
    const code = error instanceof Error ? error.name : 'Error';
    const message = error instanceof TypeError || error instanceof RangeError ? 'Invalid request; use runsett --help and check input limits.' : 'Command failed; check service, run/schedule ID, and immutable deployment availability.';
    const result = { error: { code, message } };
    if (json) process.stdout.write(JSON.stringify(result) + '\n'); else process.stderr.write(`${code}: ${message}\n`);
    process.exitCode = 1;
  } finally { await connection?.close(); }
}
await main();
