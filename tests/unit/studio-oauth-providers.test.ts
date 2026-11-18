import assert from 'node:assert/strict';
import test from 'node:test';
import { RequestError } from '../../packages/studio/src/model.js';

const callback = 'http://localhost:4310/oauth/callback';
const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const team = '015c465c-ac37-443d-b527-486d8bbee0de';
const otherTeam = 'c39d1292-24dc-42f8-a905-ef51ff22024a';
const member = '83bd994a-ee06-48cd-b452-05de47b23ea1';
const graph = 'https://graph.microsoft.com/v1.0';

test('Slack app registration pre-fills desktop sign-in and only the permissions used by the picker and sender', async () => {
  const { slackRegistrationUrl } = await import('../../packages/studio/src/oauth-apps.js');
  const { api } = await provider();
  const link = new URL(slackRegistrationUrl(callback));
  assert.equal(link.origin + link.pathname, 'https://api.slack.com/apps');
  assert.equal(link.searchParams.get('new_app'), '1');
  const manifest = JSON.parse(link.searchParams.get('manifest_json')!);
  const start = new URL(api.authorizationUrl('slack', '123.456', callback, 'state', verifier));
  assert.deepEqual(manifest.oauth_config, {
    pkce_enabled: true,
    redirect_urls: [callback],
    scopes: { user: start.searchParams.get('user_scope')!.split(',') },
  });
  assert.equal(manifest.settings.token_rotation_enabled, true);
});

async function provider(...replies: (object | Response)[]) {
  const { OAuthProviders } = await import('../../packages/studio/src/oauth-providers.js');
  const requests: Request[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    requests.push(new Request(input, init));
    const reply = replies.shift();
    assert.ok(reply, 'unexpected provider request');
    return reply instanceof Response ? reply : Response.json(reply);
  };
  return { api: new OAuthProviders(fetcher), requests };
}
async function params(request: Request) {
  return Object.fromEntries(new URLSearchParams(await request.text()));
}

