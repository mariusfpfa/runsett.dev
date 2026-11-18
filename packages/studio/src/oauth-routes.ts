import type { IncomingMessage, ServerResponse } from 'node:http';
import { RequestError } from './model.js';
import type { StudioOAuth } from './oauth.js';
import type { ProviderKind } from './oauth-providers.js';

function cookieName(id: string) {
  return 'runsett_oauth_' + id;
}

function flowCookie(req: IncomingMessage, id: string) {
  const name = cookieName(id) + '=';
  const matches = req.headers.cookie
    ?.split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(name));
  return matches?.length === 1 ? matches[0]!.slice(name.length) : undefined;
}

function callbackText(res: ServerResponse, status: number, text: string) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  });
  res.end(text);
}

export async function handleOAuthRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  oauth: StudioOAuth,
  body: (req: IncomingMessage, limit?: number) => Promise<unknown>,
  json: (res: ServerResponse, status: number, result: unknown) => void,
): Promise<boolean> {
  const discovery = /^\/api\/connections\/((?:slack|teams)-oauth-[a-f0-9-]{36})\/(teams|channels)$/.exec(
    url.pathname,
  );
  if (discovery && req.method === 'GET') {
    const ids = url.searchParams.getAll('teamId');
    if (ids.length > 1 || (discovery[2] === 'teams' && ids.length))
      throw new RequestError('Choose one team for its channels.');
    const items =
      discovery[2] === 'teams'
        ? await oauth.teams(discovery[1]!)
        : await oauth.channels(discovery[1]!, ids[0]);
    json(res, 200, { items });
    return true;
  }
  const route = /^\/api\/oauth\/(slack|teams)\/(config|start|callback|flows\/([A-Za-z0-9_-]{43}))$/.exec(
    url.pathname,
  );
  if (!route) return false;
  const kind = route[1] as ProviderKind;
  // Bind callbacks to the actual listening port, independent of the submitted URL and request headers.
  const redirectUri = 'http://localhost:' + req.socket.localPort + '/api/oauth/' + kind + '/callback';
  if (route[2] === 'config' && (req.method === 'GET' || req.method === 'PUT')) {
    const clientId =
      req.method === 'GET' ? oauth.clientId(kind) : oauth.configure(kind, await body(req, 1024));
    json(res, 200, { clientId, redirectUri });
    return true;
  }
  if (route[2] === 'start' && req.method === 'POST') {
    const payload = await body(req, 1024);
    if (
      payload === null ||
      typeof payload !== 'object' ||
      Array.isArray(payload) ||
      Object.keys(payload).length
    )
      throw new RequestError('Start sign-in with an empty JSON object.');
    const { flowId, browser, authorizationUrl } = oauth.start(kind, redirectUri);
    res.setHeader(
      'Set-Cookie',
      cookieName(flowId) +
        '=' +
        browser +
        '; Path=/api/oauth/' +
        kind +
        '/; Max-Age=900; HttpOnly; SameSite=Lax',
    );
    json(res, 200, { flowId, authorizationUrl });
    return true;
  }
  if (route[3] && req.method === 'GET') {
    json(res, 200, oauth.poll(kind, route[3], flowCookie(req, route[3])));
    return true;
  }
  if (route[2] === 'callback' && req.method === 'GET') {
    try {
      const result = await oauth.callback(kind, redirectUri, url.searchParams, (id) => flowCookie(req, id));
      if (result.status === 'complete')
        callbackText(res, 200, 'Account connected. You can close this tab and return to Runsett Studio.');
      else callbackText(res, 400, result.error);
    } catch (error) {
      callbackText(
        res,
        error instanceof RequestError ? error.status : 503,
        error instanceof RequestError
          ? error.message
          : 'Sign-in could not finish. Return to Runsett Studio and try again.',
      );
    }
    return true;
  }
  return false;
}
