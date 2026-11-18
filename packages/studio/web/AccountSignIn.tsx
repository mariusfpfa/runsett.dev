import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Check, Copy, LoaderCircle, LogIn, RefreshCw, Settings2 } from 'lucide-react';
import type { ConnectionSummary, WebhookKind } from '../src/connector-settings.js';
import { slackRegistrationUrl } from '../src/oauth-apps.js';
import { IconButton, Modal, Tile } from './ui.js';
import { api, message } from './workspace.js';

type Config = { clientId: string; redirectUri: string };
type Flow = { id: string; url?: string; popupBlocked?: boolean };
type FlowStatus = {
  status: 'pending' | 'complete' | 'error';
  connection?: ConnectionSummary;
  error?: string;
};
const providerName = { slack: 'Slack', teams: 'Microsoft' };

function restoreFlow(key: string, accountId: string): Flow | null {
  try {
    const stored = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    return stored?.accountId === accountId && typeof stored.flowId === 'string'
      ? { id: stored.flowId }
      : null;
  } catch {
    return null;
  }
}
function rememberFlow(key: string, flowId?: string, accountId?: string) {
  try {
    if (flowId) sessionStorage.setItem(key, JSON.stringify({ flowId, accountId }));
    else sessionStorage.removeItem(key);
  } catch {
    /* Sign-in also works when tab storage is unavailable. */
  }
}
function openSignInWindow(provider: string) {
  let popup: Window | null = null;
  try {
    popup = window.open('about:blank', '_blank', 'popup,width=620,height=740');
    if (popup) {
      popup.opener = null;
      popup.document.title = provider + ' sign-in';
      if (popup.document.body) popup.document.body.textContent = 'Opening ' + provider + '…';
    }
    return popup;
  } catch {
    popup?.close();
    return null;
  }
}

function AppSetup({ kind, redirectUri }: { kind: WebhookKind; redirectUri: string }) {
  const [copied, setCopied] = useState(false);
  const redirectField = useRef<HTMLInputElement>(null);
  const slack = kind === 'slack';
  return (
    <>
      <div className="connection-intro">
        <Tile kind={kind} small />
        <p>Set up sign-in once for this Studio workspace.</p>
      </div>
      <ol className="oauth-setup-steps">
        <li>
          {slack ? (
            <>
              <a href={slackRegistrationUrl(redirectUri)} target="_blank" rel="noopener noreferrer">
                Create a Slack app for Runsett <ArrowUpRight size={11} />
              </a>{' '}
              and choose your workspace. The redirect URL and channel permissions are prefilled.
            </>
          ) : (
            <>
              Register an app in{' '}
              <a
                href="https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade"
                target="_blank"
                rel="noopener noreferrer"
              >
                Microsoft Entra <ArrowUpRight size={11} />
              </a>{' '}
              and select <strong>Accounts in any organizational directory</strong> for work or school
              accounts. Under <strong>Authentication</strong>, add the{' '}
              <strong>Mobile and desktop applications</strong> platform.
            </>
          )}
        </li>
        <li>
          {slack ? (
            <>
              Paste the <strong>Client ID</strong> from the app’s <strong>Basic Information</strong> below.
            </>
          ) : (
            <>Add the localhost redirect URI below as a custom redirect URI.</>
          )}
        </li>
        {!slack && (
          <li>
            Under <strong>API permissions</strong>, add Microsoft Graph delegated permissions{' '}
            <code>User.Read</code>, <code>Team.ReadBasic.All</code>, <code>Channel.ReadBasic.All</code> and{' '}
            <code>ChannelMessage.Send</code>. Copy the Application (client) ID from Overview.
          </li>
        )}
      </ol>
      <div className="field">
        <label htmlFor="oauth-redirect-uri">Redirect URI</label>
        <div className="copy-field">
          <input
            ref={redirectField}
            id="oauth-redirect-uri"
            className="mono"
            readOnly
            value={redirectUri}
            onFocus={(e) => e.target.select()}
          />
          <IconButton
            label="Copy redirect URI"
            onClick={() => {
              redirectField.current?.select();
              if (navigator.clipboard)
                void navigator.clipboard
                  .writeText(redirectUri)
                  .then(() => setCopied(true))
                  .catch(() => redirectField.current?.focus());
              else redirectField.current?.focus();
            }}
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </IconButton>
        </div>
      </div>
    </>
  );
}

