import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { RequestError } from '../../packages/studio/src/model.js';
import { StudioOAuth } from '../../packages/studio/src/oauth.js';
import { handleOAuthRoutes } from '../../packages/studio/src/oauth-routes.js';
import type { ProviderKind, TokenSet } from '../../packages/studio/src/oauth-providers.js';

const slackApp = '111111.222222';
const otherSlackApp = '333333.444444';
const teamsApp = 'c836d0c2-2c06-4d39-9042-630433eb223c';
const base = 'http://localhost:4310';
const teamId = '1467a259-6500-4ca3-ba27-eb00ec8249c6';

class Providers {
  tokens: TokenSet = { accessToken: 'access-first', refreshToken: 'refresh-first' };
  accountKey = 'provider-account-7';
  exchanges: Array<{
    kind: ProviderKind;
    clientId: string;
    redirectUri: string;
    code: string;
    verifier: string;
  }> = [];
  refreshes: Array<[ProviderKind, string, string]> = [];
  calls: unknown[][] = [];
  onRefresh = async (): Promise<TokenSet> => ({
    accessToken: 'access-second',
    refreshToken: 'refresh-second',
  });

  authorizationUrl(
    kind: ProviderKind,
    clientId: string,
    redirectUri: string,
    state: string,
    verifier: string,
  ) {
    const url = new URL('https://provider.example/authorize');
    url.search = new URLSearchParams({
      kind,
      client_id: clientId,
      redirect_uri: redirectUri,
      state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    }).toString();
    return url.href;
  }
  async exchange(kind: ProviderKind, clientId: string, redirectUri: string, code: string, verifier: string) {
    this.exchanges.push({ kind, clientId, redirectUri, code, verifier });
    return {
      accountKey: this.accountKey,
      name: kind === 'slack' ? 'Design workspace' : 'Taylor',
      tokens: this.tokens,
    };
  }
  async refresh(kind: ProviderKind, clientId: string, token: string) {
    this.refreshes.push([kind, clientId, token]);
    return this.onRefresh();
  }
  async teams(token: string) {
    this.calls.push(['teams', token]);
    return [{ id: teamId, name: 'Engineering' }];
  }
  async channels(kind: ProviderKind, token: string, team?: string) {
    this.calls.push(['channels', kind, token, team]);
    return [{ id: 'channel1', name: 'General' }];
  }
}

function fixture(t: TestContext) {
  const db = new DatabaseSync(':memory:');
  const providers = new Providers();
  const oauth = new StudioOAuth(db, providers);
  t.after(() => db.close());
  async function route(method: string, path: string, value?: unknown, cookie?: string) {
    const headers = new Map<string, string>();
    let status = 200,
      result: any;
    const req = {
      method,
      headers: { cookie, host: 'localhost:4310' },
      socket: { localPort: 4310 },
    } as IncomingMessage;
    const res = {
      setHeader(name: string, value: string) {
        headers.set(name.toLowerCase(), value);
      },
      writeHead(code: number, extra: Record<string, string>) {
        status = code;
        for (const [name, value] of Object.entries(extra ?? {})) headers.set(name.toLowerCase(), value);
      },
      end(text: string) {
        result = text;
      },
    } as unknown as ServerResponse;
    try {
      const handled = await handleOAuthRoutes(
        req,
        res,
        new URL(path, base),
        oauth,
        async () => value,
        (_res, code, object) => {
          status = code;
          result = object;
        },
      );
      if (!handled) status = 404;
    } catch (error) {
      if (!(error instanceof RequestError)) throw error;
      status = error.status;
      result = { error: error.message };
    }
    return { status, result, headers };
  }
  async function start(kind: ProviderKind) {
    const response = await route('POST', '/api/oauth/' + kind + '/start', {});
    assert.ok(response.status >= 200 && response.status < 300);
    const authorization = new URL(response.result.authorizationUrl);
    const state = authorization.searchParams.get('state')!;
    const setCookie = response.headers.get('set-cookie')!;
    return {
      authorization,
      state,
      setCookie,
      cookie: setCookie.split(';')[0]!,
      callback: '/api/oauth/' + kind + '/callback?state=' + encodeURIComponent(state),
      poll: '/api/oauth/' + kind + '/flows/' + response.result.flowId,
      id: response.result.flowId as string,
    };
  }
  async function connect(kind: ProviderKind) {
    const flow = await start(kind);
    const callback = await route('GET', flow.callback + '&code=approved', undefined, flow.cookie);
    assert.equal(callback.status, 200);
    const poll = await route('GET', flow.poll, undefined, flow.cookie);
    assert.equal(poll.result.status, 'complete');
    return poll.result.connection as { id: string; name: string; kind: ProviderKind; auth: 'oauth' };
  }
  const configure = (kind: ProviderKind, clientId: string) =>
    route('PUT', '/api/oauth/' + kind + '/config', { clientId });
  return { oauth, db, providers, route, start, configure, connect };
}

