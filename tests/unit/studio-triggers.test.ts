import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import type { JsonValue } from '@runsett/contracts';
import { greeting, RequestError, type AutomaticTrigger } from '../../packages/studio/src/model.js';
import { StudioStore } from '../../packages/studio/src/store.js';
import { StudioTriggers } from '../../packages/studio/src/triggers.js';

const minute = 60_000;
type Fire = (
  id: string,
  revision: number,
  requestId: string,
  input: JsonValue | undefined,
  trigger: AutomaticTrigger,
) => Promise<string>;

function workspace(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'runsett-studio-triggers-'));
  const file = join(directory, 'workspace.sqlite');
  const store = new StudioStore(file);
  const workflow = store.create(greeting());
  const services: StudioTriggers<string>[] = [];
  const calls: Parameters<Fire>[] = [];
  let time = Date.parse('2026-06-01T10:00:00.000Z');
  let available = true;
  const open = (run?: Fire) => {
    const service = new StudioTriggers(file, {
      getWorkflow: (id) => store.get(id),
      getSubmissionRevision: (id, requestId) => store.getSubmission('studio-' + id + '-' + requestId)?.revision,
      isAvailable: () => available,
      now: () => time,
      run: async (...args) => {
        calls.push(args);
        if (run) return run(...args);
        const [id, revision, requestId, input, trigger] = args;
        return store.prepareRun(id, revision, requestId, 'deployment', input, trigger).id;
      },
    });
    services.push(service);
    return service;
  };
  t.after(async () => {
    await Promise.all(services.map((service) => service.close()));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    file,
    store,
    workflow,
    calls,
    open,
    advance: (ms: number) => { time += ms; },
    setAvailable: (online: boolean) => { available = online; },
  };
}

const status = (code: number) => (error: unknown) => error instanceof RequestError && error.status === code;

function enableWebhook(service: StudioTriggers<string>, id: string) {
  const { path } = service.update(id, { webhook: { enabled: true } }).webhook;
  assert.ok(path);
  return path.split('/').pop()!;
}

test('existing workflows start with both automatic triggers off; settings persist independently', async (t) => {
  const { open, workflow, advance } = workspace(t);
  const triggers = open();
  const id = workflow.id;
  assert.deepEqual(triggers.get(id), {
    webhook: { enabled: false },
    schedule: { enabled: false, intervalMinutes: 15 },
  });
  const enabled = triggers.update(id, {
    webhook: { enabled: true },
    schedule: { enabled: true, intervalMinutes: 3 },
  });
  assert.match(enabled.webhook.path!, new RegExp('^/hooks/' + id + '/[A-Za-z0-9_-]{43}$'));
  assert.deepEqual(enabled.schedule, { enabled: true, intervalMinutes: 3, nextAt: '2026-06-01T10:03:00.000Z' });
  advance(minute);
  assert.deepEqual(triggers.update(id, { schedule: { enabled: true, intervalMinutes: 3 } }), enabled);
  assert.deepEqual(triggers.update(id, { webhook: { enabled: true } }), enabled);
  await triggers.close();
  const restarted = open();
  assert.deepEqual(restarted.get(id), enabled);
  const rescheduled = restarted.update(id, { schedule: { enabled: true, intervalMinutes: 4 } });
  assert.deepEqual(rescheduled.schedule, {
    enabled: true, intervalMinutes: 4, nextAt: '2026-06-01T10:05:00.000Z',
  });
  const disabled = restarted.update(id, { schedule: { enabled: false, intervalMinutes: 7 } });
  assert.deepEqual(disabled, { webhook: enabled.webhook, schedule: { enabled: false, intervalMinutes: 7 } });
});

