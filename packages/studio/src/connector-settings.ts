// The editor, server and immutable runner use the same validation and defaults.
export {
  connectorDefaults,
  containsWebhookUrl,
  isConnectorKind,
  maxConnectorSettingBytes,
  parseConnectorSetting,
  type ConnectionSummary,
  type ConnectorKind,
  type HttpSetting,
  type MessageSetting,
  type WebhookKind,
} from '../modules/connector-settings.mjs';
