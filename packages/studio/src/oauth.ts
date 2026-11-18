import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { RequestError } from './model.js';
import { OAuthProviders, type ProviderKind, type TokenSet } from './oauth-providers.js';

type Providers = Pick<OAuthProviders, 'authorizationUrl' | 'exchange' | 'refresh' | 'teams' | 'channels'>;
type Account = { id: string; kind: ProviderKind; name: string; auth: 'oauth' };
type AccountRow = {
  id: string;
  kind: ProviderKind;
  client_id: string;
  access_token: string;
  refresh_token: string | null;
  expires_at: number | null;
  refresh_at: number | null;
  version: number;
};
type FlowResult =
  | { status: 'pending' }
  | { status: 'complete'; connection: Account }
  | { status: 'error'; error: string };
type FinishedFlow = Exclude<FlowResult, { status: 'pending' }>;
type Flow = {
  id: string;
  kind: ProviderKind;
  clientId: string;
  redirectUri: string;
  state: string | null;
  verifier: string | null;
  browser: string;
  expiresAt: number;
  result: FlowResult;
};

const flowLifetime = 10 * 60_000;
const pollGrace = 5 * 60_000;
const timeoutMessage = 'Sign-in expired. Start again in Runsett Studio.';
const invalidFlow =
  'This sign-in request expired or belongs to another browser. Start again in Runsett Studio.';
const reconnect = 'This account needs to sign in again. Reconnect it in Runsett Studio.';
const guid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const secretPattern = /^[A-Za-z0-9_-]{43}$/;
const secret = () => randomBytes(32).toString('base64url');

function sameBrowser(flow: Flow, cookie: string | undefined) {
  return (
    typeof cookie === 'string' &&
    secretPattern.test(cookie) &&
    timingSafeEqual(Buffer.from(flow.browser), Buffer.from(cookie))
  );
}

function validToken(token: unknown): token is string {
  return (
    typeof token === 'string' &&
    token.length > 0 &&
    token.length <= 64 * 1024 &&
    !/[\x00-\x20\x7f]/.test(token)
  );
}

function checkTokens(tokens: TokenSet) {
  if (
    !validToken(tokens?.accessToken) ||
    (tokens.refreshToken !== undefined && !validToken(tokens.refreshToken)) ||
    (tokens.expiresAt !== undefined &&
      (!Number.isSafeInteger(tokens.expiresAt) || tokens.expiresAt <= Date.now()))
  )
    throw new RequestError(
      'The provider returned unusable credentials. Try again or reconnect the account.',
      502,
    );
}

function publicError(error: unknown) {
  if (error instanceof RequestError) {
    if (error.status === 401) return new RequestError(reconnect, 401);
    if (error.status === 403)
      return new RequestError('The provider denied access. Review the app permissions and reconnect.', 403);
    if (error.status === 429) return new RequestError('The provider is busy. Try again shortly.', 429);
    if (error.status === 422)
      return new RequestError(
        'This directory exceeds the listing limit. Choose a smaller team or another account.',
        422,
      );
    if (error.status === 400 || error.status === 404)
      return new RequestError(
        'The selected provider resource is unavailable for this account.',
        error.status,
      );
  }
  return new RequestError('The account provider could not complete the request. Try again shortly.', 503);
}

function usable(row: AccountRow) {
  const until = row.refresh_token ? (row.refresh_at ?? row.expires_at) : row.expires_at;
  return until === null || until > Date.now();
}

function refreshAt(expiresAt?: number) {
  if (expiresAt === undefined) return null;
  // Leave part of even a short-lived token's lifetime usable before the next refresh.
  return expiresAt - Math.min(30_000, Math.floor((expiresAt - Date.now()) / 10));
}

export class StudioOAuth {
  private readonly flows = new Map<string, Flow>();
  private readonly refreshing = new Map<string, Promise<string>>();

