import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { JsonValue } from '@runsett/contracts';
import {
  assertTestInput,
  RequestError,
  uuid,
  validateForRun,
  type AutomaticTrigger,
  type SavedWorkflow,
} from './model.js';

export type TriggerSettings = {
  webhook: { enabled: boolean; path?: string };
  schedule: { enabled: boolean; intervalMinutes: number; nextAt?: string; lastError?: string };
};

type SettingsPatch = {
  webhook?: { enabled: boolean };
  schedule?: { enabled: boolean; intervalMinutes: number };
};
type Dependencies<Result> = {
  getWorkflow: (id: string) => SavedWorkflow;
  getSubmissionRevision?: (id: string, requestId: string) => number | undefined;
  run: (
    id: string,
    revision: number,
    requestId: string,
    input: JsonValue | undefined,
    trigger: AutomaticTrigger,
  ) => Promise<Result>;
  isAvailable?: () => boolean;
  now?: () => number;
};
type TriggerRow = {
  webhook_token: string | null;
  interval_minutes: number;
  next_at: number | null;
  pending_id: string | null;
  pending_revision: number | null;
  lease_until: number | null;
  last_error: string | null;
};
type Occurrence = {
  id: string;
  revision: number;
  requestId: string;
  leaseId: string;
  due: number;
  interval: number;
};

const minute = 60_000;
const defaultMinutes = 15;
const leaseDuration = minute;
const retryDelay = 10_000;
const concurrency = 4;
const retryMessage = 'The scheduled run could not start. Studio will retry.';
const invalidMessage = 'The scheduled run could not start. Review the saved workflow and its connections.';

function hasOnlyFields(value: unknown, fields: string[]): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => fields.includes(key))
  );
}

function settingsPatch(value: unknown): SettingsPatch {
  if (!hasOnlyFields(value, ['webhook', 'schedule']))
    throw new RequestError('Provide webhook or schedule settings.');
  const patch: SettingsPatch = {};
  if (Object.hasOwn(value, 'webhook')) {
    const hook = value.webhook;
    if (!hasOnlyFields(hook, ['enabled']) || typeof hook.enabled !== 'boolean')
      throw new RequestError('Set webhook enabled to true or false.');
    patch.webhook = { enabled: hook.enabled };
  }
  if (Object.hasOwn(value, 'schedule')) {
    const schedule = value.schedule;
    if (!hasOnlyFields(schedule, ['enabled', 'intervalMinutes']) || typeof schedule.enabled !== 'boolean')
      throw new RequestError('Set schedule enabled to true or false and supply its interval in minutes.');
    const minutes = schedule.intervalMinutes;
    if (typeof minutes !== 'number' || !Number.isSafeInteger(minutes) || minutes < 1 || minutes > 525_600)
      throw new RequestError('Choose a whole-minute interval between 1 and 525,600.');
    patch.schedule = { enabled: schedule.enabled, intervalMinutes: minutes };
  }
  return patch;
}