test('bad settings cannot partially enable triggers, and unknown workflows cannot acquire a trigger', (t) => {
  const { open, workflow } = workspace(t);
  const triggers = open();
  const before = triggers.get(workflow.id);
  const invalid = [
    null, [], false, { other: true }, { webhook: [] }, { webhook: {} }, { webhook: { enabled: 1 } },
    { webhook: { enabled: true, token: 'chosen' } }, { schedule: { enabled: 'yes', intervalMinutes: 1 } },
    { schedule: { enabled: false } }, { schedule: { enabled: false, intervalMinutes: 1, nextAt: 'today' } },
    ...[0, 2.5, 525_601, '5', null, Infinity].map((intervalMinutes) => ({
      webhook: { enabled: true }, schedule: { enabled: true, intervalMinutes },
    })),
  ];
  for (const patch of invalid) {
    assert.throws(() => triggers.update(workflow.id, patch), status(400));
    assert.deepEqual(triggers.get(workflow.id), before);
  }
  assert.throws(() => triggers.update(randomUUID(), { webhook: { enabled: true } }), status(404));
  assert.throws(() => triggers.get(randomUUID()), status(404));
  const annual = triggers.update(workflow.id, { schedule: { enabled: true, intervalMinutes: 525_600 } });
  assert.equal(annual.schedule.nextAt, '2027-06-01T10:00:00.000Z');
});

test('a revoked webhook cannot be called, even after it is enabled again', async (t) => {
  const { open, workflow, calls } = workspace(t);
  const service = open();
  const token = enableWebhook(service, workflow.id);
  service.assertWebhook(workflow.id, token);
  const off = service.update(workflow.id, { webhook: { enabled: false } });
  assert.deepEqual(off.webhook, { enabled: false });
  assert.throws(() => service.assertWebhook(workflow.id, token), status(404));
  const token2 = enableWebhook(service, workflow.id);
  assert.notEqual(token, token2);
  const invalid = [[workflow.id, token], [workflow.id, 'short'], [randomUUID(), token2], ['unknown', token2]] as const;
  for (const [id, secret] of invalid) {
    await assert.rejects(service.webhook(id, secret, undefined), status(404));
  }
  assert.equal(calls.length, 0);
});

test('webhook runs keep their JSON input and per-workflow identity across edits', async (t) => {
  const { open, workflow, store, calls } = workspace(t);
  const service = open();
  const token = enableWebhook(service, workflow.id);
  for (const value of [false, 0, '', null, ['a', 1], { item: 2 }] as JsonValue[]) {
    const id = await service.webhook(workflow.id, token, value);
    assert.deepEqual(store.getSubmission(id)?.input.value, value);
    assert.equal(store.getSubmission(id)?.input.trigger, 'webhook');
  }
  assert.equal(new Set(calls.map((call) => call[2])).size, 6);
  const first = await service.webhook(workflow.id, token, false, 'customer-42');
  store.save(workflow.id, 1, { ...workflow.document, sampleInput: 'new default' });
  await service.close();
  const restarted = open();
  assert.equal(await restarted.webhook(workflow.id, token, false, 'customer-42'), first);
  assert.equal(calls.at(-1)?.[1], 1);
  await assert.rejects(restarted.webhook(workflow.id, token, true, 'customer-42'), status(409));
  const other = store.create(greeting());
  const otherToken = enableWebhook(restarted, other.id);
  await assert.rejects(restarted.webhook(other.id, token, false, 'customer-42'), status(404));
  const second = await restarted.webhook(other.id, otherToken, false, 'customer-42');
  assert.notEqual(second.slice(-36), first.slice(-36));
});

test('invalid webhook inputs, oversized keys and an offline engine create no submission', async (t) => {
  const { open, workflow, calls, setAvailable } = workspace(t);
  const service = open();
  const token = enableWebhook(service, workflow.id);
  for (const input of [undefined, Infinity, { nested: undefined }, 'x'.repeat(1024 * 1024)]) {
    await assert.rejects(service.webhook(workflow.id, token, input), status(400));
  }
  for (const key of ['', ['two', 'keys'], 'k'.repeat(257), 'line\nbreak']) {
    await assert.rejects(service.webhook(workflow.id, token, {}, key), status(400));
  }
  setAvailable(false);
  await assert.rejects(service.webhook(workflow.id, token, false), status(503));
  assert.equal(calls.length, 0);
});

test('overdue schedules catch up once with the current revision and keep the original cadence', async (t) => {
  const { open, workflow, store, calls, advance, setAvailable } = workspace(t);
  const first = open();
  first.update(workflow.id, { schedule: { enabled: true, intervalMinutes: 3 } });
  await first.close();
  advance(10 * minute + 20_000);
  const service = open();
  setAvailable(false);
  await service.tick();
  assert.equal(calls.length, 0);
  store.save(workflow.id, 1, { ...workflow.document, sampleInput: 'changed while offline' });
  setAvailable(true);
  await service.tick();
  await service.tick();
  assert.equal(calls.length, 1);
  const [id, revision, requestId, input, source] = calls[0]!;
  assert.deepEqual([id, revision, input, source], [workflow.id, 2, undefined, 'schedule']);
  assert.equal(store.getSubmission('studio-' + id + '-' + requestId)?.input.value, 'changed while offline');
  assert.equal(service.get(workflow.id).schedule.nextAt, '2026-06-01T10:12:00.000Z');
  advance(100_000);
  await service.tick();
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0]![2], calls[1]![2]);
});

