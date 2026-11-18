import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fchmodSync, openSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { CredentialSource } from '@runsett/runner';
import {
  containsWebhookUrl,
  httpOrigin,
  isBearerToken,
  isConnectionId,
  isOAuthConnectionId,
  webhookUrl,
  type ConnectionSummary,
  type ConnectorKind,
} from '../modules/connector-settings.mjs';
import { RequestError } from './model.js';
import { StudioOAuth } from './oauth.js';

function httpPrefix(origin: string) {
  return 'http-' + createHash('sha256').update(origin).digest('hex') + '-';
}

export class StudioConnections {
  private readonly db: DatabaseSync;
  readonly oauth: StudioOAuth;

  constructor(file: string) {
    if (file !== ':memory:') {
      // Create the file privately before SQLite opens it. Rollback journals inherit its mode.
      const fd = openSync(file, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
      try {
        fchmodSync(fd, 0o600);
      } finally {
        closeSync(fd);
      }
    }
    this.db = new DatabaseSync(file, { timeout: 3000 });
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS connections (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('slack','teams')), name TEXT NOT NULL, url TEXT NOT NULL);" +
        'CREATE TABLE IF NOT EXISTS http_connections (id TEXT PRIMARY KEY, name TEXT NOT NULL, origin TEXT NOT NULL, token TEXT NOT NULL);',
    );
    this.oauth = new StudioOAuth(this.db);
  }

  list(): ConnectionSummary[] {
    const rows = this.db
      .prepare(
        'SELECT id, kind, name, NULL AS origin FROM connections UNION ALL ' +
          "SELECT id, 'http' AS kind, name, origin FROM http_connections",
      )
      .all() as ConnectionSummary[];
    const summaries = rows.map((row) =>
      row.kind === 'http' ? { ...row } : { id: row.id, name: row.name, kind: row.kind },
    );
    return [...summaries, ...this.oauth.list()].sort(
      (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
    );
  }

  create(value: unknown): ConnectionSummary {
    if (!value || typeof value !== 'object') throw new RequestError('Provide a named connection.');
    const { kind, name, url, origin, token } = value as Record<string, unknown>;
    if (kind !== 'slack' && kind !== 'teams' && kind !== 'http')
      throw new RequestError('Choose an HTTP, Slack or Microsoft Teams connection.');
    if (
      typeof name !== 'string' ||
      !name.trim() ||
      name.length > 100 ||
      /[\x00-\x1f\x7f]/.test(name) ||
      containsWebhookUrl(name)
    )
      throw new RequestError('Give the connection a short display name without a webhook URL.');
    let destination: string;
    try {
      destination = kind === 'http' ? httpOrigin(origin) : webhookUrl(kind, url).href;
    } catch (error) {
      throw new RequestError((error as Error).message);
    }
    if (kind === 'http') {
      if (!isBearerToken(token)) throw new RequestError('Enter a valid Bearer token of up to 8 KiB.');
      if (
        name.trim() === token ||
        (token.length >= 8 && (name.includes(token) || destination.includes(token)))
      )
        throw new RequestError('Keep the Bearer token in the token field.');
      const summary = {
        id: httpPrefix(destination) + randomUUID(),
        kind,
        name: name.trim(),
        origin: destination,
      } satisfies ConnectionSummary;
      this.db
        .prepare('INSERT INTO http_connections (id, name, origin, token) VALUES (?, ?, ?, ?)')
        .run(summary.id, summary.name, destination, token);
      return summary;
    }
    const summary = { id: kind + '-' + randomUUID(), kind, name: name.trim() } satisfies ConnectionSummary;
    this.db
      .prepare('INSERT INTO connections (id, kind, name, url) VALUES (?, ?, ?, ?)')
      .run(summary.id, kind, summary.name, destination);
    return summary;
  }

  getCredentials(bindings: readonly string[]): Record<string, CredentialSource> {
    const select = this.db.prepare(
      'SELECT kind, url AS credential, NULL AS origin FROM connections WHERE id = ? UNION ALL ' +
        "SELECT 'http', token, origin FROM http_connections WHERE id = ?",
    );
    const credentials: Record<string, CredentialSource> = {};
    for (const id of new Set(bindings)) {
      if (isOAuthConnectionId(id)) {
        if (!this.oauth.has(id)) throw new RequestError('The selected account is unavailable.');
        credentials[id] = () => this.oauth.accessToken(id);
        continue;
      }
      const row = select.get(id, id) as
        | { kind: ConnectorKind; credential: string; origin: string }
        | undefined;
      if (
        !row ||
        !isConnectionId(row.kind, id) ||
        (row.kind === 'http' && !id.startsWith(httpPrefix(row.origin)))
      )
        throw new RequestError('The selected connection is unavailable.');
      credentials[id] = row.credential;
    }
    return credentials;
  }

  close() {
    this.db.close();
  }
}