test('public app registration exposes only the app ID and fixed local callback', async (t) => {
  const { route, configure } = fixture(t);
  const expected = { clientId: '', redirectUri: base + '/api/oauth/slack/callback' };
  assert.deepEqual((await route('GET', '/api/oauth/slack/config')).result, expected);
  assert.equal((await route('POST', '/api/oauth/slack/start', {})).status, 400);
  for (const input of [{ clientId: 'xoxp-secret' }, { clientId: slackApp, clientSecret: 'private' }]) {
    assert.equal((await route('PUT', '/api/oauth/slack/config', input)).status, 400);
  }
  assert.equal((await configure('teams', slackApp)).status, 400);
  assert.deepEqual((await configure('slack', slackApp)).result, { ...expected, clientId: slackApp });
  assert.equal((await configure('teams', teamsApp)).result.clientId, teamsApp);
  assert.equal((await configure('slack', '')).result.clientId, '');
  assert.equal((await route('GET', '/api/oauth/teams/config')).result.clientId, teamsApp);
});

test('state and flow polling bind to the initiating browser and provider; a callback is consumed once', async (t) => {
  const { route, configure, start, providers, oauth } = fixture(t);
  await configure('slack', slackApp);
  const [flow, other] = await Promise.all([start('slack'), start('slack')]);
  assert.match(flow.state, /^[A-Za-z0-9_-]{43,}$/);
  assert.notEqual(flow.id, flow.state);
  assert.notEqual(flow.state, other.state);
  assert.notEqual(
    flow.authorization.searchParams.get('code_challenge'),
    other.authorization.searchParams.get('code_challenge'),
  );
  assert.match(flow.setCookie, /HttpOnly/i);
  assert.match(flow.setCookie, /SameSite=Lax/i);
  assert.doesNotMatch(flow.setCookie, /Domain=/i);
  assert.deepEqual((await route('GET', flow.poll, undefined, flow.cookie)).result, { status: 'pending' });
  for (const cookie of [undefined, other.cookie]) {
    assert.ok((await route('GET', flow.poll, undefined, cookie)).status >= 400);
    assert.ok((await route('GET', flow.callback + '&code=leaked', undefined, cookie)).status >= 400);
  }
  for (const path of [
    flow.callback.replace('/slack/', '/teams/') + '&code=leaked',
    flow.callback + '&state=extra&code=leaked',
    flow.poll.replace('/slack/', '/teams/'),
  ])
    assert.ok((await route('GET', path, undefined, flow.cookie)).status >= 400);
  assert.equal(providers.exchanges.length, 0);
  const done = await route('GET', flow.callback + '&code=private-code', undefined, flow.cookie);
  assert.equal(done.status, 200);
  assert.doesNotMatch(done.result, /private-code|access-first|refresh-first/);
  const exchange = providers.exchanges[0]!;
  assert.match(exchange.verifier, /^[A-Za-z0-9_-]{43,128}$/);
  assert.equal(
    createHash('sha256').update(exchange.verifier).digest('base64url'),
    flow.authorization.searchParams.get('code_challenge'),
  );
  assert.equal(exchange.redirectUri, base + '/api/oauth/slack/callback');
  assert.ok((await route('GET', flow.callback + '&code=again', undefined, flow.cookie)).status >= 400);
  assert.equal(providers.exchanges.length, 1);
  const summary = oauth.list()[0]!;
  assert.deepEqual(Object.keys(summary).sort(), ['auth', 'id', 'kind', 'name']);
  assert.match(summary.id, /^slack-oauth-[a-f0-9-]{36}$/);
  assert.equal(oauth.has(summary.id), true);
  assert.equal(oauth.has('teams' + summary.id.slice(5)), false);
  assert.deepEqual((await route('GET', flow.poll, undefined, flow.cookie)).result, {
    status: 'complete',
    connection: summary,
  });
});

