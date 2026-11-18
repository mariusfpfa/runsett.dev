import { utf8ByteLength } from '@runsett/contracts/json';

export const maxConnectorSettingBytes = 64 * 1024;
const httpDefaults = { method: 'GET', url: '', headers: {}, body: 'none', customBody: '', connectionId: '' };
const messageDefaults = {
  connectionId: '',
  message: '{{value}}',
  teamId: '',
  teamName: '',
  channelId: '',
  channelName: '',
};
export const connectorDefaults = Object.freeze({
  http: JSON.stringify(httpDefaults),
  slack: JSON.stringify(messageDefaults),
  teams: JSON.stringify(messageDefaults),
});

export function isConnectorKind(kind) {
  return kind === 'http' || kind === 'slack' || kind === 'teams';
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function isOAuthConnectionId(id) {
  const match = typeof id === 'string' && /^(?:slack|teams)-oauth-(.+)$/.exec(id);
  return !!match && uuid.test(match[1]);
}
export function isConnectionId(kind, id) {
  if (typeof id !== 'string') return false;
  if (kind === 'http') {
    const match = /^http-[a-f0-9]{64}-([a-f0-9-]+)$/.exec(id);
    return !!match && uuid.test(match[1]);
  }
  return (
    (kind === 'slack' || kind === 'teams') &&
    id.startsWith(kind + '-') &&
    (isOAuthConnectionId(id) || uuid.test(id.slice(kind.length + 1)))
  );
}

// These URLs contain credentials in the path or query. They belong only in the local connection store.
const webhookPatterns = [
  /hooks\.slack(?:-gov)?\.com\.?(?::\d+)?\/services\//i,
  /logic\.azure\.(?:com|us|cn)\.?(?::\d+)?\/workflows\//i,
  /\/powerautomate\/automations\/direct\/workflows\//i,
  /(?:webhook\.office\.com|outlook\.office(?:365)?\.com)\.?(?::\d+)?\/webhook/i,
];
export function containsWebhookUrl(text) {
  const decoded = text.replace(/%([a-f0-9]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  return webhookPatterns.some((pattern) => pattern.test(decoded));
}

const powerPlatformDomains = [
  '.environment.api.powerplatform.com',
  '.environment.api.gov.powerplatform.microsoft.us',
  '.environment.api.high.powerplatform.microsoft.us',
  '.environment.api.appsplatform.us',
  '.environment.api.powerplatform.partner.microsoftonline.cn',
];
const logicHost = /\.logic\.azure\.(?:com|us|cn)$/;
const workflowPath = /^\/workflows\/[\w-]+\/triggers\/[\w-]+\/paths\/invoke\/?$/;
export function webhookUrl(kind, raw) {
  let url;
  if (typeof raw === 'string' && raw.length <= 8192 && /^https:\/\//i.test(raw) && !/[\s\\]/.test(raw)) {
    try {
      url = new URL(raw);
    } catch {
      /* Report a value-free provider error below. */
    }
  }
  if (url && url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash) {
    if (
      kind === 'slack' &&
      ['hooks.slack.com', 'hooks.slack-gov.com'].includes(url.hostname) &&
      /^\/services\/[\w-]+\/[\w-]+\/[\w-]+$/.test(url.pathname) &&
      !url.search
    )
      return url;
    if (kind === 'teams') {
      if (logicHost.test(url.hostname) && workflowPath.test(url.pathname)) return url;
      const prefix = '/powerautomate/automations/direct';
      if (
        powerPlatformDomains.some((domain) => url.hostname.endsWith(domain)) &&
        url.pathname.startsWith(prefix) &&
        workflowPath.test(url.pathname.slice(prefix.length))
      )
        return url;
    }
  }
  throw new Error(
    kind === 'slack' ? 'Enter a Slack incoming webhook URL.' : 'Enter a Teams Workflows webhook URL.',
  );
}

const metadataHosts = new Set([
  'metadata',
  'metadata.google.internal',
  'metadata.google',
  'metadata.azure.internal',
  'instance-data',
  'instance-data.ec2.internal',
  'metadata.tencentyun.com',
]);
function metadataIPv4(address) {
  return address.startsWith('169.254.') || address === '100.100.100.200' || address === '168.63.129.16';
}
export function blockedDestination(hostname) {
  let host = hostname.toLowerCase().replace(/\.$/, '');
  if (metadataHosts.has(host) || metadataIPv4(host)) return true;
  if (!host.includes(':')) return false;
  // URL canonicalizes compressed, expanded, and IPv4-mapped IPv6 literals identically.
  host = host.replace(/^\[|\]$/g, '');
  try {
    host = new URL('http://[' + host + ']/').hostname.slice(1, -1);
  } catch {
    return true;
  }
  if (/^fe[89ab][0-9a-f]:|^fd00:ec2:|^fd20:ce:/.test(host)) return true;
  const mapped = /^(?:::ffff:|::|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (!mapped) return false;
  const high = parseInt(mapped[1], 16),
    low = parseInt(mapped[2], 16);
  return metadataIPv4([high >> 8, high & 255, low >> 8, low & 255].join('.'));
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function boundedText(value, max) {
  return typeof value === 'string' && value.length <= max && utf8ByteLength(value) <= max;
}
function validateDestination(kind, setting, allowIncomplete) {
  const { connectionId, teamId, channelId, teamName, channelName } = setting;
  for (const label of [teamName, channelName]) {
    if (!boundedText(label, 1024) || /[\x00-\x1f\x7f]/.test(label) || containsWebhookUrl(label))
      throw new Error('Choose a destination from the channel list.');
  }
  if (!isOAuthConnectionId(connectionId)) {
    if (teamId !== '' || channelId !== '' || teamName || channelName)
      throw new Error('Choose a signed-in account for this channel.');
    return;
  }
  if (kind === 'teams') {
    if (
      !(allowIncomplete && teamId === '') &&
      !(typeof teamId === 'string' && uuid.test(teamId.toLowerCase()))
    )
      throw new Error('Choose a team for this Teams message.');
  } else if (teamId !== '' || teamName) {
    throw new Error('Choose a Slack channel.');
  }
  if (allowIncomplete && channelId === '') return;
  if (
    !boundedText(channelId, 512) ||
    !channelId.trim() ||
    /[\\/%?#\s\x00-\x1f\x7f]/.test(channelId) ||
    channelId === '.' ||
    channelId === '..' ||
    (kind === 'slack' && !/^[CG][A-Z0-9]{1,127}$/.test(channelId))
  )
    throw new Error('Choose a channel for this message.');
}
function credentialField(name) {
  const words = name.toLowerCase();
  return (
    /authorization|cookie|password|credential|signature|secret|token|api[-_]?key|access[-_]?key/.test(
      words,
    ) || /(?:^|[-_])(?:key|sig|auth)(?:$|[-_])/.test(words)
  );
}
function publicUrl(value, allowIncomplete) {
  if (!boundedText(value, 8192) || /[\s\\{}]/.test(value))
    throw new Error('Enter a static HTTP or HTTPS URL of up to 8 KiB.');
  if (containsWebhookUrl(value) || /\/\/[^/?#]*@/.test(value))
    throw new Error('Use a public HTTP URL. Store webhook credentials in a named connection.');
  const query = value.indexOf('?');
  if (query !== -1 && [...new URLSearchParams(value.slice(query + 1)).keys()].some(credentialField))
    throw new Error('Remove credentials from the HTTP URL.');
  if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^https?:/i.test(value))
    throw new Error('The HTTP step supports HTTP and HTTPS URLs.');
  let url;
  try {
    url = new URL(value);
  } catch {
    /* Incomplete drafts can be saved. */
  }
  if (!url) {
    if (allowIncomplete) return;
    throw new Error('Enter a complete HTTP or HTTPS URL.');
  }
  if (containsWebhookUrl(url.href)) throw new Error('Store webhook credentials in a named connection.');
  if (url.username || url.password || url.hash || !/^https?:\/\//i.test(value))
    throw new Error('Use an absolute HTTP or HTTPS URL without embedded credentials or a fragment.');
  if (blockedDestination(url.hostname))
    throw new Error('Cloud metadata and link-local destinations are unavailable.');
  return url;
}

export function httpOrigin(raw) {
  const url = publicUrl(raw, false);
  if (url.protocol !== 'https:' || url.pathname !== '/' || /[?#]/.test(raw))
    throw new Error('Enter an HTTPS origin with a hostname and optional port.');
  return url.origin;
}

export function isBearerToken(token, maxLength = 8192) {
  return typeof token === 'string' && token.length <= maxLength && /^[a-zA-Z0-9._~+/-]+=*$/.test(token);
}

const reservedHeaders = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'upgrade',
  'expect',
  'te',
  'trailer',
  'accept-encoding',
  'forwarded',
  'via',
  'metadata',
  'metadata-flavor',
  'x-google-metadata-request',
  '__proto__',
  'constructor',
  'prototype',
]);
function publicHeaders(headers) {
  if (!record(headers) || Object.keys(headers).length > 24) throw new Error('Use up to 24 HTTP headers.');
  const seen = new Set();
  let bytes = 0;
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (
      !/^[!#$%&'*+.^_\x60|~\w-]{1,128}$/.test(name) ||
      seen.has(lower) ||
      reservedHeaders.has(lower) ||
      /^(?:proxy-|sec-|x-forwarded-)/.test(lower)
    )
      throw new Error('Use distinct HTTP headers. Transport and proxy headers are reserved.');
    if (
      credentialField(name) ||
      typeof value !== 'string' ||
      /[^\x20-\x7e]/.test(value) ||
      /^\s*(?:basic|bearer)\s+/i.test(value) ||
      containsWebhookUrl(value)
    )
      throw new Error('Use public, single-line HTTP headers. Header values are saved in the workflow.');
    seen.add(lower);
    bytes += name.length + value.length + 4;
  }
  if (bytes > 8192) throw new Error('HTTP headers must fit within 8 KiB.');
}

export function parseConnectorSetting(kind, raw, allowIncomplete = false) {
  if (!isConnectorKind(kind) || !boundedText(raw, maxConnectorSettingBytes))
    throw new Error('Connector settings must fit within 64 KiB.');
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error('Provide valid JSON connector settings.');
  }
  const defaults = kind === 'http' ? httpDefaults : messageDefaults;
  if (!record(data) || Object.keys(data).some((key) => !Object.hasOwn(defaults, key)))
    throw new Error('Check the connector settings.');
  const setting = { ...defaults, ...data };
  if (kind === 'http') {
    if (
      !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(setting.method) ||
      !['none', 'input', 'custom'].includes(setting.body) ||
      !boundedText(setting.customBody, 32 * 1024)
    )
      throw new Error('Choose an HTTP method and body mode. Custom text must fit within 32 KiB.');
    const url = publicUrl(setting.url, allowIncomplete);
    publicHeaders(setting.headers);
    if (setting.connectionId !== '' && !isConnectionId('http', setting.connectionId))
      throw new Error('Choose a saved HTTP connection.');
    if (setting.connectionId && url && url.protocol !== 'https:')
      throw new Error('HTTP connections with credentials require HTTPS.');
    if (containsWebhookUrl(setting.customBody)) throw new Error('Store webhook URLs in named connections.');
    if (!allowIncomplete && setting.method === 'GET' && setting.body !== 'none')
      throw new Error('Choose No body for a GET request.');
  } else {
    const id = setting.connectionId;
    const partialId =
      typeof id === 'string' &&
      id.length <= kind.length + 37 &&
      (kind.startsWith(id) || (id.startsWith(kind + '-') && /^[0-9a-f-]*$/.test(id.slice(kind.length + 1))));
    if (!isConnectionId(kind, id) && !(allowIncomplete && partialId))
      throw new Error('Choose a saved ' + (kind === 'slack' ? 'Slack' : 'Teams') + ' connection.');
    validateDestination(kind, setting, allowIncomplete);
    if (!boundedText(setting.message, 16 * 1024) || (!allowIncomplete && !setting.message.trim()))
      throw new Error('Enter a message of up to 16 KiB.');
    if (containsWebhookUrl(setting.message)) throw new Error('Store webhook URLs in named connections.');
  }
  return setting;
}
