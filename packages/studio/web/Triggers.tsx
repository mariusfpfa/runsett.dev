import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy, Pause, PencilLine, Play, RefreshCw } from 'lucide-react';
import type { WorkflowDocument } from '../src/model.js';
import type { TriggerSettings } from '../src/triggers.js';
import { IconButton, type TriggerKind } from './ui.js';
import { api, message } from './workspace.js';

type TriggerPatch =
  | { webhook: { enabled: boolean } }
  | { schedule: { enabled: boolean; intervalMinutes: number } };
type TriggerState = { id: string; data: TriggerSettings | null; busy: boolean; error: string };

export function useWorkflowTriggers(id: string | undefined, flushDraft: () => Promise<unknown>) {
  const [state, setState] = useState<TriggerState>({ id: '', data: null, busy: false, error: '' });
  const active = useRef<AbortController | null>(null);
  const request = useCallback(
    async (workflow: string, patch?: TriggerPatch, beforeSave?: () => Promise<unknown>) => {
      if (!patch && active.current && !active.current.signal.aborted) return false;
      active.current?.abort();
      const controller = new AbortController();
      active.current = controller;
      setState((previous) => ({
        id: workflow,
        data: previous.id === workflow ? previous.data : null,
        busy: true,
        error: '',
      }));
      try {
        if (beforeSave) {
          await beforeSave();
          if (controller.signal.aborted) return false;
        }
        const data = await api<TriggerSettings>(
          'workflows/' + workflow + '/triggers',
          patch ? 'PUT' : 'GET',
          patch,
          controller.signal,
        );
        if (controller.signal.aborted) return false;
        setState({ id: workflow, data, busy: false, error: '' });
        return true;
      } catch (err) {
        if (!controller.signal.aborted)
          setState((previous) => ({ ...previous, error: message(err), busy: false }));
        return false;
      } finally {
        if (active.current === controller) active.current = null;
      }
    },
    [],
  );
  useEffect(() => {
    if (id) void request(id);
    return () => {
      active.current?.abort();
      active.current = null;
    };
  }, [id, request]);
  const data = state.id === id ? state.data : null;
  const nextAt = data?.schedule.enabled ? data.schedule.nextAt : undefined;
  useEffect(() => {
    if (!id || !nextAt || state.busy || state.error) return;
    const delay = Date.parse(nextAt) - Date.now() + 1500;
    // A delayed engine tick may briefly return the previous scheduled time.
    const timer = window.setTimeout(() => void request(id), Math.max(5_000, Math.min(delay, 2_000_000_000)));
    return () => window.clearTimeout(timer);
  }, [id, nextAt, state.busy, state.error, request]);
  return {
    data,
    busy: state.id !== id || state.busy,
    error: state.id === id ? state.error : '',
    reload: () => {
      if (id) void request(id);
    },
    save: (patch: TriggerPatch) => {
      const enabled = 'schedule' in patch ? patch.schedule.enabled : patch.webhook.enabled;
      return id ? request(id, patch, enabled ? flushDraft : undefined) : Promise.resolve(false);
    },
  };
}
export type TriggerControls = ReturnType<typeof useWorkflowTriggers>;

export function enabledTriggers(data: TriggerSettings | null): TriggerKind[] {
  const active: TriggerKind[] = ['trigger'];
  if (data?.webhook.enabled) active.push('webhook');
  if (data?.schedule.enabled) active.push('schedule');
  return active;
}
export function intervalLabel(minutes: number) {
  return minutes === 1 ? 'Every minute' : 'Every ' + minutes.toLocaleString() + ' minutes';
}