test('denied and expired flows report a safe error and cannot register an account', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-01-01T00:00:00Z') });
  const { configure, route, start, oauth, providers } = fixture(t);
  await configure('slack', slackApp);
  const rejected = await start('slack');
  await route(
    'GET',
    rejected.callback + '&error=access_denied&error_description=private',
    undefined,
    rejected.cookie,
  );
  const denied = (await route('GET', rejected.poll, undefined, rejected.cookie)).result;
  assert.equal(denied.status, 'error');
  assert.match(denied.error, /cancel|denied|declined/i);
  assert.doesNotMatch(denied.error, /private/);
  const expired = await start('slack');
  t.mock.timers.tick(11 * 60_000);
  assert.ok(
    (await route('GET', expired.callback + '&code=too-late', undefined, expired.cookie)).status >= 400,
  );
  const timeout = (await route('GET', expired.poll, undefined, expired.cookie)).result;
  assert.equal(timeout.status, 'error');
  assert.match(timeout.error, /expir|timed out/i);
  assert.equal(providers.exchanges.length, 0);
  assert.deepEqual(oauth.list(), []);
});

test('completed flow polling expires even while Studio is idle', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-01-01T00:00:00Z') });
  const { configure, route, start } = fixture(t);
  await configure('slack', slackApp);
  const flow = await start('slack');
  await route('GET', flow.callback + '&code=ok', undefined, flow.cookie);
  t.mock.timers.tick(20 * 60_000);
  assert.equal((await route('GET', flow.poll, undefined, flow.cookie)).status, 404);
});

test('account identity is stable across reconnects and separate across providers and accounts', async (t) => {
  const { configure, connect, oauth, providers, db } = fixture(t);
  await configure('slack', slackApp);
  await configure('teams', teamsApp);
  const slack = await connect('slack');
  providers.tokens = { accessToken: 'updated-token' };
  assert.equal((await connect('slack')).id, slack.id);
  assert.equal(await oauth.accessToken(slack.id), 'updated-token');
  const teams = await connect('teams');
  assert.notEqual(teams.id, slack.id);
  providers.accountKey = 'another';
  assert.notEqual((await connect('slack')).id, slack.id);
  const reopened = new StudioOAuth(db, providers);
  assert.equal(reopened.list().length, 3);
  assert.equal(await reopened.accessToken(slack.id), 'updated-token');
});

test('simultaneous refreshes persist one rotation and use the account’s registered app ID', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-01-01T00:00:00Z') });
  const { configure, connect, oauth, providers, db } = fixture(t);
  await configure('slack', slackApp);
  providers.tokens = { accessToken: 'short', refreshToken: 'refresh-1', expiresAt: Date.now() + 120_000 };
  const account = await connect('slack');
  await configure('slack', otherSlackApp);
  t.mock.timers.tick(180_000);
  providers.onRefresh = async () => ({
    accessToken: 'rotated',
    refreshToken: 'refresh-2',
    expiresAt: Date.now() + 120_000,
  });
  const other = new StudioOAuth(db, providers);
  assert.deepEqual(
    await Promise.all([
      oauth.accessToken(account.id),
      oauth.accessToken(account.id),
      other.accessToken(account.id),
    ]),
    ['rotated', 'rotated', 'rotated'],
  );
  assert.deepEqual(providers.refreshes, [['slack', slackApp, 'refresh-1']]);
  t.mock.timers.tick(180_000);
  providers.onRefresh = async () => ({ accessToken: 'omitted-rotation', expiresAt: Date.now() + 120_000 });
  assert.equal(await other.accessToken(account.id), 'omitted-rotation');
  t.mock.timers.tick(180_000);
  assert.equal(await oauth.accessToken(account.id), 'omitted-rotation');
  assert.deepEqual(providers.refreshes.slice(1), [
    ['slack', slackApp, 'refresh-2'],
    ['slack', slackApp, 'refresh-2'],
  ]);
});

