import assert from 'node:assert/strict';
import dns from 'node:dns';
import { once } from 'node:events';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import http, { type IncomingMessage, type RequestListener, type RequestOptions } from 'node:http';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { gzipSync } from 'node:zlib';
import type { JsonValue } from '@runsett/contracts';
import type { ConnectorKind, HttpSetting } from '../../packages/studio/src/connector-settings.js';

const slackUrl = 'https://hooks.slack.com/services/T00001/B00002/private-hook';
const modernTeams =
  'https://default-example.34.environment.api.powerplatform.com/powerautomate/automations/direct/workflows/abc123/triggers/manual/paths/invoke?api-version=1&sig=private-hook';
const logicTeams =
  'https://prod-12.westus.logic.azure.com/workflows/abc123/triggers/manual/paths/invoke?api-version=2016-06-01&sig=private-hook';
const slackId = 'slack-3c4a39b2-afa1-4097-a1b7-ecb36b12f001';
const teamsId = 'teams-3c4a39b2-afa1-4097-a1b7-ecb36b12f002';
const moduleUrl = new URL('../../packages/studio/modules/connector.mjs', import.meta.url).href;
const signal = new AbortController().signal;
const httpSetting = (overrides: Partial<HttpSetting> = {}) => ({
  method: 'GET',
  url: 'https://example.test/items',
  headers: {},
  body: 'none',
  customBody: '',
  ...overrides,
});
async function invoke(
  kind: ConnectorKind,
  setting: object,
  value: JsonValue = null,
  credentials = {},
  abort = signal,
) {
  const connector = (await import(moduleUrl)).default;
  return connector({ kind, setting: JSON.stringify(setting), value }, { credentials, signal: abort });
}
async function receiver(t: TestContext, handler: RequestListener) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return 'http://127.0.0.1:' + address.port;
}
async function readText(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}

test('connector drafts allow incomplete public settings and require a configured destination to execute', async () => {
  const { connectorDefaults, parseConnectorSetting } = await import(
    '../../packages/studio/src/connector-settings.js'
  );
  for (const kind of ['http', 'slack', 'teams'] as const) {
    assert.doesNotThrow(() => parseConnectorSetting(kind, connectorDefaults[kind], true));
    assert.throws(() => parseConnectorSetting(kind, connectorDefaults[kind]));
  }
  assert.doesNotThrow(() =>
    parseConnectorSetting('http', JSON.stringify(httpSetting({ url: 'https:/' })), true),
  );
  assert.throws(() => parseConnectorSetting('http', JSON.stringify(httpSetting({ body: 'input' }))));
  assert.throws(() =>
    parseConnectorSetting('teams', JSON.stringify({ connectionId: slackId, message: 'hi' })),
  );
});

test('drafts and worker validation keep known credentials, framing headers and metadata endpoints out of public HTTP settings', async (t) => {
  const { parseConnectorSetting } = await import('../../packages/studio/src/connector-settings.js');
  const unexpected = () => {
    throw new Error('Unexpected outbound request');
  };
  const plain = t.mock.method(http, 'request', unexpected);
  const secure = t.mock.method(https, 'request', unexpected);
  const invalid = [
    { url: slackUrl },
    { url: modernTeams },
    { url: 'https://user:private-hook@example.test/' },
    { url: 'https://example.test/?access_token=private-hook' },
    { url: 'file:///etc/hosts' },
    { url: 'http://169.254.169.254/' },
    { url: 'http://[::ffff:a9fe:a9fe]/' },
    { url: 'http://[fd00:ec2::254]/' },
    { url: 'http://metadata.google.internal/' },
    { headers: { Authorization: 'Bearer private-hook' } },
    { headers: { 'X-API-Key': 'private-hook' } },
    { headers: { Host: 'other.test' } },
    { headers: { 'X-Notice': 'one\r\nTwo: three' } },
    { headers: { 'Transfer-Encoding': 'chunked' } },
    { headers: { Accept: 'x'.repeat(20_000) } },
    { customBody: slackUrl },
  ];
  for (const change of invalid) {
    const setting = httpSetting(change as Partial<HttpSetting>);
    const permittedError = (error: unknown) =>
      error instanceof Error && !error.message.includes('private-hook');
    assert.throws(() => parseConnectorSetting('http', JSON.stringify(setting), true), permittedError);
    await assert.rejects(invoke('http', setting), permittedError);
  }
  const misfiled = JSON.stringify({ connectionId: '', message: 'Use ' + slackUrl });
  assert.throws(() => parseConnectorSetting('slack', misfiled, true));
  assert.equal(plain.mock.callCount() + secure.mock.callCount(), 0);
});