export function OptionalTrigger({
  kind,
  controls,
  doc,
  editInput,
}: {
  kind: 'schedule' | 'webhook';
  controls: TriggerControls;
  doc: WorkflowDocument;
  editInput(): void;
}) {
  const { data, busy, error } = controls;
  const [interval, setInterval] = useState<string | null>(null);
  const [copied, setCopied] = useState('');
  const urlInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(''), 3200);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const enabled = data?.[kind].enabled;
  const minutes = interval ?? String(data?.schedule.intervalMinutes ?? 15);
  const validInterval = /^\d+$/.test(minutes) && Number(minutes) >= 1 && Number(minutes) <= 525600;
  const path = data?.webhook.enabled ? data.webhook.path : null;
  const url = path && path.startsWith('/') && !path.startsWith('//') ? window.location.origin + path : '';
  async function copyUrl() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied('URL copied');
    } catch {
      urlInput.current?.focus();
      urlInput.current?.select();
      let success = false;
      try {
        success = document.execCommand?.('copy') ?? false;
      } catch {
        // The selected URL is ready for a keyboard copy.
      }
      setCopied(success ? 'URL copied' : 'URL selected. Use your copy shortcut.');
    }
  }
  return (
    <div className="trigger-settings" aria-busy={busy}>
      {error && (
        <div className="setting-error" role="alert">
          {error}
          <button className="text-action" type="button" onClick={controls.reload}>
            <RefreshCw size={12} /> Retry
          </button>
        </div>
      )}
      {!data && !error && (
        <p className="body-note" role="status">
          Loading trigger settings…
        </p>
      )}
      {data && (
        <>
          <div className="trigger-state">
            <span>Status</span>
            <strong className={'availability' + (enabled ? ' on' : '')}>
              <i />
              {enabled ? 'Enabled' : 'Off'}
            </strong>
          </div>
          {kind === 'webhook' ? (
            <>
              <p className="field-help">
                Send a POST request with Content-Type application/json to this Studio server. Its body becomes
                the workflow input.
              </p>
              {url && (
                <div className="field">
                  <label htmlFor="webhook-url">Private webhook URL</label>
                  <div className="copy-field">
                    <input
                      id="webhook-url"
                      ref={urlInput}
                      className="mono"
                      value={url}
                      readOnly
                      onFocus={(e) => e.target.select()}
                    />
                    <IconButton label="Copy webhook URL" onClick={() => void copyUrl()}>
                      {copied === 'URL copied' ? <Check size={15} /> : <Copy size={15} />}
                    </IconButton>
                  </div>
                  <small role="status">{copied || 'Disabling this webhook revokes its URL.'}</small>
                </div>
              )}
              <button
                className={'btn ' + (enabled ? 'btn-light' : 'btn-primary')}
                disabled={busy}
                onClick={() => void controls.save({ webhook: { enabled: !enabled } })}
              >
                {enabled ? <Pause size={14} /> : <Play size={14} />}
                {enabled ? 'Disable webhook' : 'Enable webhook'}
              </button>
            </>
          ) : (
            <>
              <form
                onSubmit={async (event) => {
                  event.preventDefault();
                  if (
                    validInterval &&
                    (await controls.save({ schedule: { enabled: true, intervalMinutes: Number(minutes) } }))
                  )
                    setInterval(null);
                }}
              >
                <label className="field">
                  Interval in minutes
                  <input
                    type="number"
                    min={1}
                    max={525600}
                    step={1}
                    required
                    aria-invalid={!validInterval}
                    value={minutes}
                    onChange={(e) => setInterval(e.target.value)}
                  />
                  {validInterval ? (
                    <small>Scheduled runs need the local Studio server to be running.</small>
                  ) : (
                    <small className="field-error">Use a whole number from 1 to 525,600.</small>
                  )}
                </label>
                <div className="trigger-buttons">
                  {(!enabled || Number(minutes) !== data.schedule.intervalMinutes) && (
                    <button type="submit" className="btn btn-primary" disabled={busy || !validInterval}>
                      {enabled ? <Check size={14} /> : <Play size={14} />}
                      {enabled ? 'Save interval' : 'Enable schedule'}
                    </button>
                  )}
                  {enabled && (
                    <button
                      type="button"
                      className="btn btn-light"
                      disabled={busy}
                      onClick={async () => {
                        if (
                          await controls.save({
                            schedule: { enabled: false, intervalMinutes: data.schedule.intervalMinutes },
                          })
                        )
                          setInterval(null);
                      }}
                    >
                      <Pause size={14} /> Pause schedule
                    </button>
                  )}
                </div>
              </form>
              {enabled && data.schedule.nextAt && (
                <div className="schedule-next">
                  <span>Next run</span>
                  <time dateTime={data.schedule.nextAt}>
                    {new Date(data.schedule.nextAt).toLocaleString(undefined, {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    })}
                  </time>
                </div>
              )}
              {data.schedule.lastError && (
                <div className="setting-error" role="status">
                  <strong>Last scheduled run</strong>
                  {data.schedule.lastError}
                </div>
              )}
              <div className="schedule-input">
                <div>
                  <strong>Run input</strong>
                  <button type="button" className="text-action" onClick={editInput}>
                    <PencilLine size={12} /> Edit input
                  </button>
                </div>
                <pre>{doc.sampleInput || (doc.inputMode === 'text' ? '""' : 'Empty JSON input')}</pre>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