test('a lost acknowledgement retries the same scheduled occurrence and revision across restart', async (t) => {
  const { open, workflow, store, calls, advance } = workspace(t);
  const first = open(async (id, revision, requestId, input, trigger) => {
    store.prepareRun(id, revision, requestId, 'deployment', input, trigger);
    throw new Error('Lost acknowledgement from https://private.example/internal');
  });
  first.update(workflow.id, { schedule: { enabled: true, intervalMinutes: 1 } });
  advance(minute);
  await first.tick();
  assert.equal(calls.length, 1);
  const lastError = first.get(workflow.id).schedule.lastError;
  assert.match(lastError!, /retry/i);
  assert.doesNotMatch(lastError!, /https|private|acknowledgement/i);
  await first.close();
  store.save(workflow.id, 1, { ...workflow.document, sampleInput: 'changed after acceptance' });
  advance(5 * minute);
  const restarted = open();
  assert.equal(restarted.get(workflow.id).schedule.lastError, lastError);
  await restarted.tick();
  await restarted.tick();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], calls[0]);
  assert.equal(restarted.get(workflow.id).schedule.nextAt, '2026-06-01T10:07:00.000Z');
  assert.equal(restarted.get(workflow.id).schedule.lastError, undefined);
  advance(minute);
  await restarted.tick();
  assert.equal(calls.at(-1)?.[1], 2);
  assert.notEqual(calls.at(-1)?.[2], calls[0]![2]);
});

test('an invalid scheduled workflow leaves other workflows runnable and recovers after an edit', async (t) => {
  const { open, workflow, store, calls, advance } = workspace(t);
  const invalid = store.create({ ...greeting(), name: '' });
  const service = open();
  service.update(invalid.id, { schedule: { enabled: true, intervalMinutes: 1 } });
  service.update(workflow.id, { schedule: { enabled: true, intervalMinutes: 1 } });
  advance(minute);
  await service.tick();
  assert.deepEqual(new Set(calls.map((call) => call[0])), new Set([invalid.id, workflow.id]));
  assert.equal(service.get(invalid.id).schedule.lastError, 'Give the workflow a name before running it.');
  assert.equal(service.get(workflow.id).schedule.lastError, undefined);
  const accepted = calls.find((call) => call[0] === workflow.id)!;
  assert.equal(store.getSubmission('studio-' + workflow.id + '-' + accepted[2])?.revision, 1);
  store.save(invalid.id, 1, { ...invalid.document, name: 'fixed' });
  advance(minute);
  await service.tick();
  const fixed = calls.find((call) => call[0] === invalid.id && call[1] === 2)!;
  assert.equal(store.getSubmission('studio-' + invalid.id + '-' + fixed[2])?.revision, 2);
  assert.equal(service.get(invalid.id).schedule.lastError, undefined);
});

test('older trigger settings are upgraded in place; changing a failing schedule clears the error', async (t) => {
  const { file, open, workflow, advance } = workspace(t);
  const legacy = new DatabaseSync(file);
  legacy.exec(`CREATE TABLE studio_triggers (
    workflow_id TEXT PRIMARY KEY, webhook_token TEXT, interval_minutes INTEGER NOT NULL DEFAULT 15,
    next_at INTEGER, pending_id TEXT, pending_revision INTEGER, lease_id TEXT, lease_until INTEGER
  )`);
  legacy.prepare(`INSERT INTO studio_triggers (workflow_id, webhook_token, interval_minutes, next_at)
    VALUES (?, ?, ?, ?)`)
    .run(workflow.id, 'a'.repeat(43), 1, Date.parse('2026-06-01T10:01:00.000Z'));
  legacy.close();
  const service = open(async () => { throw new RequestError('Invalid response from https://private.example/a'); });
  const migrated = service.get(workflow.id);
  assert.equal(migrated.schedule.nextAt, '2026-06-01T10:01:00.000Z');
  service.assertWebhook(workflow.id, 'a'.repeat(43));
  advance(minute);
  await service.tick();
  const failure = service.get(workflow.id).schedule.lastError;
  assert.ok(failure);
  assert.doesNotMatch(failure, /private|https/i);
  assert.equal(service.update(workflow.id, { webhook: { enabled: false } }).schedule.lastError, failure);
  const changed = service.update(workflow.id, { schedule: { enabled: true, intervalMinutes: 2 } });
  assert.equal(changed.schedule.lastError, undefined);
});