function webhookRequestId(id: string, key: unknown) {
  if (
    typeof key !== 'string' ||
    Buffer.byteLength(key) > 256 ||
    !key.trim() ||
    /[\u0000-\u001f\u007f]/.test(key)
  )
    throw new RequestError('Use an Idempotency-Key of 1 to 256 bytes without control characters.');
  // Use a workflow-scoped UUIDv8. Studio submissions already retain the accepted run and input.
  const hash = createHash('sha256')
    .update('runsett-studio-webhook-v1\0')
    .update(id)
    .update('\0')
    .update(key)
    .digest();
  hash[6] = (hash[6]! & 0x0f) | 0x80;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

export class StudioTriggers<Result> {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private readonly active = new Map<string, Promise<void>>();
  private timer?: NodeJS.Timeout;
  private closing?: Promise<void>;

  constructor(file: string, private readonly options: Dependencies<Result>) {
    this.now = options.now ?? Date.now;
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA busy_timeout = 3000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS studio_triggers (
        workflow_id TEXT PRIMARY KEY,
        webhook_token TEXT,
        interval_minutes INTEGER NOT NULL DEFAULT 15 CHECK (interval_minutes BETWEEN 1 AND 525600),
        next_at INTEGER,
        pending_id TEXT,
        pending_revision INTEGER,
        lease_id TEXT,
        lease_until INTEGER,
        last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS studio_triggers_due
        ON studio_triggers(COALESCE(lease_until, next_at), workflow_id)
        WHERE next_at IS NOT NULL;
    `);
    this.transaction(() => {
      if (!this.db.prepare("SELECT 1 FROM pragma_table_info('studio_triggers') WHERE name = 'last_error'").get())
        this.db.exec('ALTER TABLE studio_triggers ADD COLUMN last_error TEXT');
    });
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private row(id: string) {
    const query = this.db.prepare('SELECT * FROM studio_triggers WHERE workflow_id = ?');
    return query.get(id) as TriggerRow | undefined;
  }

  private requireOpen() {
    if (this.closing) throw new RequestError('Studio is shutting down.', 503);
  }

  private settings(id: string): TriggerSettings {
    const row = this.row(id);
    return {
      webhook: row?.webhook_token
        ? { enabled: true, path: '/hooks/' + id + '/' + row.webhook_token }
        : { enabled: false },
      schedule: {
        enabled: row?.next_at != null,
        intervalMinutes: row?.interval_minutes ?? defaultMinutes,
        ...(row?.next_at != null ? { nextAt: new Date(row.next_at).toISOString() } : {}),
        ...(row?.last_error ? { lastError: row.last_error } : {}),
      },
    };
  }

  get(id: string) {
    this.requireOpen();
    this.options.getWorkflow(id);
    return this.settings(id);
  }

  update(id: string, value: unknown) {
    this.requireOpen();
    const patch = settingsPatch(value);
    this.options.getWorkflow(id);
    if (!patch.webhook && !patch.schedule) return this.settings(id);
    return this.transaction(() => {
      this.db.prepare('INSERT INTO studio_triggers (workflow_id) VALUES (?) ON CONFLICT DO NOTHING').run(id);
      const row = this.row(id)!;
      if (patch.webhook) {
        const token = patch.webhook.enabled ? (row.webhook_token ?? randomBytes(32).toString('base64url')) : null;
        this.db.prepare('UPDATE studio_triggers SET webhook_token = ? WHERE workflow_id = ?').run(token, id);
      }
      const schedule = patch.schedule;
      if (schedule && (
        schedule.enabled !== (row.next_at !== null) || schedule.intervalMinutes !== row.interval_minutes
      )) {
        const next = schedule.enabled ? this.now() + schedule.intervalMinutes * minute : null;
        this.db.prepare(`
          UPDATE studio_triggers SET interval_minutes = ?, next_at = ?, pending_id = NULL, pending_revision = NULL,
            lease_id = NULL, lease_until = NULL, last_error = NULL WHERE workflow_id = ?
        `).run(schedule.intervalMinutes, next, id);
      }
      return this.settings(id);
    });
  }

  assertWebhook(id: string, token: string): void {
    this.requireOpen();
    const stored =
      uuid(id) && typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token)
        ? this.row(id)?.webhook_token
        : null;
    if (!stored || stored.length !== 43 || !timingSafeEqual(Buffer.from(token, 'ascii'), Buffer.from(stored, 'ascii')))
      throw new RequestError('Webhook not found.', 404);
  }

  async webhook(id: string, token: string, input: unknown, idempotencyKey?: unknown): Promise<Result> {
    this.assertWebhook(id, token);
    assertTestInput(input);
    const requestId = idempotencyKey === undefined ? randomUUID() : webhookRequestId(id, idempotencyKey);
    if (this.options.isAvailable?.() === false) throw new RequestError('The workflow engine is offline.', 503);
    const accepted =
      idempotencyKey === undefined ? undefined : this.options.getSubmissionRevision?.(id, requestId);
    return this.options.run(id, accepted ?? this.options.getWorkflow(id).revision, requestId, input, 'webhook');
  }

  start() {
    if (this.timer || this.closing) return;
    const poll = () => {
      void this.tick().catch(() => console.error('Studio could not check workflow schedules.'));
    };
    this.timer = setInterval(poll, 1000).unref();
    poll();
  }

  async tick(): Promise<void> {
    if (this.closing || this.options.isAvailable?.() === false || this.active.size >= concurrency) return;
    const now = this.now();
    const due = this.db.prepare(`
      SELECT workflow_id FROM studio_triggers
      WHERE next_at IS NOT NULL AND COALESCE(lease_until, next_at) <= ?
      ORDER BY COALESCE(lease_until, next_at), workflow_id LIMIT ?
    `).all(now, concurrency);
    const jobs: Promise<void>[] = [];
    for (const { workflow_id } of due) {
      if (this.active.size >= concurrency) break;
      const id = String(workflow_id);
      if (this.active.has(id)) continue;
      const occurrence = this.claim(id, now);
      if (!occurrence) continue;
      const job = this.dispatch(occurrence).finally(() => this.active.delete(id));
      this.active.set(id, job);
      jobs.push(job);
    }
    await Promise.all(jobs);
  }

  private claim(id: string, now: number): Occurrence | undefined {
    return this.transaction(() => {
      const row = this.row(id);
      if (row?.next_at == null || (row.lease_until ?? row.next_at) > now) return;
      let revision: number;
      try {
        revision = row.pending_revision ?? this.options.getWorkflow(id).revision;
      } catch {
        this.db.prepare('UPDATE studio_triggers SET lease_until = ?, last_error = ? WHERE workflow_id = ?')
          .run(now + retryDelay, retryMessage, id);
        return;
      }
      const requestId = row.pending_id ?? randomUUID();
      const leaseId = randomUUID();
      this.db.prepare(`
        UPDATE studio_triggers SET pending_id = ?, pending_revision = ?, lease_id = ?, lease_until = ?
        WHERE workflow_id = ?
      `).run(requestId, revision, leaseId, now + leaseDuration, id);
      return { id, revision, requestId, leaseId, due: row.next_at, interval: row.interval_minutes * minute };
    });
  }

  private validationMessage(id: string, revision: number, cause: RequestError) {
    if (cause.status !== 400) return invalidMessage;
    let saved: SavedWorkflow;
    try {
      saved = this.options.getWorkflow(id);
    } catch {
      return invalidMessage;
    }
    if (saved.revision !== revision) return invalidMessage;
    // Only persist errors reproduced by the local settings validator. Infrastructure errors can contain secrets.
    try {
      validateForRun(saved.document);
    } catch (error) {
      if (error instanceof RequestError && error.message === cause.message) {
        if (error.message.startsWith('Choose a text format for '))
          return 'Choose a text format for the format step.';
        if (error.message.startsWith('Enter a field path for '))
          return 'Enter a field path for the read field step.';
        if (error.message.length <= 240 && !/[:/\\\u0000-\u001f\u007f]|\bwww\./i.test(error.message))
          return error.message;
      }
    }
    return invalidMessage;
  }

  private async dispatch({ id, revision, requestId, leaseId, due, interval }: Occurrence) {
    // Deployment preparation may outlive a lease. A crashed dispatcher can be retried with the same run identity.
    const renew = setInterval(() => {
      try {
        this.db.prepare('UPDATE studio_triggers SET lease_until = ? WHERE workflow_id = ? AND lease_id = ?')
          .run(this.now() + leaseDuration, id, leaseId);
      } catch {
        console.error('Studio could not renew a workflow schedule lease.');
      }
    }, leaseDuration / 3).unref();
    let lastError: string | null = null;
    try {
      await this.options.run(id, revision, requestId, undefined, 'schedule');
    } catch (error) {
      const permanent =
        error instanceof RequestError &&
        error.status >= 400 &&
        error.status < 500 &&
        ![408, 425, 429].includes(error.status);
      if (!permanent) {
        this.db.prepare(`
          UPDATE studio_triggers SET lease_id = NULL, lease_until = ?, last_error = ?
          WHERE workflow_id = ? AND lease_id = ?
        `).run(this.now() + retryDelay, retryMessage, id, leaseId);
        return;
      }
      lastError = this.validationMessage(id, revision, error);
    } finally {
      clearInterval(renew);
    }
    const missed = Math.max(0, Math.floor((this.now() - due) / interval));
    const next = due + (missed + 1) * interval;
    this.db.prepare(`
      UPDATE studio_triggers SET next_at = ?, pending_id = NULL, pending_revision = NULL,
        lease_id = NULL, lease_until = NULL, last_error = ?
      WHERE workflow_id = ? AND lease_id = ?
    `).run(next, lastError, id, leaseId);
  }

  close(): Promise<void> {
    if (!this.closing) {
      clearInterval(this.timer);
      this.closing = Promise.allSettled(this.active.values()).then(() => this.db.close());
    }
    return this.closing;
  }
}