export function AccountSignIn({
  kind,
  storageKey,
  accountId,
  connected,
}: {
  kind: WebhookKind;
  storageKey: string;
  accountId: string;
  connected(connection: ConnectionSummary): void;
}) {
  const provider = providerName[kind];
  const base = 'oauth/' + kind;
  const key = storageKey + '.' + kind;
  const [config, setConfig] = useState<Config | null>(null);
  const [configError, setConfigError] = useState('');
  const [configVersion, setConfigVersion] = useState(0);
  const [flow, setFlow] = useState<Flow | null>(() => restoreFlow(key, accountId));
  const [dialog, setDialog] = useState<'setup' | 'progress' | null>(() => (flow ? 'progress' : null));
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [checkAgain, setCheckAgain] = useState(0);
  const [terminal, setTerminal] = useState(false);
  const [notice, setNotice] = useState('');
  const popup = useRef<Window | null>(null);
  const submitting = useRef<AbortController | null>(null);
  const checking = useRef<AbortController | null>(null);
  const onConnected = useRef(connected);
  onConnected.current = connected;
  const clientId = (draft ?? config?.clientId ?? '').trim();
  useEffect(() => setNotice(''), [accountId]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    const controller = new AbortController();
    setConfigError('');
    api<Config>(base + '/config', 'GET', undefined, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setConfig(data);
      })
      .catch((err) => {
        if (!controller.signal.aborted) setConfigError(message(err));
      });
    return () => controller.abort();
  }, [base, configVersion]);
  useEffect(
    () => () => {
      submitting.current?.abort();
      checking.current?.abort();
      popup.current?.close();
    },
    [],
  );
  useEffect(() => {
    if (!flow) return;
    const controller = new AbortController();
    checking.current = controller;
    let timer = 0;
    const poll = async () => {
      try {
        const result = await api<FlowStatus>(
          base + '/flows/' + encodeURIComponent(flow.id),
          'GET',
          undefined,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        if (result.status === 'pending') {
          timer = window.setTimeout(poll, 1500);
        } else if (
          result.status === 'complete' &&
          result.connection?.kind === kind &&
          result.connection.auth === 'oauth'
        ) {
          rememberFlow(key);
          popup.current?.close();
          popup.current = null;
          setFlow(null);
          setDialog(null);
          setNotice('Signed in as ' + result.connection.name + '.');
          onConnected.current(result.connection);
        } else {
          rememberFlow(key);
          popup.current?.close();
          popup.current = null;
          setTerminal(true);
          setProblem(result.error || 'Sign-in did not complete. Start again to connect an account.');
        }
      } catch (err) {
        if (!controller.signal.aborted) setProblem(message(err));
      }
    };
    void poll();
    return () => {
      window.clearTimeout(timer);
      controller.abort();
      if (checking.current === controller) checking.current = null;
    };
  }, [base, key, kind, flow, checkAgain]);

  function close() {
    submitting.current?.abort();
    submitting.current = null;
    checking.current?.abort();
    popup.current?.close();
    popup.current = null;
    rememberFlow(key);
    setFlow(null);
    setDialog(null);
    setBusy(false);
    setProblem('');
    setTerminal(false);
    setDraft(null);
  }
  function setup() {
    close();
    setNotice('');
    setDialog('setup');
  }
  async function submit(signIn: boolean, saveClient: boolean) {
    if (submitting.current || !config || (saveClient && !clientId)) return;
    checking.current?.abort();
    popup.current?.close();
    popup.current = signIn ? openSignInWindow(provider) : null;
    const controller = new AbortController();
    submitting.current = controller;
    setBusy(true);
    setProblem('');
    setTerminal(false);
    setNotice('');
    setFlow(null);
    rememberFlow(key);
    if (signIn) setDialog('progress');
    let saving = saveClient;
    try {
      if (saveClient) {
        const updated = await api<Config>(base + '/config', 'PUT', { clientId }, controller.signal);
        if (controller.signal.aborted) return;
        setConfig(updated);
        setDraft(null);
        saving = false;
      }
      if (!signIn) {
        setDialog(null);
        setNotice('App settings saved.');
        return;
      }
      const start = await api<{ flowId: string; authorizationUrl: string }>(
        base + '/start',
        'POST',
        {},
        controller.signal,
      );
      if (controller.signal.aborted) return;
      const url = new URL(start.authorizationUrl);
      if (url.protocol !== 'https:' || url.username || url.password || !start.flowId)
        throw new Error('Studio could not open the provider sign-in page.');
      let blocked = !popup.current || popup.current.closed;
      if (popup.current && !blocked) {
        try {
          popup.current.location.replace(url.href);
        } catch {
          blocked = true;
        }
      }
      rememberFlow(key, start.flowId, accountId);
      setFlow({ id: start.flowId, url: url.href, popupBlocked: blocked });
    } catch (err) {
      if (controller.signal.aborted) return;
      popup.current?.close();
      popup.current = null;
      setProblem(message(err));
      setTerminal(true);
      if (saving) setDialog('setup');
    } finally {
      if (submitting.current === controller) {
        submitting.current = null;
        if (!controller.signal.aborted) setBusy(false);
      }
    }
  }

  return (
    <div className="account-sign-in">
      <div className="account-sign-in-actions">
        <button
          type="button"
          className={'btn ' + (accountId ? 'btn-light' : 'btn-primary')}
          disabled={!config && !configError}
          onClick={() => (config?.clientId ? void submit(true, false) : setup())}
        >
          <LogIn size={14} /> Sign in with {provider}
        </button>
        <IconButton label={provider + ' app settings'} onClick={setup}>
          <Settings2 size={16} />
        </IconButton>
      </div>
      {notice && (
        <p className="field-help" role="status">
          {notice}
        </p>
      )}
      {dialog === 'setup' && (
        <Modal title={provider + ' app settings'} close={close} className="oauth-dialog">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submit(true, true);
            }}
          >
            <div className="dialog-body">
              {config ? (
                <>
                  <AppSetup kind={kind} redirectUri={config.redirectUri} />
                  <label className="field">
                    Client ID
                    <input
                      required
                      autoComplete="off"
                      spellCheck={false}
                      autoCapitalize="none"
                      className="mono"
                      placeholder={kind === 'slack' ? '1234567890.1234567890123' : 'Application (client) ID'}
                      value={draft ?? config.clientId}
                      onChange={(event) => {
                        setDraft(event.target.value);
                        setProblem('');
                      }}
                    />
                  </label>
                </>
              ) : (
                !configError && (
                  <p className="body-note" role="status">
                    Loading app settings…
                  </p>
                )
              )}
              {configError && (
                <p role="alert" className="setting-error">
                  {configError}
                  <button
                    className="text-action"
                    type="button"
                    onClick={() => setConfigVersion((n) => n + 1)}
                  >
                    Retry settings
                  </button>
                </p>
              )}
              {problem && (
                <p className="setting-error" role="alert">
                  {problem}
                </p>
              )}
            </div>
            <div className="dialog-bottom oauth-footer">
              <button
                type="button"
                className="btn btn-light"
                disabled={!config || !clientId || busy}
                onClick={() => void submit(false, true)}
              >
                Save settings
              </button>
              <button type="submit" className="btn btn-primary" disabled={!config || !clientId || busy}>
                <LogIn size={14} /> Save and sign in
              </button>
            </div>
          </form>
        </Modal>
      )}
      {dialog === 'progress' && (
        <Modal title={'Sign in with ' + provider} close={close}>
          <div className="dialog-body oauth-progress">
            <Tile kind={kind} />
            {!terminal && (
              <p role="status">
                {busy
                  ? 'Opening sign-in…'
                  : flow?.popupBlocked
                    ? 'Open the sign-in page to connect your account.'
                    : 'Finish signing in with ' + provider + ', then return to Studio.'}
              </p>
            )}
            {flow?.url && !terminal && (
              <a className="btn btn-light" href={flow.url} target="_blank" rel="noopener noreferrer">
                Open sign-in page <ArrowUpRight size={14} />
              </a>
            )}
            {!terminal && !problem && (
              <small className="oauth-wait">
                <LoaderCircle size={13} className="spin" /> Waiting for {provider}
              </small>
            )}
            {problem && (
              <p className="setting-error" role="alert">
                {problem}
              </p>
            )}
            {!terminal && problem && flow && (
              <button
                className="text-action"
                type="button"
                onClick={() => {
                  setProblem('');
                  setCheckAgain((n) => n + 1);
                }}
              >
                <RefreshCw size={12} /> Check sign-in again
              </button>
            )}
          </div>
          <div className="dialog-bottom">
            <button type="button" className="btn btn-light" onClick={close}>
              Close
            </button>
            {terminal || (!busy && !flow?.url) ? (
              <button
                type="button"
                className="btn btn-primary"
                disabled={!config}
                onClick={() => void submit(true, false)}
              >
                Start sign-in again
              </button>
            ) : null}
          </div>
        </Modal>
      )}
    </div>
  );
}