test('local connections persist privately, list only metadata and resolve only the selected bindings', async (t) => {
  const { StudioConnections } = await import('../../packages/studio/src/connections.js');
  const directory = mkdtempSync(join(tmpdir(), 'studio-connections-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'connections.sqlite');
  const first = new StudioConnections(file);
  const slack = first.create({ kind: 'slack', name: '  Alerts  ', url: slackUrl });
  const teams = first.create({ kind: 'teams', name: 'Team chat', url: modernTeams });
  assert.match(slack.id, /^slack-[0-9a-f-]{36}$/);
  assert.deepEqual(slack, { id: slack.id, kind: 'slack', name: 'Alerts' });
  assert.deepEqual(teams, { id: teams.id, kind: 'teams', name: 'Team chat' });
  first.close();
  const reopened = new StudioConnections(file);
  t.after(() => reopened.close());
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(reopened.list(), [slack, teams]);
  assert.deepEqual(reopened.getCredentials([teams.id]), { [teams.id]: modernTeams });
  assert.deepEqual(reopened.getCredentials([]), {});
  assert.throws(() => reopened.getCredentials(['teams-' + slack.id.slice(6)]), /connection/i);
  for (const url of [
    slackUrl.replace('.com/', '.com.example.test/'),
    modernTeams.replace('https:', 'http:'),
    'https://example.test/private-hook',
  ]) {
    assert.throws(
      () => reopened.create({ kind: 'teams', name: 'Wrong', url }),
      (e: unknown) => e instanceof Error && !e.message.includes('private-hook'),
    );
  }
  assert.throws(() => reopened.create({ kind: 'slack', name: 'Private ' + slackUrl, url: slackUrl }));
  assert.equal(reopened.create({ kind: 'teams', name: 'Logic', url: logicTeams }).kind, 'teams');
});

test('HTTP uses the configured method, headers and body and returns decoded JSON or text', async (t) => {
  const records: {
    method: string | undefined;
    body: string;
    header: string | string[] | undefined;
    type: string | undefined;
  }[] = [];
  const url = await receiver(t, async (req, res) => {
    records.push({
      method: req.method,
      body: await readText(req),
      header: req.headers['x-trace'],
      type: req.headers['content-type'],
    });
    if (req.method === 'POST')
      res
        .writeHead(201, { 'Content-Type': 'application/json', 'Set-Cookie': 'private-hook' })
        .end('{"ok":true}');
    else if (req.method === 'DELETE') res.writeHead(204).end();
    else res.end('reply');
  });
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const) {
    const body = method === 'POST' ? 'input' : method === 'PATCH' ? 'custom' : 'none';
    const setting = httpSetting({ method, url, headers: { 'X-Trace': 'sample' }, body, customBody: 'body' });
    const expected =
      method === 'POST'
        ? { status: 201, body: { ok: true } }
        : method === 'DELETE'
          ? { status: 204, body: null }
          : { status: 200, body: 'reply' };
    assert.deepEqual(await invoke('http', setting, false), expected);
  }
  assert.deepEqual(
    records.map(({ method, body }) => [method, body]),
    [
      ['GET', ''],
      ['POST', 'false'],
      ['PUT', ''],
      ['PATCH', 'body'],
      ['DELETE', ''],
    ],
  );
  assert.equal(records[1]?.type, 'application/json');
  assert.ok(records.every((record) => record.header === 'sample'));
});

test('Slack and Teams send the provider payload once and return a receipt without the webhook response or URL', async (t) => {
  const posts: JsonValue[] = [];
  const url = await receiver(t, async (req, res) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.headers['content-type'], 'application/json');
    posts.push(JSON.parse(await readText(req)));
    res.writeHead(202).end('private-hook');
  });
  const destinations: string[] = [];
  t.mock.method(
    https,
    'request',
    (destination: URL, options: RequestOptions, callback: (r: IncomingMessage) => void) => {
      destinations.push(destination.href);
      return http.request(url, options, callback);
    },
  );
  for (const [provider, connectionId, credential] of [
    ['slack', slackId, slackUrl],
    ['teams', teamsId, modernTeams],
  ] as const) {
    const result = await invoke(
      provider,
      { connectionId, message: 'Found {{value}}' },
      { key: '$&' },
      { [connectionId]: credential },
    );
    assert.deepEqual(result, { sent: true, provider, status: 202 });
  }
  assert.deepEqual(destinations, [slackUrl, modernTeams]);
  assert.deepEqual(posts[0], { text: 'Found {"key":"$&"}' });
  const teams = posts[1] as {
    type: string;
    attachments: { contentType: string; content: { type: string; body: object[] } }[];
  };
  assert.equal(teams.type, 'message');
  assert.equal(teams.attachments[0]?.contentType, 'application/vnd.microsoft.card.adaptive');
  assert.equal(teams.attachments[0]?.content.type, 'AdaptiveCard');
  assert.deepEqual(teams.attachments[0]?.content.body, [
    { type: 'TextBlock', text: 'Found {"key":"$&"}', wrap: true },
  ]);
  for (const credentials of [
    {},
    { [teamsId]: modernTeams },
    { [slackId]: modernTeams },
    { [slackId]: 'https://elsewhere.test/private-hook' },
  ]) {
    await assert.rejects(
      invoke('slack', { connectionId: slackId, message: 'Hello' }, null, credentials),
      (e: unknown) => e instanceof Error && !e.message.includes('private-hook'),
    );
  }
  assert.equal(destinations.length, 2);
});

