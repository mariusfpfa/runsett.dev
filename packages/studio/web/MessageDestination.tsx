import { useEffect, useState } from 'react';
import { ChevronDown, LoaderCircle, Plus, RefreshCw } from 'lucide-react';
import { isOAuthConnectionId } from '../modules/connector-settings.mjs';
import type { ConnectionSummary, MessageSetting, WebhookKind } from '../src/connector-settings.js';
import { AccountSignIn } from './AccountSignIn.js';
import type { ConnectionControls } from './ConnectorFields.js';
import { IconButton } from './ui.js';
import { api, message } from './workspace.js';

type Choice = { id: string; name: string };
type Directory = { path: string; items: Choice[]; loading: boolean; error: string };

function DirectoryPicker({
  label,
  path,
  savedId,
  savedName,
  slack,
  change,
}: {
  label: 'Team' | 'Channel';
  path: string;
  savedId: string;
  savedName: string;
  slack: boolean;
  change(choice: Choice): void;
}) {
  const [state, setState] = useState<Directory>({ path: '', items: [], loading: false, error: '' });
  const [version, setVersion] = useState(0);
  const singular = label.toLowerCase();
  const plural = singular + 's';
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    setState((previous) => ({
      path,
      items: previous.path === path ? previous.items : [],
      loading: true,
      error: '',
    }));
    api<{ items: Choice[] }>(path, 'GET', undefined, controller.signal)
      .then(({ items }) => {
        if (!controller.signal.aborted) setState({ path, items, loading: false, error: '' });
      })
      .catch((err) => {
        if (!controller.signal.aborted)
          setState((previous) => ({ ...previous, loading: false, error: message(err) }));
      });
    return () => controller.abort();
  }, [path, version]);
  const loading = !!path && (state.path !== path || state.loading);
  const items = state.path === path ? state.items : [];
  const error = state.path === path ? state.error : '';
  const unlisted = !!savedId && !items.some((choice) => choice.id === savedId);
  const id = 'message-destination-' + singular;
  return (
    <div className="field directory-picker" aria-busy={loading}>
      <span className="field-title">
        <label htmlFor={id}>{label}</label>
        <IconButton
          label={'Refresh ' + plural}
          disabled={!path || loading}
          onClick={() => setVersion((n) => n + 1)}
        >
          {loading ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />}
        </IconButton>
      </span>
      <span className="select-wrap">
        <select
          id={id}
          value={savedId}
          disabled={!path || (loading && !items.length) || (!!error && !items.length)}
          onChange={(event) => {
            const item = items.find((choice) => choice.id === event.target.value);
            change(item ?? { id: '', name: '' });
          }}
        >
          <option value="">
            {!path
              ? 'Choose a team first'
              : loading && !items.length
                ? 'Loading ' + plural + '…'
                : 'Choose a ' + singular}
          </option>
          {unlisted && <option value={savedId}>{savedName || savedId}</option>}
          {items.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
        <ChevronDown size={14} />
      </span>
      {error ? (
        <small role="alert" className="field-error">
          {error}{' '}
          <button type="button" className="text-action" onClick={() => setVersion((n) => n + 1)}>
            Retry {plural}
          </button>
        </small>
      ) : path && !loading && !items.length ? (
        <small>
          No {plural} available {label === 'Channel' && !slack ? 'in this team' : 'to this account'}.
        </small>
      ) : unlisted && !loading && path ? (
        <small>The saved {singular} is outside the current list.</small>
      ) : null}
    </div>
  );
}

export function MessageDestination({
  kind,
  settings,
  connections,
  signInKey,
  change,
  newWebhook,
}: {
  kind: WebhookKind;
  settings: MessageSetting;
  connections: ConnectionControls;
  signInKey: string;
  change(setting: string): void;
  newWebhook(): void;
}) {
  const [reconnect, setReconnect] = useState(0);
  const available = connections.list.filter((item) => item.kind === kind);
  const accounts = available.filter((item) => 'auth' in item && item.auth === 'oauth');
  const webhooks = available.filter((item) => !('auth' in item) || item.auth !== 'oauth');
  const current = available.find((item) => item.id === settings.connectionId);
  const oauth = current
    ? 'auth' in current && current.auth === 'oauth'
    : isOAuthConnectionId(settings.connectionId);
  const base = 'connections/' + encodeURIComponent(settings.connectionId);
  function account(connectionId: string) {
    if (connectionId !== settings.connectionId)
      change(JSON.stringify({ message: settings.message, connectionId }));
  }
  function connected(item: ConnectionSummary) {
    connections.remember(item);
    account(item.id);
    setReconnect((n) => n + 1);
  }
  return (
    <div className="message-destination">
      <div className="field directory-picker">
        <span className="field-title">
          <label htmlFor="message-account">Account</label>
          <IconButton label="Refresh accounts" disabled={connections.loading} onClick={connections.reload}>
            {connections.loading ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />}
          </IconButton>
        </span>
        <span className="select-wrap">
          <select
            id="message-account"
            value={settings.connectionId}
            onChange={(event) => account(event.target.value)}
          >
            <option value="">
              {connections.loading && !available.length ? 'Loading accounts…' : 'Choose an account'}
            </option>
            {settings.connectionId && !current && (
              <option value={settings.connectionId} disabled>
                {connections.loading ? 'Loading saved account…' : 'Connection unavailable'}
              </option>
            )}
            {!!accounts.length && (
              <optgroup label="Signed-in accounts">
                {accounts.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </optgroup>
            )}
            {!!webhooks.length && (
              <optgroup label="Webhook connections">
                {webhooks.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          <ChevronDown size={14} />
        </span>
        {connections.error && (
          <small className="field-error" role="alert">
            {connections.error}{' '}
            <button type="button" className="text-action" onClick={connections.reload}>
              Retry accounts
            </button>
          </small>
        )}
      </div>
      <AccountSignIn
        kind={kind}
        accountId={settings.connectionId}
        storageKey={signInKey}
        connected={connected}
      />
      {oauth && (
        <div key={settings.connectionId + '/' + reconnect} className="account-destination-fields">
          {kind === 'teams' && (
            <DirectoryPicker
              label="Team"
              path={base + '/teams'}
              savedId={settings.teamId ?? ''}
              savedName={settings.teamName ?? ''}
              slack={false}
              change={(team) => {
                if (team.id !== settings.teamId)
                  change(
                    JSON.stringify({
                      connectionId: settings.connectionId,
                      message: settings.message,
                      teamId: team.id,
                      teamName: team.name,
                    }),
                  );
              }}
            />
          )}
          <DirectoryPicker
            label="Channel"
            path={
              kind === 'slack'
                ? base + '/channels'
                : settings.teamId
                  ? base + '/channels?' + new URLSearchParams({ teamId: settings.teamId })
                  : ''
            }
            savedId={settings.channelId ?? ''}
            savedName={settings.channelName ?? ''}
            slack={kind === 'slack'}
            change={(channel) =>
              change(JSON.stringify({ ...settings, channelId: channel.id, channelName: channel.name }))
            }
          />
        </div>
      )}
      {current && !oauth && <p className="field-help">Messages use this webhook’s configured destination.</p>}
      <details className="webhook-alternative">
        <summary>Use an incoming webhook</summary>
        <button type="button" className="text-action" onClick={newWebhook}>
          <Plus size={13} /> New webhook connection
        </button>
      </details>
    </div>
  );
}