test('a slow refresh cannot overwrite a reconnected account or reuse a refresh token for a different app', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-01-01T00:00:00Z') });
  const { configure, connect, providers, oauth } = fixture(t);
  await configure('slack', slackApp);
  providers.tokens = { accessToken: 'old', refreshToken: 'old-refresh', expiresAt: Date.now() + 120_000 };
  const account = await connect('slack');
  t.mock.timers.tick(180_000);
  let started!: () => void, release!: (tokens: TokenSet) => void;
  const refreshing = new Promise<void>((resolve) => {
    started = resolve;
  });
  providers.onRefresh = () =>
    new Promise<TokenSet>((resolve) => {
      release = resolve;
      started();
    });
  const slow = oauth.accessToken(account.id);
  await refreshing;
  await configure('slack', otherSlackApp);
  providers.tokens = { accessToken: 'reconnected', expiresAt: Date.now() + 120_000 };
  assert.equal((await connect('slack')).id, account.id);
  release({ accessToken: 'stale', refreshToken: 'stale-refresh' });
  assert.equal(await slow, 'reconnected');
  assert.equal(await oauth.accessToken(account.id), 'reconnected');
  t.mock.timers.tick(180_000);
  await assert.rejects(
    oauth.accessToken(account.id),
    (e: unknown) => e instanceof RequestError && e.status === 401,
  );
  assert.equal(providers.refreshes.length, 1);
});

test('team and channel queries select the signed-in account and validate the provider and team', async (t) => {
  const { configure, connect, route, providers } = fixture(t);
  await configure('slack', slackApp);
  await configure('teams', teamsApp);
  const slack = await connect('slack');
  providers.tokens = { accessToken: 'teams-access' };
  const teams = await connect('teams');
  const s = '/api/connections/' + slack.id,
    m = '/api/connections/' + teams.id;
  assert.equal((await route('GET', s + '/teams')).status, 400);
  assert.equal((await route('GET', m + '/channels')).status, 400);
  assert.equal((await route('GET', m + '/channels?teamId=arbitrary')).status, 400);
  assert.equal((await route('GET', s + '/channels?teamId=' + teamId)).status, 400);
  assert.deepEqual((await route('GET', s + '/channels')).result, {
    items: [{ id: 'channel1', name: 'General' }],
  });
  assert.deepEqual((await route('GET', m + '/teams')).result, {
    items: [{ id: teamId, name: 'Engineering' }],
  });
  assert.deepEqual((await route('GET', m + '/channels?teamId=' + teamId)).result, {
    items: [{ id: 'channel1', name: 'General' }],
  });
  assert.deepEqual(providers.calls, [
    ['channels', 'slack', 'access-first', undefined],
    ['teams', 'teams-access'],
    ['channels', 'teams', 'teams-access', teamId],
  ]);
  providers.channels = async () => {
    throw new RequestError('provider supplied details', 422);
  };
  const large = await route('GET', s + '/channels');
  assert.equal(large.status, 422);
  assert.match(large.result.error, /limit|large/i);
  assert.doesNotMatch(large.result.error, /provider supplied/);
});

test('short-lived refreshed tokens remain usable between calls and refresh ahead of their actual expiry', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-01-01T00:00:00Z') });
  const { configure, connect, oauth, providers } = fixture(t);
  await configure('slack', slackApp);
  providers.tokens = { accessToken: 'initial', refreshToken: 'refresh', expiresAt: Date.now() + 120_000 };
  const account = await connect('slack');
  t.mock.timers.tick(180_000);
  providers.onRefresh = async () => ({ accessToken: 'short', expiresAt: Date.now() + 10_000 });
  assert.equal(await oauth.accessToken(account.id), 'short');
  t.mock.timers.tick(2000);
  assert.equal(await oauth.accessToken(account.id), 'short');
  assert.equal(providers.refreshes.length, 1);
  t.mock.timers.tick(7500);
  assert.equal(await oauth.accessToken(account.id), 'short');
  assert.equal(providers.refreshes.length, 2);
});

test('a revoked refresh grant consistently requests reconnect and a transient provider failure can be retried', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-01-01T00:00:00Z') });
  const { configure, connect, oauth, providers } = fixture(t);
  await configure('slack', slackApp);
  providers.tokens = { accessToken: 'initial', refreshToken: 'refresh', expiresAt: Date.now() + 300_000 };
  const account = await connect('slack');
  t.mock.timers.tick(280_000);
  providers.onRefresh = async () => {
    throw new Error('private transport details');
  };
  await assert.rejects(
    oauth.accessToken(account.id),
    (error: unknown) =>
      error instanceof RequestError && error.status === 503 && !error.message.includes('private'),
  );
  providers.onRefresh = async () => {
    throw new RequestError('private grant details', 401);
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(
      oauth.accessToken(account.id),
      (error: unknown) =>
        error instanceof RequestError && error.status === 401 && !error.message.includes('private'),
    );
  }
  assert.deepEqual(providers.refreshes, [
    ['slack', slackApp, 'refresh'],
    ['slack', slackApp, 'refresh'],
  ]);
});
