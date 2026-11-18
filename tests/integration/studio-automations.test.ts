import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { DeploymentRegistry } from '@runsett/runtime';
import { Connection } from '@temporalio/client';
import Long from 'long';

const exec = promisify(execFile);
async function waitFor<T>(read: () => Promise<T | undefined>, timeout = 45_000): Promise<T> {
  const until = Date.now() + timeout;
  do {
    const value = await read();
    if (value !== undefined) return value;
    await delay(250);
  } while (Date.now() < until);
  throw new Error('Timed out waiting for Studio.');
}

test(
  'manual, webhook and scheduled executions run the saved nodes through a local HTTP receiver',
  { timeout: 180_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'runsett-studio-automation-'));
    const network = 'studio-test-' + randomUUID();
    const receiver = network + '-receiver';
    const ports = createServer().listen(0, '127.0.0.1');
    await once(ports, 'listening');
    const address = ports.address();
    assert.ok(address && typeof address === 'object');
    await new Promise<void>((resolve) => ports.close(() => resolve()));
    const base = 'http://127.0.0.1:' + address.port;
    const db = join(directory, 'workspace.sqlite');
    const registry = new DeploymentRegistry(join(directory, 'deployments'));
    const temporalAddress = process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233';
    const namespace = 'runsett-studio-integration';
    let createdNetwork = false,
      createdReceiver = false;
    let server: ReturnType<typeof spawn> | undefined;
    t.after(async () => {
      if (server && server.exitCode === null && server.signalCode === null) {
        const closed = once(server, 'exit');
        server.kill('SIGTERM');
        const timeout = setTimeout(() => server?.kill('SIGKILL'), 15_000).unref();
        try {
          await closed;
        } finally {
          clearTimeout(timeout);
        }
      }
      try {
        if (createdReceiver) await exec('docker', ['rm', '-f', receiver]);
      } finally {
        if (createdNetwork) await exec('docker', ['network', 'rm', network]);
        await rm(directory, { recursive: true, force: true });
      }
    });
    const connection = await Connection.connect({ address: temporalAddress });
    try {
      await connection.withDeadline(Date.now() + 10_000, async () => {
        try {
          await connection.workflowService.registerNamespace({
            namespace,
            workflowExecutionRetentionPeriod: { seconds: Long.fromNumber(86_400) },
          });
        } catch {
          // Reuse the test namespace on subsequent runs.
          await connection.workflowService.describeNamespace({ namespace });
        }
      });
    } finally {
      await connection.close();
    }
    await exec('docker', ['network', 'create', '--internal', network]);
    createdNetwork = true;
    server = spawn(process.execPath, ['packages/studio/dist/server.js'], {
      env: {
        ...process.env,
        TEMPORAL_ADDRESS: temporalAddress,
        TEMPORAL_NAMESPACE: namespace,
        RUNSETT_STUDIO_PORT: String(address.port),
        RUNSETT_STUDIO_NETWORK: network,
        RUNSETT_STUDIO_DIR: directory,
        RUNSETT_DEPLOYMENTS_DIR: registry.directory,
        RUNSETT_AUDIT_DIR: join(directory, 'audit'),
        RUNSETT_OPEN_BROWSER: '0',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let diagnostics = '';
    server.stderr?.on('data', (chunk) => {
      diagnostics = (diagnostics + String(chunk)).slice(-1600);
    });
    await waitFor(async () => {
      if (server?.exitCode != null) throw new Error('Studio exited. ' + diagnostics);
      const response = await fetch(base + '/api/engine').catch(() => undefined);
      if (!response?.ok) return;
      const health = await response.json();
      if (health.status === 'offline') throw new Error(health.message + '\n' + diagnostics);
      return health.status === 'online' ? true : undefined;
    }, 90_000);
    const [deployment] = await registry.list();
    assert.ok(deployment?.modules[0]);
    // The receiver is reachable only on this test's private network. It cannot send to a real service.
    const echo = `require('node:http').createServer(async (req,res)=>{
    const chunks=[]; for await(const chunk of req) chunks.push(chunk);
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(Buffer.concat(chunks));
  }).listen(8080)`;
    await exec('docker', [
      'run',
      '-d',
      '--network',
      network,
      '--network-alias',
      'receiver',
      '--name',
      receiver,
      '--read-only',
      '--cap-drop',
      'ALL',
      '--entrypoint',
      'node',
      deployment.modules[0].image,
      '-e',
      echo,
    ]);
    createdReceiver = true;
    async function api(path: string, method = 'GET', value?: unknown, extra: Record<string, string> = {}) {
      const response = await fetch(base + path, {
        method,
        headers: { 'Content-Type': 'application/json', ...extra },
        ...(value === undefined ? {} : { body: JSON.stringify(value) }),
      });
      const result = await response.json();
      assert.ok(response.ok, method + ' returned ' + response.status + ': ' + JSON.stringify(result));
      return result;
    }
    const doc = await api('/api/workflows', 'POST', {
      name: 'Webhook to HTTP',
      inputMode: 'text',
      sampleInput: '[{"active":true,"name":"Scheduled"}]',
      steps: [
        { id: 'parse', kind: 'parse-json', name: 'Read event', setting: '' },
        {
          id: 'filter',
          kind: 'filter-list',
          name: 'Active items',
          setting: '{"path":"active","equals":true}',
        },
        { id: 'first', kind: 'field', name: 'First match', setting: '0' },
        { id: 'tag', kind: 'set-field', name: 'Tag item', setting: '{"path":"route","value":"studio"}' },
        {
          id: 'post',
          kind: 'http',
          name: 'Post item',
          setting: JSON.stringify({
            method: 'POST',
            url: 'http://receiver:8080/',
            headers: {},
            body: 'input',
            customBody: '',
          }),
        },
        {
          id: 'check',
          kind: 'choose',
          name: 'Check response',
          setting: '{"path":"body.route","equals":"studio","then":"accepted","else":"declined"}',
        },
      ],
    });
    const workflow = '/api/workflows/' + doc.id;
    const enabled = await api(workflow + '/triggers', 'PUT', {
      webhook: { enabled: true },
      schedule: { enabled: true, intervalMinutes: 1 },
    });
    assert.ok(enabled.webhook.path);
    const input = '[{"active":false},{"active":true,"name":"Webhook"}]';
    const key = { 'Idempotency-Key': 'same-event' };
    const hook = await api(enabled.webhook.path, 'POST', input, key);
    const again = await api(enabled.webhook.path, 'POST', input, key);
    assert.equal(again.workflowId, hook.workflowId);
    const manual = await api(workflow + '/runs', 'POST', { revision: doc.revision, requestId: randomUUID() });
    assert.notEqual(hook.workflowId, manual.workflowId);
    // Seed an overdue occurrence in this isolated database, as on recovery after a minute offline.
    const clock = new DatabaseSync(db);
    try {
      clock
        .prepare('UPDATE studio_triggers SET next_at = ? WHERE workflow_id = ?')
        .run(Date.now() - 1000, doc.id);
    } finally {
      clock.close();
    }
    const runs = await waitFor(async () => {
      const rows: { id: string; runId: string; state: string; triggerName: string }[] = await api(
        workflow + '/run-options',
      );
      for (const row of rows) {
        if (!['RUNNING', 'COMPLETED'].includes(row.state))
          assert.fail(JSON.stringify(await api('/api/runs/' + row.id)));
      }
      return rows.filter((row) => row.state === 'COMPLETED').length === 3 ? rows : undefined;
    });
    await api(workflow + '/triggers', 'PUT', {
      webhook: { enabled: false },
      schedule: { enabled: false, intervalMinutes: 1 },
    });
    assert.deepEqual(runs.map((row) => row.triggerName).sort(), ['Manual trigger', 'Schedule', 'Webhook']);
    for (const run of runs) {
      const details = await api('/api/runs/' + run.id);
      assert.equal(details.output, 'accepted');
      assert.equal(details.triggerName, run.triggerName);
      const query = new URLSearchParams({ executionId: run.id, runId: run.runId });
      const output = await api(workflow + '/steps/post/output?' + query);
      const name = run.id === hook.workflowId ? 'Webhook' : 'Scheduled';
      assert.deepEqual(output.value, { status: 200, body: { active: true, name, route: 'studio' } });
    }
    assert.equal(
      (
        await fetch(base + enabled.webhook.path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: 'null',
        })
      ).status,
      404,
    );
  },
);