  constructor(
    private readonly db: DatabaseSync,
    private readonly providers: Providers = new OAuthProviders(),
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS oauth_apps (kind TEXT PRIMARY KEY, client_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS oauth_accounts (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, account_key TEXT NOT NULL, name TEXT NOT NULL,
        client_id TEXT NOT NULL, access_token TEXT NOT NULL, refresh_token TEXT, expires_at INTEGER,
        refresh_at INTEGER, version INTEGER NOT NULL DEFAULT 1, refresh_owner TEXT, refresh_until INTEGER,
        UNIQUE (kind, account_key)
      );
    `);
    db.exec('BEGIN IMMEDIATE');
    try {
      if (!db.prepare("SELECT 1 FROM pragma_table_info('oauth_accounts') WHERE name = 'refresh_at'").get())
        db.exec('ALTER TABLE oauth_accounts ADD COLUMN refresh_at INTEGER');
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  clientId(kind: ProviderKind): string {
    const app = this.db.prepare('SELECT client_id FROM oauth_apps WHERE kind = ?').get(kind);
    return app ? String(app.client_id) : '';
  }

  configure(kind: ProviderKind, value: unknown): string {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).length !== 1 ||
      !('clientId' in value) ||
      !Object.hasOwn(value, 'clientId') ||
      typeof value.clientId !== 'string'
    )
      throw new RequestError('Provide the public application client ID.');
    const id = kind === 'teams' ? value.clientId.trim().toLowerCase() : value.clientId.trim();
    if (id && !(kind === 'slack' ? /^\d{1,30}\.\d{1,30}$/.test(id) : guid.test(id))) {
      throw new RequestError(
        kind === 'slack'
          ? 'Enter the numeric Slack client ID, including its dot.'
          : 'Enter the Microsoft application (client) ID.',
      );
    }
    this.db
      .prepare(
        `
      INSERT INTO oauth_apps (kind, client_id) VALUES (?, ?)
      ON CONFLICT(kind) DO UPDATE SET client_id = excluded.client_id
    `,
      )
      .run(kind, id);
    return id;
  }

  list(): Account[] {
    const accounts = this.db
      .prepare('SELECT id, kind, name FROM oauth_accounts ORDER BY name COLLATE NOCASE, id')
      .all() as Omit<Account, 'auth'>[];
    return accounts.map((account) => ({ ...account, auth: 'oauth' }));
  }

  has(id: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM oauth_accounts WHERE id = ?').get(id);
  }

  start(kind: ProviderKind, redirectUri: string) {
    const clientId = this.clientId(kind);
    if (!clientId) throw new RequestError('Save a public app client ID before signing in.');
    const now = Date.now();
    for (const [id, flow] of this.flows) {
      if (flow.expiresAt + pollGrace <= now) this.flows.delete(id);
      else this.expire(flow);
    }
    if (this.flows.size >= 128)
      throw new RequestError('Too many recent sign-in requests. Try again shortly.', 429);
    const id = secret(),
      state = secret(),
      verifier = secret(),
      browser = secret();
    const authorizationUrl = this.providers.authorizationUrl(kind, clientId, redirectUri, state, verifier);
    this.flows.set(id, {
      id,
      kind,
      clientId,
      redirectUri,
      state,
      verifier,
      browser,
      expiresAt: now + flowLifetime,
      result: { status: 'pending' },
    });
    return { flowId: id, authorizationUrl, browser };
  }

  private expire(flow: Flow) {
    if (flow.result.status === 'pending' && Date.now() >= flow.expiresAt) {
      flow.state = null;
      flow.verifier = null;
      flow.result = { status: 'error', error: timeoutMessage };
    }
  }

  poll(kind: ProviderKind, id: string, browser: string | undefined): FlowResult {
    const flow = this.flows.get(id);
    if (!flow || flow.kind !== kind || !sameBrowser(flow, browser)) throw new RequestError(invalidFlow, 404);
    if (Date.now() >= flow.expiresAt + pollGrace) {
      this.flows.delete(id);
      throw new RequestError(timeoutMessage, 404);
    }
    this.expire(flow);
    return flow.result;
  }

  async callback(
    kind: ProviderKind,
    redirectUri: string,
    params: URLSearchParams,
    browserFor: (flowId: string) => string | undefined,
  ): Promise<FinishedFlow> {
    const states = params.getAll('state');
    if (states.length !== 1 || !secretPattern.test(states[0]!)) throw new RequestError(invalidFlow);
    const flow = [...this.flows.values()].find((entry) => entry.state === states[0] && entry.kind === kind);
    if (!flow || flow.redirectUri !== redirectUri || !sameBrowser(flow, browserFor(flow.id)))
      throw new RequestError(invalidFlow);
    this.expire(flow);
    if (!flow.verifier) throw new RequestError(timeoutMessage);
    const verifier = flow.verifier;
    // Consume state before calling the provider. A duplicate callback may arrive during the exchange.
    flow.state = null;
    flow.verifier = null;
    const codes = params.getAll('code'),
      errors = params.getAll('error');
    if (errors.length || codes.length !== 1 || !codes[0] || codes[0].length > 16_384) {
      const error =
        errors.length === 1 && errors[0] === 'access_denied'
          ? 'Sign-in was cancelled. Return to Runsett Studio to try again.'
          : 'The provider did not authorize this sign-in. Start again in Runsett Studio.';
      flow.result = { status: 'error', error };
      return flow.result;
    }
    try {
      const account = await this.providers.exchange(kind, flow.clientId, redirectUri, codes[0], verifier);
      this.expire(flow);
      if (flow.result.status === 'error') return flow.result;
      const connection = this.saveAccount(kind, flow.clientId, account);
      flow.result = { status: 'complete', connection };
    } catch (error) {
      this.expire(flow);
      if (flow.result.status === 'error') return flow.result;
      let message = 'Sign-in could not finish. Check the app registration and try again in Runsett Studio.';
      if (error instanceof RequestError && error.status === 403)
        message = 'The provider denied sign-in. Review the app permissions and try again in Runsett Studio.';
      if (error instanceof RequestError && error.status >= 500)
        message = 'The sign-in provider could not finish the request. Try again in Runsett Studio.';
      flow.result = { status: 'error', error: message };
    }
    return flow.result;
  }

  private saveAccount(
    kind: ProviderKind,
    clientId: string,
    account: Awaited<ReturnType<Providers['exchange']>>,
  ): Account {
    const { tokens, accountKey } = account;
    checkTokens(tokens);
    if (
      typeof accountKey !== 'string' ||
      !accountKey ||
      accountKey.length > 512 ||
      /[\x00-\x1f\x7f]/.test(accountKey)
    )
      throw new RequestError('The provider did not identify this account.');
    const name = typeof account.name === 'string' ? account.name.replace(/[\x00-\x1f\x7f]/g, ' ').trim() : '';
    const safeName =
      !name ||
      name.includes(tokens.accessToken) ||
      (tokens.refreshToken && name.includes(tokens.refreshToken))
        ? kind === 'slack'
          ? 'Slack account'
          : 'Microsoft Teams account'
        : name.slice(0, 160);
    const saved = this.db
      .prepare(
        `
      INSERT INTO oauth_accounts (id, kind, account_key, client_id, name, access_token, refresh_token, expires_at, refresh_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(kind, account_key) DO UPDATE SET
        name = excluded.name, client_id = excluded.client_id, access_token = excluded.access_token,
        refresh_token = COALESCE(excluded.refresh_token,
          CASE WHEN oauth_accounts.client_id = excluded.client_id THEN oauth_accounts.refresh_token END),
        expires_at = excluded.expires_at, refresh_at = excluded.refresh_at,
        version = oauth_accounts.version + 1, refresh_owner = NULL, refresh_until = NULL
      RETURNING id, kind, name
    `,
      )
      .get(
        kind + '-oauth-' + randomUUID(),
        kind,
        accountKey,
        clientId,
        safeName,
        tokens.accessToken,
        tokens.refreshToken ?? null,
        tokens.expiresAt ?? null,
        refreshAt(tokens.expiresAt),
      ) as Omit<Account, 'auth'>;
    return { ...saved, auth: 'oauth' };
  }

  private account(id: string): AccountRow {
    const row = this.db.prepare('SELECT * FROM oauth_accounts WHERE id = ?').get(id) as
      | AccountRow
      | undefined;
    if (!row) throw new RequestError('OAuth account not found.', 404);
    return row;
  }

  async accessToken(id: string): Promise<string> {
    const row = this.account(id);
    if (usable(row)) return row.access_token;
    const active = this.refreshing.get(id);
    if (active) return active;
    const refresh = this.refresh(id).finally(() => this.refreshing.delete(id));
    this.refreshing.set(id, refresh);
    return refresh;
  }

  private async refresh(id: string): Promise<string> {
    const deadline = performance.now() + 35_000;
    while (true) {
      const row = this.account(id);
      if (usable(row)) return row.access_token;
      if (!row.refresh_token) throw new RequestError(reconnect, 401);
      const owner = randomUUID(),
        now = Date.now();
      const claim = this.db
        .prepare(
          `
        UPDATE oauth_accounts SET refresh_owner = ?, refresh_until = ?
        WHERE id = ? AND version = ? AND (refresh_until IS NULL OR refresh_until <= ?)
      `,
        )
        .run(owner, now + 60_000, id, row.version, now);
      if (claim.changes === 0) {
        if (performance.now() >= deadline)
          throw new RequestError('The account is being refreshed. Try again shortly.', 503);
        await delay(100);
        continue;
      }
      try {
        const fresh = await this.providers.refresh(row.kind, row.client_id, row.refresh_token);
        checkTokens(fresh);
        const saved = this.db
          .prepare(
            `
          UPDATE oauth_accounts SET access_token = ?, refresh_token = ?, expires_at = ?, refresh_at = ?, version = version + 1,
            refresh_owner = NULL, refresh_until = NULL WHERE id = ? AND version = ? AND refresh_owner = ?
        `,
          )
          .run(
            fresh.accessToken,
            fresh.refreshToken ?? row.refresh_token,
            fresh.expiresAt ?? null,
            refreshAt(fresh.expiresAt),
            id,
            row.version,
            owner,
          );
        if (saved.changes) return fresh.accessToken;
      } catch (error) {
        const failure = publicError(error);
        const revoked = failure.status === 401 ? 1 : 0;
        const current = this.db
          .prepare(
            `
          UPDATE oauth_accounts SET refresh_owner = NULL, refresh_until = NULL,
            refresh_token = CASE WHEN ? THEN NULL ELSE refresh_token END,
            expires_at = CASE WHEN ? THEN 0 ELSE expires_at END
          WHERE id = ? AND version = ? AND refresh_owner = ?
        `,
          )
          .run(revoked, revoked, id, row.version, owner);
        if (current.changes) throw failure;
      }
      // A new authorization or a newer refresh won the race. Read that account's current credentials.
    }
  }

  async teams(id: string) {
    if (this.account(id).kind !== 'teams') throw new RequestError('Choose a Microsoft Teams account.');
    const token = await this.accessToken(id);
    try {
      return await this.providers.teams(token);
    } catch (error) {
      throw publicError(error);
    }
  }

  async channels(id: string, teamId?: string) {
    const { kind } = this.account(id);
    if (kind === 'teams' ? !teamId || !guid.test(teamId) : teamId !== undefined)
      throw new RequestError('Choose a team for Microsoft Teams channels only.');
    const token = await this.accessToken(id);
    try {
      return await this.providers.channels(kind, token, teamId);
    } catch (error) {
      throw publicError(error);
    }
  }
}