test('desktop authorization uses public-client S256 and requests only delegated user scopes', async () => {
  const { api } = await provider();
  const slack = new URL(api.authorizationUrl('slack', '123.456', callback, 'state', 'secretpassword'));
  assert.equal(slack.origin + slack.pathname, 'https://slack.com/oauth/v2/authorize');
  assert.equal(slack.searchParams.get('code_challenge'), 'ldMBaaWcQYtSATMV_IG8mf3wp7A6EW80arYoSW80ntU');
  assert.deepEqual(slack.searchParams.get('user_scope')?.split(',').sort(), [
    'channels:read',
    'chat:write',
    'groups:read',
  ]);
  assert.ok(!slack.searchParams.get('scope'));
  const teams = new URL(api.authorizationUrl('teams', team, callback, 'state', verifier));
  assert.equal(
    teams.origin + teams.pathname,
    'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize',
  );
  assert.equal(teams.searchParams.get('code_challenge'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  assert.deepEqual(teams.searchParams.get('scope')?.split(' ').sort(), [
    'Channel.ReadBasic.All',
    'ChannelMessage.Send',
    'Team.ReadBasic.All',
    'User.Read',
    'offline_access',
  ]);
  for (const url of [slack, teams]) {
    assert.equal(url.searchParams.get('state'), 'state');
    assert.equal(url.searchParams.get('redirect_uri'), callback);
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.has('code_verifier'), false);
    assert.equal(url.searchParams.has('client_secret'), false);
  }
});

test('Slack exchanges a code for the authorizing user, identifies their workspace, and rotates the user token', async () => {
  const { api, requests } = await provider(
    {
      ok: true,
      token_type: 'bot',
      access_token: 'unused-bot-token',
      authed_user: {
        id: 'U123',
        token_type: 'user',
        access_token: 'access-one',
        expires_in: 43200,
        refresh_token: 'refresh-one',
      },
    },
    { ok: true, user_id: 'U123', team_id: 'T456', user: 'alex', team: 'Product' },
    {
      ok: true,
      token_type: 'user',
      access_token: 'access-two',
      refresh_token: 'refresh-two',
      expires_in: 43200,
    },
  );
  const start = Date.now();
  const account = await api.exchange('slack', '123.456', callback, 'code', verifier);
  assert.equal(account.accountKey, 'T456:U123');
  assert.match(account.name, /alex/);
  assert.match(account.name, /Product/);
  assert.equal(account.tokens.accessToken, 'access-one');
  assert.equal(account.tokens.refreshToken, 'refresh-one');
  assert.ok(account.tokens.expiresAt! >= start + 43_200_000);
  assert.ok(account.tokens.expiresAt! <= Date.now() + 43_200_000);
  assert.equal(requests[0]?.url, 'https://slack.com/api/oauth.v2.access');
  const exchange = await params(requests[0]!);
  assert.equal(exchange.code_verifier, verifier);
  assert.equal(exchange.redirect_uri, callback);
  assert.equal(exchange.code, 'code');
  assert.equal(exchange.client_secret, undefined);
  assert.equal(requests[1]?.url, 'https://slack.com/api/auth.test');
  assert.equal(requests[1]?.headers.get('Authorization'), 'Bearer access-one');
  assert.equal((await api.refresh('slack', '123.456', 'refresh-one')).refreshToken, 'refresh-two');
  assert.deepEqual(await params(requests[2]!), {
    client_id: '123.456',
    grant_type: 'refresh_token',
    refresh_token: 'refresh-one',
  });
  assert.ok(requests.every((request) => request.method === 'POST' && request.redirect !== 'follow'));
});

test('Microsoft exchanges and refreshes at the organizations authority and identifies accounts from Graph /me', async () => {
  const { api, requests } = await provider(
    { token_type: 'Bearer', access_token: 'graph-token', refresh_token: 'rotate-me', expires_in: 3600 },
    { id: member, displayName: 'Alex', userPrincipalName: 'alex@example.test', private: 'unused' },
    { token_type: 'Bearer', access_token: 'next-graph-token', expires_in: 3600 },
  );
  const account = await api.exchange('teams', team, callback, 'code', verifier);
  assert.equal(account.accountKey, member);
  assert.equal(account.name, 'Alex (alex@example.test)');
  assert.equal(account.tokens.refreshToken, 'rotate-me');
  const identity = new URL(requests[1]!.url);
  assert.equal(identity.origin + identity.pathname, graph + '/me');
  assert.ok(identity.searchParams.get('$select')?.split(',').includes('userPrincipalName'));
  assert.equal(requests[1]!.headers.get('Authorization'), 'Bearer graph-token');
  assert.equal((await api.refresh('teams', team, 'rotate-me')).accessToken, 'next-graph-token');
  for (const request of [requests[0]!, requests[2]!]) {
    assert.equal(request.url, 'https://login.microsoftonline.com/organizations/oauth2/v2.0/token');
    assert.equal(request.method, 'POST');
    assert.equal((await params(request)).client_secret, undefined);
  }
});

test('Slack lists the current user’s joined public and private channels across empty and populated pages', async () => {
  const { api, requests } = await provider(
    { ok: true, channels: [], response_metadata: { next_cursor: 'opaque+=/' } },
    {
      ok: true,
      channels: [
        { id: 'C123', name: 'general', topic: { value: 'private metadata' } },
        { id: 'G345', name: 'private' },
        { id: 'C456', name: 'archive', is_archived: true },
      ],
      response_metadata: { next_cursor: '' },
    },
  );
  assert.deepEqual(await api.channels('slack', 'user-token'), [
    { id: 'C123', name: 'general' },
    { id: 'G345', name: 'private' },
  ]);
  for (const req of requests) {
    const url = new URL(req.url);
    assert.equal(url.origin + url.pathname, 'https://slack.com/api/users.conversations');
    assert.equal(url.searchParams.get('types'), 'public_channel,private_channel');
    assert.equal(url.searchParams.get('exclude_archived'), 'true');
    assert.equal(url.searchParams.get('user'), null);
    assert.equal(req.headers.get('Authorization'), 'Bearer user-token');
  }
  assert.equal(new URL(requests[1]!.url).searchParams.get('cursor'), 'opaque+=/');
});

test('Teams limits channel discovery to a joined team and follows Graph’s opaque continuation URL', async () => {
  const next = graph + '/teams/' + team + '/channels?$skiptoken=opaque%2b%2f';
  const joined = { value: [{ id: team, displayName: 'Team', description: 'unused' }] };
  const { api, requests } = await provider(
    { value: [], '@odata.nextLink': graph + '/me/joinedTeams?$skiptoken=teams2' },
    joined,
    { value: [{ id: '19:one@thread.tacv2', displayName: 'Alpha' }], '@odata.nextLink': next },
    { value: [{ id: '19:two@thread.skype', displayName: 'Beta' }] },
    joined,
  );
  assert.deepEqual(await api.channels('teams', 'graph-token', team), [
    { id: '19:one@thread.tacv2', name: 'Alpha' },
    { id: '19:two@thread.skype', name: 'Beta' },
  ]);
  assert.equal(requests[0]?.url, graph + '/me/joinedTeams');
  assert.equal(requests[3]?.url, next);
  assert.ok(requests.every((request) => request.headers.get('Authorization') === 'Bearer graph-token'));
  await assert.rejects(api.channels('teams', 'graph-token', otherTeam), /joined|member/i);
  await assert.rejects(api.channels('teams', 'graph-token', '../../me'), /team/i);
  assert.equal(requests.length, 5);
});

test('directory pagination refuses cross-origin or unrelated continuations and repeating cursors', async () => {
  for (const next of [
    'https://elsewhere.test/v1.0/me/joinedTeams',
    graph + '/users',
    'https://user@graph.microsoft.com/v1.0/me/joinedTeams',
  ]) {
    const { api, requests } = await provider({ value: [], '@odata.nextLink': next });
    await assert.rejects(api.teams('private-test-token'), RequestError);
    assert.equal(requests.length, 1);
  }
  const response = { ok: true, channels: [], response_metadata: { next_cursor: 'repeated' } };
  const { api, requests } = await provider(response, response, response);
  await assert.rejects(api.channels('slack', 'private-test-token'), /pag|reload|list/i);
  assert.equal(requests.length, 2);
});

test('provider errors signal revocation, rate limits and transient failures without disclosing provider data', async () => {
  const secret = 'do-not-expose-fixture';
  const { api, requests } = await provider(
    { ok: false, error: 'invalid_refresh_token', detail: secret },
    Response.json({ error: 'invalid_grant', error_description: secret }, { status: 400 }),
    Response.json({ error: secret }, { status: 429 }),
    new Response(null, { status: 307, headers: { location: 'https://elsewhere.test/' + secret } }),
    { ok: true, token_type: 'bot', access_token: secret },
  );
  for (const [kind, status] of [
    ['slack', 401],
    ['teams', 401],
    ['teams', 429],
    ['teams', 502],
    ['slack', 502],
  ] as const) {
    await assert.rejects(
      api.refresh(kind, team, secret),
      (error: unknown) =>
        error instanceof RequestError && error.status === status && !error.message.includes(secret),
    );
  }
  assert.ok(requests.every((request) => request.redirect !== 'follow'));
});

test('oversized provider responses fail before exposing a partial directory', async () => {
  const { api } = await provider(
    new Response(
      new ReadableStream<Uint8Array>({
        start(stream) {
          stream.enqueue(new Uint8Array(3 * 1024 * 1024));
          stream.close();
        },
      }),
    ),
  );
  await assert.rejects(api.teams('private-test-token'), /size|large|limit/i);
});

test('a canonical joinedTeams continuation can use only the Graph user authenticated by the current token', async () => {
  const canonical = graph + '/users/' + member + '/joinedTeams?$skiptoken=next';
  const first = { value: [], '@odata.nextLink': canonical };
  const { api, requests } = await provider(
    first,
    { id: member },
    { value: [{ id: team, displayName: 'Joined' }] },
  );
  assert.deepEqual(await api.teams('account-token'), [{ id: team, name: 'Joined' }]);
  assert.equal(new URL(requests[1]!.url).pathname, '/v1.0/me');
  assert.equal(requests[2]!.url, canonical);
  const otherAccount = await provider(first, { id: otherTeam });
  await assert.rejects(otherAccount.api.teams('another-token'), RequestError);
  assert.equal(otherAccount.requests.length, 2);
});

test('a directory exceeding the page limit fails explicitly and a caller can cancel before requesting a page', async () => {
  const pages = Array.from({ length: 51 }, (_, i) => ({
    ok: true,
    channels: [],
    response_metadata: { next_cursor: 'page' + i },
  }));
  const { api, requests } = await provider(...pages);
  await assert.rejects(
    api.channels('slack', 'account-token'),
    (error: unknown) => error instanceof RequestError && error.status === 422 && /50/.test(error.message),
  );
  assert.equal(requests.length, 50);
  await assert.rejects(
    api.teams('account-token', AbortSignal.abort('never expose fixture')),
    (error: unknown) => error instanceof RequestError && !error.message.includes('never expose fixture'),
  );
  assert.equal(requests.length, 50);
});

test('the picker rejects whitespace in channel IDs that the execution module cannot send to', async () => {
  const { api } = await provider(
    { value: [{ id: team, displayName: 'Team' }] },
    {
      value: [{ id: '19:one two@thread.tacv2', displayName: 'Broken' }],
    },
  );
  await assert.rejects(api.channels('teams', 'account-token', team), RequestError);
});
