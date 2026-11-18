export type WebhookKind = 'slack' | 'teams';
export type ConnectorKind = 'http' | WebhookKind;
export type ConnectionSummary =
  | { id: string; name: string; kind: WebhookKind; auth?: 'oauth' }
  | { id: string; name: string; kind: 'http'; origin: string };
export type HttpSetting = {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  headers: Record<string, string>;
  body: 'none' | 'input' | 'custom';
  customBody: string;
  connectionId?: string;
};
export type MessageSetting = {
  connectionId: string;
  message: string;
  teamId?: string;
  teamName?: string;
  channelId?: string;
  channelName?: string;
};
export const maxConnectorSettingBytes: number;
export const connectorDefaults: Readonly<Record<ConnectorKind, string>>;
export function isConnectorKind(kind: unknown): kind is ConnectorKind;
export function isConnectionId(kind: ConnectorKind, id: unknown): id is string;
export function isOAuthConnectionId(id: unknown): boolean;
export function containsWebhookUrl(text: string): boolean;
export function blockedDestination(hostname: string): boolean;
export function webhookUrl(kind: WebhookKind, raw: unknown): URL;
export function httpOrigin(raw: unknown): string;
export function isBearerToken(token: unknown, maxLength?: number): token is string;
export function parseConnectorSetting(kind: 'http', raw: unknown, allowIncomplete?: boolean): HttpSetting;
export function parseConnectorSetting(
  kind: WebhookKind,
  raw: unknown,
  allowIncomplete?: boolean,
): MessageSetting;
export function parseConnectorSetting(
  kind: ConnectorKind,
  raw: unknown,
  allowIncomplete?: boolean,
): HttpSetting | MessageSetting;
