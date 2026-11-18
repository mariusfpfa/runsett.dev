import { createHash } from 'node:crypto';
import { RequestError } from './model.js';
import { slackUserScopes } from './oauth-apps.js';

export type ProviderKind = 'slack' | 'teams';
export type Choice = { id: string; name: string };
export type TokenSet = { accessToken: string; refreshToken?: string; expiresAt?: number };
type Fields = Record<string, unknown>;
type Directory = 'slack' | 'teams' | 'channels';

const slackApi = 'https://slack.com/api/';
const microsoftAuth = 'https://login.microsoftonline.com/organizations/oauth2/v2.0/';
const graph = 'https://graph.microsoft.com/v1.0';
const microsoftScopes =
  'offline_access User.Read Team.ReadBasic.All Channel.ReadBasic.All ChannelMessage.Send';
const guid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const responseLimit = 2 * 1024 * 1024;

function fields(value: unknown): value is Fields {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function invalidResponse() {
  return new RequestError(
    'The provider returned an unexpected response. Reconnect the account and try again.',
    502,
  );
}
function secret(value: unknown): string {
  if (typeof value !== 'string' || value.length > 32_768 || !/^[\x21-\x7e]+$/.test(value))
    throw invalidResponse();
  return value;
}
function label(value: unknown): string {
  if (typeof value !== 'string' || value.length > 512) throw invalidResponse();
  const name = value.replace(/[\x00-\x1f\x7f]/g, ' ').trim();
  if (!name) throw invalidResponse();
  return name;
}
function deadline(signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(30_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
function bearer(accessToken: string) {
  return { Authorization: 'Bearer ' + secret(accessToken), Accept: 'application/json' };
}
function callbackUri(raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new RequestError('Use the Studio localhost redirect URI.');
  }
  if (
    url.protocol !== 'http:' ||
    url.hostname !== 'localhost' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new RequestError('Use the Studio localhost redirect URI.');
  return raw;
}
function tokenSet(kind: ProviderKind, data: Fields): TokenSet {
  // OAuth V2 nests the author's token below authed_user when an installation also has a bot token.
  const token =
    kind === 'slack' && fields(data.authed_user) && data.authed_user.access_token ? data.authed_user : data;
  if (kind === 'slack' && token.token_type !== 'user') throw invalidResponse();
  if (kind === 'teams' && typeof token.token_type === 'string' && token.token_type.toLowerCase() !== 'bearer')
    throw invalidResponse();
  const result: TokenSet = { accessToken: secret(token.access_token) };
  if (token.refresh_token !== undefined) result.refreshToken = secret(token.refresh_token);
  if (token.expires_in !== undefined) {
    const seconds = Number(token.expires_in);
    const expiresAt = Date.now() + seconds * 1000;
    if (!Number.isSafeInteger(seconds) || seconds <= 0 || !Number.isSafeInteger(expiresAt))
      throw invalidResponse();
    result.expiresAt = expiresAt;
  }
  return result;
}

function providerFailure(kind: ProviderKind, status: number, code: unknown): RequestError {
  const provider = kind === 'slack' ? 'Slack' : 'Microsoft';
  if (status === 429 || code === 'ratelimited')
    return new RequestError(provider + ' is rate limiting requests. Wait a moment and try again.', 429);
  if (
    status === 401 ||
    [
      'invalid_auth',
      'invalid_grant',
      'invalid_refresh_token',
      'token_expired',
      'token_revoked',
      'account_inactive',
      'not_authed',
    ].includes(String(code))
  )
    return new RequestError(
      'Your ' + provider + ' authorization has expired or was revoked. Reconnect the account.',
      401,
    );
  if (
    status === 403 ||
    ['missing_scope', 'access_denied', 'no_permission', 'insufficient_scope'].includes(String(code))
  )
    return new RequestError(
      provider + ' denied access. Check the delegated permissions and reconnect the account.',
      403,
    );
  if (status >= 500) return new RequestError(provider + ' is unavailable. Try again shortly.', 503);
  if (
    status === 400 ||
    ['bad_redirect_uri', 'invalid_client_id', 'invalid_client', 'invalid_code'].includes(String(code))
  )
    return new RequestError(
      provider + ' rejected the sign-in. Check the client ID and redirect URI, then reconnect.',
      400,
    );
  return new RequestError(
    provider + ' could not complete this request. Retry or reconnect the account.',
    502,
  );
}

async function responseFields(response: Response): Promise<Fields> {
  const reader = response.body?.getReader();
  if (!reader) throw invalidResponse();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > responseLimit) throw new RequestError('The provider response exceeds the size limit.', 502);
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  } catch {
    throw invalidResponse();
  }
  if (!fields(value)) throw invalidResponse();
  return value;
}

function choice(directory: Directory, value: unknown): Choice | undefined {
  if (!fields(value)) throw invalidResponse();
  if (value.is_archived || value.isArchived || value.is_im || value.is_mpim || value.is_member === false)
    return;
  const { id } = value;
  if (
    typeof id !== 'string' ||
    !id ||
    Buffer.byteLength(id) > 512 ||
    /[%\\/?#\s\x00-\x1f\x7f]/.test(id) ||
    id === '.' ||
    id === '..'
  )
    throw invalidResponse();
  if (directory === 'teams' && !guid.test(id)) throw invalidResponse();
  if (directory === 'slack' && !/^[CG][A-Z0-9]{1,127}$/.test(id)) throw invalidResponse();
  return { id, name: label(directory === 'slack' ? value.name : value.displayName) };
}

export class OAuthProviders {
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  authorizationUrl(
    kind: ProviderKind,
    clientId: string,
    redirectUri: string,
    state: string,
    verifier: string,
  ): string {
    const url = new URL(
      kind === 'slack' ? 'https://slack.com/oauth/v2/authorize' : microsoftAuth + 'authorize',
    );
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: callbackUri(redirectUri),
      state,
      code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    });
    if (kind === 'slack') params.set('user_scope', slackUserScopes.join(','));
    else {
      params.set('response_type', 'code');
      params.set('response_mode', 'query');
      params.set('scope', microsoftScopes);
    }
    url.search = params.toString();
    return url.href;
  }

  private async request(
    kind: ProviderKind,
    url: string | URL,
    init: RequestInit,
    signal: AbortSignal,
  ): Promise<Fields> {
    try {
      signal.throwIfAborted();
      const response = await this.fetcher(url, { ...init, redirect: 'manual', credentials: 'omit', signal });
      // Only error objects from bad-request responses are needed to distinguish expired refresh grants.
      if (!response.ok && response.status !== 400) {
        await response.body?.cancel().catch(() => {});
        throw providerFailure(kind, response.status, undefined);
      }
      const data = await responseFields(response);
      if (!response.ok || (kind === 'slack' && data.ok !== true) || data.error) {
        const code = fields(data.error) ? data.error.code : data.error;
        throw providerFailure(kind, response.status, typeof code === 'string' ? code : undefined);
      }
      return data;
    } catch (error) {
      if (error instanceof RequestError) throw error;
      throw new RequestError(
        signal.aborted
          ? 'The provider request timed out or was cancelled. Try again.'
          : 'Unable to reach the sign-in provider. Try again shortly.',
        503,
      );
    }
  }

  private async tokens(kind: ProviderKind, params: URLSearchParams, signal: AbortSignal): Promise<TokenSet> {
    const url = kind === 'slack' ? slackApi + 'oauth.v2.access' : microsoftAuth + 'token';
    const data = await this.request(
      kind,
      url,
      { method: 'POST', body: params, headers: { Accept: 'application/json' } },
      signal,
    );
    return tokenSet(kind, data);
  }
  async exchange(
    kind: ProviderKind,
    clientId: string,
    redirectUri: string,
    code: string,
    verifier: string,
    signal?: AbortSignal,
  ) {
    const cancel = deadline(signal);
    const tokens = await this.tokens(
      kind,
      new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        redirect_uri: callbackUri(redirectUri),
        code,
        code_verifier: verifier,
      }),
      cancel,
    );
    const headers = bearer(tokens.accessToken);
    if (kind === 'slack') {
      const identity = await this.request(kind, slackApi + 'auth.test', { method: 'POST', headers }, cancel);
      if (
        identity.bot_id ||
        typeof identity.team_id !== 'string' ||
        !/^T[A-Z0-9]{1,127}$/.test(identity.team_id) ||
        typeof identity.user_id !== 'string' ||
        !/^[UW][A-Z0-9]{1,127}$/.test(identity.user_id)
      )
        throw invalidResponse();
      return {
        accountKey: identity.team_id + ':' + identity.user_id,
        name: label(identity.user) + ' · ' + label(identity.team),
        tokens,
      };
    }
    const identity = await this.request(
      kind,
      graph + '/me?$select=id,displayName,userPrincipalName',
      { headers },
      cancel,
    );
    if (typeof identity.id !== 'string' || !guid.test(identity.id)) throw invalidResponse();
    const display = label(identity.displayName);
    const principal = identity.userPrincipalName ? label(identity.userPrincipalName) : '';
    const name =
      principal && principal.toLowerCase() !== display.toLowerCase()
        ? display + ' (' + principal + ')'
        : display;
    return { accountKey: identity.id, name, tokens };
  }
  async refresh(
    kind: ProviderKind,
    clientId: string,
    refreshToken: string,
    signal?: AbortSignal,
  ): Promise<TokenSet> {
    return this.tokens(
      kind,
      new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: secret(refreshToken),
      }),
      deadline(signal),
    );
  }

  private async choices(
    directory: Directory,
    start: URL,
    accessToken: string,
    signal: AbortSignal,
  ): Promise<Choice[]> {
    const choices = new Map<string, Choice>();
    const pages = new Set<string>();
    const headers = bearer(accessToken);
    const kind = directory === 'slack' ? 'slack' : 'teams';
    let signedInUser: string | undefined;
    let url = start;
    while (true) {
      if (pages.has(url.href))
        throw new RequestError('The provider repeated a directory page. Reload the list.', 502);
      if (pages.size >= 50)
        throw new RequestError(
          'This directory exceeds the 50-page limit. Choose a smaller team or another account.',
          422,
        );
      pages.add(url.href);
      const data = await this.request(kind, url, { headers }, signal);
      const rows = directory === 'slack' ? data.channels : data.value;
      if (!Array.isArray(rows)) throw invalidResponse();
      for (const row of rows) {
        const item = choice(directory, row);
        if (item) choices.set(item.id, item);
        if (choices.size > 10_000)
          throw new RequestError(
            'This directory exceeds 10,000 destinations. Choose a smaller team or another account.',
            422,
          );
      }
      if (directory === 'slack') {
        const metadata = data.response_metadata;
        if (metadata != null && !fields(metadata)) throw invalidResponse();
        const cursor = metadata?.next_cursor;
        if (cursor == null || cursor === '') break;
        if (typeof cursor !== 'string' || cursor.length > 8192) throw invalidResponse();
        url = new URL(start);
        url.searchParams.set('cursor', cursor);
      } else {
        const link = data['@odata.nextLink'];
        if (link == null) break;
        if (typeof link !== 'string' || link.length > 16_384) throw invalidResponse();
        try {
          url = new URL(link);
        } catch {
          throw invalidResponse();
        }
        if (url.origin !== start.origin || url.username || url.password || url.hash) throw invalidResponse();
        if (url.pathname.toLowerCase() !== start.pathname.toLowerCase()) {
          // Graph also documents /users/{id}/joinedTeams. Accept that alias only for the token's own user.
          const userId = /^\/v1\.0\/users\/([^/]+)\/joinedTeams$/i.exec(url.pathname)?.[1];
          if (directory !== 'teams' || !userId || !guid.test(userId)) throw invalidResponse();
          if (!signedInUser) {
            const me = await this.request('teams', graph + '/me?$select=id', { headers }, signal);
            if (typeof me.id !== 'string' || !guid.test(me.id)) throw invalidResponse();
            signedInUser = me.id.toLowerCase();
          }
          if (signedInUser !== userId.toLowerCase()) throw invalidResponse();
        }
      }
    }
    return [...choices.values()];
  }
  async teams(accessToken: string, signal?: AbortSignal): Promise<Choice[]> {
    // joinedTeams does not support OData query parameters.
    return this.choices('teams', new URL(graph + '/me/joinedTeams'), accessToken, deadline(signal));
  }
  async channels(
    kind: ProviderKind,
    accessToken: string,
    teamId?: string,
    signal?: AbortSignal,
  ): Promise<Choice[]> {
    const cancel = deadline(signal);
    if (kind === 'slack') {
      const url = new URL(slackApi + 'users.conversations');
      url.search = new URLSearchParams({
        types: 'public_channel,private_channel',
        exclude_archived: 'true',
        limit: '200',
      }).toString();
      return this.choices('slack', url, accessToken, cancel);
    }
    if (typeof teamId !== 'string' || !guid.test(teamId)) throw new RequestError('Choose a Microsoft team.');
    // A Teams service admin may have directory visibility outside their own joined teams.
    const joined = await this.teams(accessToken, cancel);
    if (!joined.some((item) => item.id.toLowerCase() === teamId.toLowerCase()))
      throw new RequestError('Choose a team you have joined.', 403);
    const url = new URL(graph + '/teams/' + teamId + '/channels?$select=id,displayName,isArchived');
    return this.choices('channels', url, accessToken, cancel);
  }
}