test('two schedulers share a claim, and finishing an in-flight run preserves a changed schedule', async (t) => {
  const { open, workflow, calls, advance } = workspace(t);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const first = open(async () => {
    started();
    await pending;
    return 'started';
  });
  const other = open();
  first.update(workflow.id, { schedule: { enabled: true, intervalMinutes: 1 } });
  advance(minute);
  first.start();
  await entered;
  try {
    await other.tick();
    assert.equal(calls.length, 1);
    other.update(workflow.id, { schedule: { enabled: true, intervalMinutes: 7 } });
  } finally {
    release();
    await first.close();
  }
  assert.equal(other.get(workflow.id).schedule.nextAt, '2026-06-01T10:08:00.000Z');
  advance(minute);
  first.start();
  await first.tick();
  await other.tick();
  assert.equal(calls.length, 1);
});

test('an expired lease reuses the accepted run; a late completion cannot advance the schedule', async (t) => {
  const { open, workflow, store, calls, advance } = workspace(t);
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  const original = open(async (id, revision, requestId, input, trigger) => {
    const submitted = store.prepareRun(id, revision, requestId, 'deployment', input, trigger);
    await released;
    return submitted.id;
  });
  const restarted = open();
  original.update(workflow.id, { schedule: { enabled: true, intervalMinutes: 1 } });
  advance(minute);
  const stalled = original.tick();
  try {
    store.save(workflow.id, 1, { ...workflow.document, sampleInput: 'next run only' });
    advance(2 * minute);
    await restarted.tick();
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1], calls[0]);
    assert.equal(restarted.get(workflow.id).schedule.nextAt, '2026-06-01T10:04:00.000Z');
    advance(4 * minute);
  } finally {
    release();
    await stalled;
  }
  assert.equal(restarted.get(workflow.id).schedule.nextAt, '2026-06-01T10:04:00.000Z');
});

test('slow workflows with overdue leases leave an open submission slot usable by another schedule', async (t) => {
  const { open, workflow, store, advance, calls } = workspace(t);
  const slow = [workflow, store.create(greeting()), store.create(greeting())];
  const healthy = store.create(greeting());
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  const service = open(async (id) => {
    if (id !== healthy.id) await released;
    return id;
  });
  for (const item of slow) service.update(item.id, { schedule: { enabled: true, intervalMinutes: 1 } });
  advance(minute);
  const stalled = service.tick();
  try {
    advance(2 * minute);
    service.update(healthy.id, { schedule: { enabled: true, intervalMinutes: 1 } });
    advance(minute);
    await service.tick();
    assert.equal(calls.filter(([id]) => id === healthy.id).length, 1);
  } finally {
    release();
    await stalled;
  }
});

test('shutdown drains scheduled submissions and returns service unavailable for new requests', async (t) => {
  const { open, workflow, advance } = workspace(t);
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  const service = open(async () => { await released; return 'accepted'; });
  const settings = service.update(workflow.id, {
    webhook: { enabled: true }, schedule: { enabled: true, intervalMinutes: 1 },
  });
  const token = settings.webhook.path!.split('/').pop()!;
  advance(minute);
  const dispatch = service.tick();
  let closed = false;
  const closing = service.close().then(() => { closed = true; });
  try {
    await Promise.resolve();
    assert.equal(closed, false);
    await assert.rejects(service.webhook(workflow.id, token, {}), status(503));
  } finally {
    release();
    await Promise.all([dispatch, closing]);
  }
  await assert.rejects(service.webhook(workflow.id, token, {}), status(503));
  assert.throws(() => service.get(workflow.id), status(503));
  assert.throws(() => service.update(workflow.id, { webhook: { enabled: false } }), status(503));
});
