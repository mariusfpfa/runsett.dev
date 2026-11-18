import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, KeyRound, PencilLine, Plus, RefreshCw, X } from 'lucide-react';
import {
  parseConnectorSetting,
  type ConnectionSummary,
  type HttpSetting,
  type MessageSetting,
} from '../src/connector-settings.js';
import { IconButton, Modal, Tile, useInvalidDraft, type MarkInvalid } from './ui.js';
import { api, message } from './workspace.js';
import { MessageDestination } from './MessageDestination.js';

export function useConnections(needed: boolean) {
  const [list, setList] = useState<ConnectionSummary[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [version, setVersion] = useState(0);
  const generation = useRef(0);
  const reload = useCallback(() => setVersion((current) => current + 1), []);
  useEffect(() => {
    if (!needed) return;
    window.addEventListener('focus', reload);
    return () => window.removeEventListener('focus', reload);
  }, [needed, reload]);
  useEffect(() => {
    if (!needed) return;
    const controller = new AbortController();
    const requestVersion = generation.current;
    setLoading(true);
    setError('');
    api<ConnectionSummary[]>('connections', 'GET', undefined, controller.signal)
      .then((connections) => {
        if (!controller.signal.aborted && generation.current === requestVersion) setList(connections);
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(message(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [needed, version]);
  return {
    list,
    loading,
    error,
    reload,
    remember: (connection: ConnectionSummary) => {
      generation.current++;
      setList((previous) => [...previous.filter((item) => item.id !== connection.id), connection]);
      reload();
    },
  };
}
export type ConnectionControls = ReturnType<typeof useConnections>;

function NewConnection({
  kind,
  origin,
  close,
  saved,
}: {
  kind: 'slack' | 'teams' | 'http';
  origin?: string;
  close(): void;
  saved(connection: ConnectionSummary): void;
}) {
  const [name, setName] = useState('');
  const [secret, setSecret] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  const provider = kind === 'http' ? 'HTTP' : kind === 'slack' ? 'Slack' : 'Microsoft Teams';
  return (
    <Modal
      title={'New ' + provider + ' connection'}
      close={() => {
        if (!busy) close();
      }}
    >
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (active.current || !name.trim() || !secret.trim()) return;
          const controller = new AbortController();
          active.current = controller;
          setBusy(true);
          setError('');
          try {
            const payload =
              kind === 'http'
                ? { name: name.trim(), kind, origin, token: secret.trim() }
                : { name: name.trim(), kind, url: secret.trim() };
            const connection = await api<ConnectionSummary>(
              'connections',
              'POST',
              payload,
              controller.signal,
            );
            if (!controller.signal.aborted) {
              setSecret('');
              saved(connection);
            }
          } catch (err) {
            if (!controller.signal.aborted) setError(message(err));
          } finally {
            active.current = null;
            if (!controller.signal.aborted) setBusy(false);
          }
        }}
      >
        <div className="dialog-body">
          <div className="connection-intro">
            <Tile kind={kind} small />
            <p>
              {kind === 'http'
                ? 'Use a bearer token for requests to this API.'
                : 'Connect a ' + (kind === 'teams' ? 'Teams Workflows' : provider) + ' incoming webhook.'}
            </p>
          </div>
          <label className="field">
            Connection name
            <input
              autoFocus
              required
              maxLength={100}
              placeholder={kind === 'http' ? 'e.g. Inventory API' : 'e.g. Team updates'}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          {kind === 'http' && (
            <label className="field">
              API origin
              <input className="mono" readOnly value={origin} />
            </label>
          )}
          <label className="field">
            {kind === 'http' ? 'Bearer token' : 'Webhook URL'}
            <input
              required
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              placeholder={kind === 'http' ? 'Enter token' : 'https://…'}
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
            />
            <small>Studio stores this credential locally. Steps use the saved connection.</small>
          </label>
          {error && (
            <p role="alert" className="setting-error">
              {error}
            </p>
          )}
        </div>
        <div className="dialog-bottom">
          <button type="button" className="btn btn-light" disabled={busy} onClick={close}>
            Cancel
          </button>
          <button className="btn btn-primary" type="submit" disabled={busy || !name.trim() || !secret.trim()}>
            <KeyRound size={14} /> {busy ? 'Saving…' : 'Save connection'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function HttpConnectionPicker({
  origin,
  connectionId,
  connections,
  change,
}: {
  origin: string;
  connectionId: string;
  connections: ConnectionControls;
  change(id: string): void;
}) {
  const [creating, setCreating] = useState(false);
  const available = connections.list.filter((item) => item.kind === 'http' && item.origin === origin);
  const needOrigin = !origin;
  return (
    <>
      <div className="field">
        <span className="field-title">
          <label htmlFor="step-connection">Authentication</label>
          <button
            type="button"
            className="text-action"
            disabled={needOrigin || connections.loading}
            onClick={() => setCreating(true)}
          >
            <Plus size={12} /> New connection
          </button>
        </span>
        <span className="select-wrap">
          <select id="step-connection" value={connectionId} onChange={(e) => change(e.target.value)}>
            <option value="">No authentication</option>
            {connectionId && !available.some((item) => item.id === connectionId) && (
              <option value={connectionId} disabled>
                {connections.loading ? 'Loading saved connection…' : 'Connection unavailable'}
              </option>
            )}
            {available.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
          <ChevronDown size={14} />
        </span>
        {connections.error ? (
          <small className="field-error" role="alert">
            {connections.error}{' '}
            <button type="button" className="text-action" onClick={connections.reload}>
              <RefreshCw size={12} /> Retry
            </button>
          </small>
        ) : (
          <small>
            {needOrigin
              ? 'Enter an HTTPS request URL to use a bearer connection.'
              : 'Bearer connections are scoped to ' + origin + '.'}
          </small>
        )}
      </div>
      {creating && (
        <NewConnection
          kind="http"
          origin={origin}
          close={() => setCreating(false)}
          saved={(connection) => {
            connections.remember(connection);
            change(connection.id);
            setCreating(false);
          }}
        />
      )}
    </>
  );
}

function ConnectorText({
  label,
  value,
  update,
  markInvalid,
}: {
  label: 'Message' | 'Custom body';
  value: string;
  update(value: string): void;
  markInvalid: MarkInvalid;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState('');
  useInvalidDraft(!!error, markInvalid);
  return (
    <label className="field">
      {label}
      <textarea
        rows={4}
        className={label === 'Custom body' ? 'mono' : ''}
        spellCheck={label === 'Message'}
        placeholder={label === 'Custom body' ? '{ "message": "Hello" }' : 'Enter your message'}
        value={draft ?? value}
        aria-invalid={!!error}
        onChange={(event) => {
          const text = event.target.value;
          setDraft(text);
          try {
            update(text);
            setError('');
          } catch (err) {
            setError(message(err));
          }
        }}
        onBlur={() => {
          if (!error) setDraft(null);
        }}
      />
      {error ? (
        <small role="status" className="field-error">
          {error}
        </small>
      ) : (
        <small>
          {label === 'Custom body' ? (
            'Enter JSON or plain text. Set its Content-Type in the headers.'
          ) : (
            <>
              Use <code>{'{{value}}'}</code> to insert the previous step’s output.
            </>
          )}
        </small>
      )}
    </label>
  );
}

export function MessagingFields({
  signInKey,
  kind,
  settings,
  connections,
  change,
  markInvalid,
}: {
  signInKey: string;
  kind: 'slack' | 'teams';
  settings: MessageSetting;
  connections: ConnectionControls;
  change(setting: string): void;
  markInvalid: MarkInvalid;
}) {
  const [creatingWebhook, setCreatingWebhook] = useState(false);
  return (
    <>
      <MessageDestination
        kind={kind}
        settings={settings}
        connections={connections}
        signInKey={signInKey}
        change={change}
        newWebhook={() => setCreatingWebhook(true)}
      />
      {creatingWebhook && (
        <NewConnection
          kind={kind}
          close={() => setCreatingWebhook(false)}
          saved={(connection) => {
            connections.remember(connection);
            change(JSON.stringify({ connectionId: connection.id, message: settings.message }));
            setCreatingWebhook(false);
          }}
        />
      )}
      <ConnectorText
        label="Message"
        value={settings.message}
        markInvalid={markInvalid}
        update={(text) => {
          const setting = JSON.stringify({ ...settings, message: text });
          parseConnectorSetting(kind, setting, true);
          change(setting);
        }}
      />
    </>
  );
}

function HeaderFields({
  settings,
  change,
}: {
  settings: HttpSetting;
  change(headers: Record<string, string>): void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const headers = Object.entries(settings.headers);
  function edit(key: string, content = '') {
    setEditing(key);
    setName(key);
    setValue(content);
    setError('');
  }
  return (
    <div className="header-settings">
      <div className="field-title">
        <span>Headers</span>
        {editing === null && (
          <button type="button" className="text-action" onClick={() => edit('')}>
            <Plus size={12} /> Add header
          </button>
        )}
      </div>
      {!headers.length && editing === null && (
        <p className="field-help">Optional, non-secret request metadata.</p>
      )}
      {headers.map(([key, content]) => (
        <div className="header-pair" key={key}>
          <button
            className="header-value"
            type="button"
            title={'Edit ' + key}
            aria-label={'Edit header ' + key}
            onClick={() => edit(key, content)}
          >
            <span>
              <strong>{key}</strong>
              <small>{content || 'Empty value'}</small>
            </span>
            <PencilLine size={12} />
          </button>
          <IconButton
            label={'Remove header ' + key}
            onClick={() => {
              change(Object.fromEntries(headers.filter(([existing]) => existing !== key)));
              if (editing === key) setEditing(null);
            }}
          >
            <X size={13} />
          </IconButton>
        </div>
      ))}
      {editing !== null && (
        <form
          className="header-form"
          onSubmit={(event) => {
            event.preventDefault();
            const key = name.trim();
            if (!key) return;
            try {
              if (
                headers.some(
                  ([existing]) => existing !== editing && existing.toLowerCase() === key.toLowerCase(),
                )
              )
                throw new Error('A header with this name already exists.');
              const updated = Object.fromEntries([
                ...headers.filter(([existing]) => existing !== editing),
                [key, value],
              ]);
              parseConnectorSetting('http', JSON.stringify({ ...settings, headers: updated }), true);
              change(updated);
              setName('');
              setValue('');
              setEditing(null);
            } catch (err) {
              setError(message(err));
            }
          }}
        >
          <label className="field">
            Header name
            <input
              autoFocus
              required
              className="mono"
              autoComplete="off"
              spellCheck={false}
              value={name}
              placeholder="Content-Type"
              onChange={(e) => {
                setName(e.target.value);
                setError('');
              }}
            />
          </label>
          <label className="field">
            Header value
            <input
              className="mono"
              autoComplete="off"
              spellCheck={false}
              value={value}
              placeholder="application/json"
              onChange={(e) => {
                setValue(e.target.value);
                setError('');
              }}
            />
          </label>
          <small className="field-help">Headers are saved in the workflow. Use non-secret values.</small>
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
          <div className="header-buttons">
            <button
              type="button"
              className="text-action"
              onClick={() => {
                setEditing(null);
                setValue('');
              }}
            >
              Cancel
            </button>
            <button type="submit" className="btn btn-light" disabled={!name.trim()}>
              <Check size={13} /> Save header
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

export function HttpFields({
  settings,
  connections,
  change,
  markInvalid,
}: {
  settings: HttpSetting;
  connections: ConnectionControls;
  change(setting: string): void;
  markInvalid: MarkInvalid;
}) {
  const [draftUrl, setDraftUrl] = useState<string | null>(null);
  const [urlError, setUrlError] = useState('');
  const [authCleared, setAuthCleared] = useState(false);
  useInvalidDraft(!!urlError, markInvalid);
  function originOf(url: string) {
    try {
      return new URL(url).origin;
    } catch {
      return '';
    }
  }
  const origin = originOf(settings.url);
  function patch(values: Partial<HttpSetting>) {
    const setting = JSON.stringify({ ...settings, ...values });
    parseConnectorSetting('http', setting, true);
    change(setting);
  }
  return (
    <>
      <label className="field">
        Method
        <span className="select-wrap">
          <select
            value={settings.method}
            onChange={(e) => {
              const method = e.target.value as HttpSetting['method'];
              patch(method === 'GET' ? { method, body: 'none' } : { method });
            }}
          >
            {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((method) => (
              <option key={method}>{method}</option>
            ))}
          </select>
          <ChevronDown size={14} />
        </span>
      </label>
      <label className="field">
        Request URL
        <input
          type="url"
          className="mono"
          autoCapitalize="off"
          autoComplete="off"
          spellCheck={false}
          placeholder="https://api.example.com/items"
          value={draftUrl ?? settings.url}
          aria-invalid={!!urlError}
          onChange={(event) => {
            const url = event.target.value;
            setDraftUrl(url);
            try {
              const nextOrigin = originOf(url);
              const selected = connections.list.find((connection) => connection.id === settings.connectionId);
              const previousOrigin = selected?.kind === 'http' ? selected.origin : origin;
              const clear = !!settings.connectionId && !!nextOrigin && nextOrigin !== previousOrigin;
              patch(clear ? { url, connectionId: '' } : { url });
              if (clear) setAuthCleared(true);
              setUrlError('');
            } catch (err) {
              setUrlError(message(err));
            }
          }}
          onBlur={() => {
            if (!urlError) setDraftUrl(null);
          }}
        />
        {urlError && (
          <small className="field-error" role="status">
            {urlError}
          </small>
        )}
      </label>
      <HttpConnectionPicker
        origin={origin.startsWith('https://') ? origin : ''}
        connectionId={settings.connectionId ?? ''}
        connections={connections}
        change={(connectionId) => {
          patch({ connectionId });
          setAuthCleared(false);
        }}
      />
      {authCleared && (
        <p className="field-help auth-note" role="status">
          Authentication was cleared for the new API origin.
        </p>
      )}
      <HeaderFields settings={settings} change={(headers) => patch({ headers })} />
      <label className="field">
        Request body
        <span className="select-wrap">
          <select
            value={settings.body}
            disabled={settings.method === 'GET'}
            onChange={(e) => patch({ body: e.target.value as HttpSetting['body'] })}
          >
            <option value="none">No body</option>
            <option value="input">Previous step output (JSON)</option>
            <option value="custom">Custom body</option>
          </select>
          <ChevronDown size={14} />
        </span>
        {settings.method === 'GET' && <small>GET requests use an empty body.</small>}
      </label>
      {settings.body === 'custom' && (
        <ConnectorText
          label="Custom body"
          value={settings.customBody}
          markInvalid={markInvalid}
          update={(customBody) => patch({ customBody })}
        />
      )}
    </>
  );
}
