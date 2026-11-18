import { createHash } from 'node:crypto';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { brotliDecompressSync, unzipSync } from 'node:zlib';
import {
  blockedDestination,
  isBearerToken,
  isOAuthConnectionId,
  parseConnectorSetting,
  webhookUrl,
} from './connector-settings.mjs';

const requestLimit = 256 * 1024;
const responseLimit = 128 * 1024;
const messageLimit = 24 * 1024;
const requestTimeoutMs = 12_000;
class RequestFailure extends Error {}

function checkedLookup(hostname, options, callback) {
  // Check the very addresses the socket will use, including when a public name resolves to metadata.
  dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error);
    if (!addresses.length || addresses.some(({ address }) => blockedDestination(address)))
      return callback(new RequestFailure('Cloud metadata and link-local destinations are unavailable.'));
    if (options.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
}

function messageText(template, value) {
  const parts = template.split('{{value}}');
  const replacement = parts.length === 1 ? '' : typeof value === 'string' ? value : JSON.stringify(value);
  if (Buffer.byteLength(replacement) * (parts.length - 1) > messageLimit)
    throw new Error('The rendered message exceeds 24 KiB.');
  const text = parts.join(replacement);
  if (!text.trim()) throw new Error('The rendered message is empty.');
  return text;
}

function outboundRequest(kind, setting, value, credentials) {
  if (kind === 'http') {
    const headers = { ...setting.headers };
    const url = new URL(setting.url);
    if (setting.connectionId) {
      const scope = createHash('sha256').update(url.origin).digest('hex');
      if (url.protocol !== 'https:' || !setting.connectionId.startsWith('http-' + scope + '-'))
        throw new Error('The selected connection requires its original HTTPS origin.');
      if (
        !Object.hasOwn(credentials, setting.connectionId) ||
        !isBearerToken(credentials[setting.connectionId])
      )
        throw new Error('The selected HTTP connection is unavailable.');
      headers.Authorization = 'Bearer ' + credentials[setting.connectionId];
    }
    let body;
    if (setting.body === 'input') body = JSON.stringify(value);
    if (setting.body === 'custom') body = setting.customBody;
    if (body !== undefined && !Object.keys(headers).some((key) => key.toLowerCase() === 'content-type'))
      headers['Content-Type'] = setting.body === 'input' ? 'application/json' : 'text/plain; charset=utf-8';
    return { url, method: setting.method, headers, body };
  }
  if (!Object.hasOwn(credentials, setting.connectionId))
    throw new Error('The selected message connection is unavailable.');
  const credential = credentials[setting.connectionId];
  const text = messageText(setting.message, value);
  if (isOAuthConnectionId(setting.connectionId)) {
    if (!isBearerToken(credential, 32 * 1024)) throw new Error('Sign in to the selected account again.');
    const url =
      kind === 'slack'
        ? new URL('https://slack.com/api/chat.postMessage')
        : new URL(
            'https://graph.microsoft.com/v1.0/teams/' +
              encodeURIComponent(setting.teamId) +
              '/channels/' +
              encodeURIComponent(setting.channelId) +
              '/messages',
          );
    const payload =
      kind === 'slack'
        ? { channel: setting.channelId, text }
        : { body: { contentType: 'text', content: text } };
    return {
      url,
      method: 'POST',
      headers: { Authorization: 'Bearer ' + credential, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    };
  }
  const url = webhookUrl(kind, credential);
  const payload =
    kind === 'slack'
      ? { text }
      : {
          type: 'message',
          attachments: [
            {
              contentType: 'application/vnd.microsoft.card.adaptive',
              contentUrl: null,
              content: {
                $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
                type: 'AdaptiveCard',
                version: '1.2',
                body: [{ type: 'TextBlock', text, wrap: true }],
              },
            },
          ],
        };
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body) > messageLimit) throw new Error('The rendered webhook payload exceeds 24 KiB.');
  return { url, method: 'POST', headers: { 'Content-Type': 'application/json' }, body };
}

async function responseBody(response) {
  const tooLarge = () => new RequestFailure('The HTTP response exceeds 128 KiB.');
  if (Number(response.headers['content-length']) > responseLimit) throw tooLarge();
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response) {
    bytes += chunk.length;
    if (bytes > responseLimit) throw tooLarge();
    chunks.push(chunk);
  }
  if (!bytes) return null;
  let buffer = Buffer.concat(chunks, bytes);
  const encoding = response.headers['content-encoding']?.trim().toLowerCase();
  if (encoding && encoding !== 'identity') {
    const decode = { gzip: unzipSync, deflate: unzipSync, br: brotliDecompressSync };
    if (!Object.hasOwn(decode, encoding)) throw new RequestFailure('Unsupported HTTP response encoding.');
    try {
      buffer = decode[encoding](buffer, { maxOutputLength: responseLimit });
    } catch (error) {
      if (error.code === 'ERR_BUFFER_TOO_LARGE') throw tooLarge();
      throw new RequestFailure('Could not decode the HTTP response.');
    }
  }
  if (!buffer.length) return null;
  const text = buffer.toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export default async function connector({ kind, setting: raw, value }, { credentials, signal }) {
  const setting = parseConnectorSetting(kind, raw);
  const { url, method, headers, body } = outboundRequest(kind, setting, value, credentials);
  if (body !== undefined) {
    const bytes = Buffer.byteLength(body);
    if (bytes > requestLimit) throw new Error('The HTTP request body exceeds 256 KiB.');
    headers['Content-Length'] = String(bytes);
  }
  const deadline = AbortSignal.timeout(requestTimeoutMs);
  const cancel = AbortSignal.any([signal, deadline]);
  let response;
  try {
    cancel.throwIfAborted();
    const transport = url.protocol === 'https:' ? https : http;
    response = await new Promise((resolve, reject) => {
      // A fresh request sends once. Node's HTTP transports never follow a Location header.
      const req = transport.request(
        url,
        {
          method,
          headers,
          signal: cancel,
          agent: false,
          lookup: checkedLookup,
          maxHeaderSize: 16 * 1024,
        },
        resolve,
      );
      req.on('error', reject);
      req.end(body);
    });
    const status = response.statusCode;
    const account = kind !== 'http' && isOAuthConnectionId(setting.connectionId);
    if (account && status === 401) throw new RequestFailure('Sign in to the selected account again.');
    if (account && (status === 403 || status === 404))
      throw new RequestFailure(
        'Check that the selected channel is available and the account can post to it.',
      );
    if (status < 200 || status >= 300) throw new RequestFailure('The endpoint returned HTTP ' + status + '.');
    if (kind === 'http') return { status, body: await responseBody(response) };
    if (account && kind === 'slack') {
      const result = await responseBody(response);
      if (result?.ok !== true) {
        if (['invalid_auth', 'token_expired', 'token_revoked', 'missing_scope'].includes(result?.error))
          throw new RequestFailure('Sign in to Slack again and grant permission to send messages.');
        throw new RequestFailure('Slack could not post the message. Check access to the selected channel.');
      }
    }
    return {
      sent: true,
      provider: kind,
      status,
      ...(account ? { channelId: setting.channelId } : {}),
      ...(account && kind === 'teams' ? { teamId: setting.teamId } : {}),
    };
  } catch (error) {
    if (signal.aborted) throw new Error('The request was cancelled.');
    if (deadline.aborted) throw new Error('The request timed out.');
    if (error instanceof RequestFailure) throw error;
    // DNS, socket and TLS errors can contain the original URL or other private peer data.
    throw new Error('Could not complete the HTTP request. Check the destination and its network connection.');
  } finally {
    response?.destroy();
  }
}