test('HTTP rejects redirects and failures without repeating the request or exposing its response', async (t) => {
  const paths: (string | undefined)[] = [];
  const base = await receiver(t, (req, res) => {
    paths.push(req.url);
    res.writeHead(req.url === '/redirect' ? 307 : 503, { Location: '/target' }).end('private-hook');
  });
  for (const [path, status] of [
    ['/redirect', '307'],
    ['/unavailable', '503'],
  ] as const) {
    await assert.rejects(
      invoke('http', httpSetting({ url: base + path, method: 'POST' })),
      (error: unknown) =>
        error instanceof Error && error.message.includes(status) && !error.message.includes('private-hook'),
    );
  }
  assert.deepEqual(paths, ['/redirect', '/unavailable']);
});

test('signed-in message nodes post once to the selected channel using only the bound access token', async (t) => {
  const received: { url: string; token?: string; body: unknown }[] = [];
  const team = '75027a06-65ec-40e5-9a09-c029302e326b';
  const channel = '19:abc+123@thread.tacv2';
  const slack = slackId.replace('slack-', 'slack-oauth-');
  const teams = teamsId.replace('teams-', 'teams-oauth-');
  const token = 'fixture-access-token';
  let target = '';
  const local = await receiver(t, async (req, res) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.headers['content-type'], 'application/json');
    received.push({ url: target, token: req.headers.authorization!, body: JSON.parse(await readText(req)) });
    if (target.includes('slack.com')) res.end('{"ok":true,"ts":"123.456"}');
    else res.writeHead(201).end('{"id":"9876"}');
  });
  t.mock.method(
    https,
    'request',
    (destination: URL, options: RequestOptions, callback: (r: IncomingMessage) => void) => {
      target = destination.href;
      return http.request(local, options, callback);
    },
  );
  const msg = { message: 'Accepted {{value}}' };
  assert.deepEqual(
    await invoke('slack', { ...msg, connectionId: slack, channelId: 'C012AB', channelName: 'updates' }, 0, {
      [slack]: token,
    }),
    { sent: true, provider: 'slack', status: 200, channelId: 'C012AB' },
  );
  assert.deepEqual(
    await invoke('teams', { ...msg, connectionId: teams, teamId: team, channelId: channel }, true, {
      [teams]: token,
    }),
    { sent: true, provider: 'teams', status: 201, teamId: team, channelId: channel },
  );
  assert.deepEqual(received, [
    {
      url: 'https://slack.com/api/chat.postMessage',
      token: 'Bearer ' + token,
      body: { channel: 'C012AB', text: 'Accepted 0' },
    },
    {
      url:
        'https://graph.microsoft.com/v1.0/teams/' + team + '/channels/19%3Aabc%2B123%40thread.tacv2/messages',
      token: 'Bearer ' + token,
      body: { body: { contentType: 'text', content: 'Accepted true' } },
    },
  ]);
  await assert.rejects(
    invoke('teams', { ...msg, connectionId: teams, channelId: channel }, null, { [teams]: token }),
    /team/i,
  );
  await assert.rejects(
    invoke('slack', { ...msg, connectionId: slack }, null, { [slack]: token }),
    /channel/i,
  );
  await assert.rejects(
    invoke('teams', { ...msg, connectionId: teams, teamId: team, channelId: '..' }, null, { [teams]: token }),
    /channel/i,
  );
  await assert.rejects(
    invoke('slack', { ...msg, connectionId: slack, channelId: 'C012AB' }, null, { [slack]: slackUrl }),
    /account|sign in|token/i,
  );
  assert.equal(received.length, 2);
});

test('a Slack API error in an HTTP success response is reported without provider data or a second send', async (t) => {
  const local = await receiver(t, (_req, res) =>
    res.end('{"ok":false,"error":"channel_not_found","detail":"private-value"}'),
  );
  const requests = t.mock.method(
    https,
    'request',
    (_url: URL, options: RequestOptions, callback: (r: IncomingMessage) => void) =>
      http.request(local, options, callback),
  );
  const account = slackId.replace('slack-', 'slack-oauth-');
  await assert.rejects(
    invoke('slack', { connectionId: account, channelId: 'C012AB', message: 'Hello' }, null, {
      [account]: 'fixture-token',
    }),
    (err: unknown) =>
      err instanceof Error && /channel/i.test(err.message) && !err.message.includes('private-value'),
  );
  assert.equal(requests.mock.callCount(), 1);
});

test('HTTP bounds input and streaming responses and observes cancellation while waiting for the response body', async (t) => {
  const controller = new AbortController();
  const paths: (string | undefined)[] = [];
  const base = await receiver(t, (req, res) => {
    paths.push(req.url);
    res.writeHead(200);
    res.write('first chunk');
    if (req.url === '/large') res.end('é'.repeat(1024 * 1024));
    else setImmediate(() => controller.abort());
  });
  await assert.rejects(
    invoke('http', httpSetting({ url: base, method: 'POST', body: 'input' }), 'é'.repeat(512 * 1024)),
    /size|large|KiB/i,
  );
  await assert.rejects(invoke('http', httpSetting({ url: base + '/large' })), /size|large|KiB/i);
  await assert.rejects(
    invoke('http', httpSetting({ url: base + '/wait' }), null, {}, controller.signal),
    /cancel|abort/i,
  );
  assert.deepEqual(paths, ['/large', '/wait']);
});

test('HTTP checks resolved addresses at the socket boundary before connecting', async (t) => {
  t.mock.method(
    dns,
    'lookup',
    (_host: string, _options: unknown, callback: (e: null, addresses: dns.LookupAddress[]) => void) =>
      callback(null, [{ address: '169.254.169.254', family: 4 }]),
  );
  // Exercise the lookup supplied to the socket without giving this fixture a route to metadata.
  type Lookup = (host: string, options: { all: true }, callback: (error: Error | null) => void) => void;
  t.mock.method(
    http.Agent.prototype,
    'createConnection',
    (options: { host: string; lookup: Lookup }, done: (error: Error) => void) => {
      options.lookup(options.host, { all: true }, (error: Error | null) =>
        done(error ?? new Error('Unexpected connection attempt')),
      );
    },
  );
  await assert.rejects(
    invoke('http', httpSetting({ url: 'http://external.example.test/path' })),
    /metadata|link-local|unavailable destination/i,
  );
});

test('normalized webhook URL spellings remain private in editable fields', async () => {
  const { parseConnectorSetting } = await import('../../packages/studio/src/connector-settings.js');
  const alternateUrls = [
    slackUrl.replace('.com/', '.com:443/'),
    slackUrl.replace('slack.com', '%73lack.com'),
    slackUrl.replace('.com/', '.com./'),
    logicTeams.replace('.com/', '.com:443/'),
  ];
  for (const url of alternateUrls) {
    for (const setting of [httpSetting({ url }), httpSetting({ customBody: 'URL=' + url })]) {
      assert.throws(
        () => parseConnectorSetting('http', JSON.stringify(setting), true),
        /webhook|credential/i,
      );
    }
  }
  const normalizedHost = slackUrl.replace('hooks.slack.com', 'ｈｏｏｋｓ．ｓｌａｃｋ．ｃｏｍ');
  assert.throws(
    () => parseConnectorSetting('http', JSON.stringify(httpSetting({ url: normalizedHost })), true),
    /webhook|credential/i,
  );
});

test('HTTP caps the decoded size when a small compressed response expands', async (t) => {
  const base = await receiver(t, (req, res) => {
    if (req.url === '/empty') {
      res.writeHead(204, { 'Content-Encoding': 'gzip' }).end();
      return;
    }
    const text = req.url === '/large' ? 'a'.repeat(256 * 1024) : '{"value":0}';
    res.writeHead(200, { 'Content-Encoding': 'gzip' }).end(gzipSync(text));
  });
  assert.deepEqual(await invoke('http', httpSetting({ url: base })), { status: 200, body: { value: 0 } });
  assert.deepEqual(await invoke('http', httpSetting({ url: base + '/empty' })), { status: 204, body: null });
  await assert.rejects(invoke('http', httpSetting({ url: base + '/large' })), /128 KiB/);
});

test('HTTP applies its own deadline to an open response stream', async (t) => {
  const base = await receiver(t, (_req, res) => {
    res.writeHead(200);
    res.flushHeaders();
  });
  const realTimeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, 'timeout', (deadline: number) => {
    assert.ok(deadline > 0 && deadline < 30_000);
    return realTimeout(20);
  });
  await assert.rejects(invoke('http', httpSetting({ url: base })), /timed out/i);
});

test('a repeated input template that would exceed the message limit fails before sending', async (t) => {
  const request = t.mock.method(https, 'request', () => {
    throw new Error('Unexpected outbound request');
  });
  const message = '{{value}}'.repeat(256);
  await assert.rejects(
    invoke('slack', { connectionId: slackId, message }, 'é'.repeat(256), { [slackId]: slackUrl }),
    /24 KiB/,
  );
  assert.equal(request.mock.callCount(), 0);
});

test('a named HTTP connection exposes its origin and sends its token only on requests to that exact HTTPS origin', async (t) => {
  const { StudioConnections } = await import('../../packages/studio/src/connections.js');
  const store = new StudioConnections(':memory:');
  t.after(() => store.close());
  const secret = 'fixture-only-bearer';
  const origin = 'https://api.example.test';
  const connection = store.create({
    kind: 'http',
    name: 'Service',
    origin: 'https://API.example.test:443/',
    token: secret,
  });
  assert.match(connection.id, /^http-[a-f0-9]{64}-[a-f0-9-]{36}$/);
  assert.deepEqual(store.list(), [{ id: connection.id, kind: 'http', name: 'Service', origin }]);
  assert.deepEqual(store.getCredentials([]), {});
  const credentials = store.getCredentials([connection.id]);
  assert.deepEqual(credentials, { [connection.id]: secret });

  const received: (string | undefined)[] = [];
  const url = await receiver(t, (req, res) => {
    received.push(req.headers.authorization);
    res.writeHead(200).end('{"accepted":true}');
  });
  const destinations: string[] = [];
  t.mock.method(
    https,
    'request',
    (destination: URL, options: RequestOptions, callback: (r: IncomingMessage) => void) => {
      destinations.push(destination.href);
      return http.request(url, options, callback);
    },
  );
  const settings = { ...httpSetting({ url: origin + '/resource' }), connectionId: connection.id };
  assert.deepEqual(await invoke('http', settings, null, credentials), {
    status: 200,
    body: { accepted: true },
  });
  for (const other of [
    'https://different.example.test/',
    'https://api.example.test:8443/',
    'http://api.example.test/',
  ]) {
    await assert.rejects(invoke('http', { ...settings, url: other }, null, credentials), /origin|HTTPS/i);
  }
  await assert.rejects(invoke('http', settings), /connection/i);
  await assert.rejects(
    invoke('http', { ...settings, connectionId: slackId }, null, { [slackId]: slackUrl }),
    /connection/i,
  );
  assert.deepEqual(destinations, [origin + '/resource']);
  assert.deepEqual(received, ['Bearer ' + secret]);
});

test('HTTP connection creation rejects paths, userinfo, insecure origins and header delimiters', async (t) => {
  const { StudioConnections } = await import('../../packages/studio/src/connections.js');
  const store = new StudioConnections(':memory:');
  t.after(() => store.close());
  const create = (origin: string, token = 'fixture-only-token') =>
    store.create({ kind: 'http', name: 'Service', origin, token });
  for (const origin of [
    'http://example.test',
    'https://user:fixture-only-token@example.test',
    'https://example.test/path',
    'https://example.test/?key=fixture-only-token',
  ]) {
    assert.throws(
      () => create(origin),
      (error: unknown) => error instanceof Error && !error.message.includes('fixture-only-token'),
    );
  }
  assert.throws(() => create('https://example.test', 'fixture-only-token\r\nbad'), /token/i);
  assert.deepEqual(store.list(), []);
});
