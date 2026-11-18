import { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ChevronDown, LoaderCircle, RefreshCw } from 'lucide-react';
import {
  previousSourceId,
  type RecordedRunOption,
  type RecordedStepOutput,
  type VisualStep,
} from '../src/model.js';
import { api, message } from './workspace.js';

type SourceStep = Pick<VisualStep, 'id' | 'name'>;
const output = { id: 'output', name: 'Return result' };

export function recordedOrigin(record: RecordedStepOutput) {
  return `From ${record.stepName} · Revision ${record.revision} · Run ${record.runId.slice(-8)}`;
}

export function useRecordedInput(workflowId: string, apply: (record: RecordedStepOutput) => void) {
  const request = useRef<AbortController | null>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState('');
  useEffect(
    () => () => {
      request.current?.abort();
    },
    [workflowId],
  );

  function cancel() {
    request.current?.abort();
    request.current = null;
    setLoading(false);
    setNotice('');
  }
  async function load(source: SourceStep, run?: RecordedRunOption) {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setNotice('');
    try {
      const path = 'workflows/' + workflowId + '/steps/' + encodeURIComponent(source.id) + '/';
      const endpoint = run
        ? 'output?' + new URLSearchParams({ executionId: run.id, runId: run.runId })
        : 'last-output';
      const record = await api<RecordedStepOutput | null>(
        path + endpoint,
        'GET',
        undefined,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      if (record) apply(record);
      else
        setNotice(
          run
            ? `“${source.name}” has no recorded output in this run. Choose another step or run.`
            : `No output from “${source.name}” in recent runs. Run the workflow through that step, then try again.`,
        );
    } catch (error) {
      if (!controller.signal.aborted) setNotice(message(error));
    } finally {
      if (request.current === controller) {
        request.current = null;
        if (!controller.signal.aborted) setLoading(false);
      }
    }
  }
  return { loading, notice, cancel, load };
}

const runDate = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
function runLabel(run: RecordedRunOption) {
  const state = run.state.toLowerCase().replaceAll('_', ' ');
  return `${runDate.format(new Date(run.startedAt))} · ${run.triggerName ?? 'Manual trigger'} · ${state} · r${run.revision} · ${run.runId.slice(-8)}`;
}

type PickerProps = {
  workflowId: string;
  steps: SourceStep[];
  targetId: string;
  online: boolean;
  disabled?: boolean;
  loader: ReturnType<typeof useRecordedInput>;
  actionLabel?: string;
};
export function RecordedInputPicker({
  workflowId,
  steps,
  targetId,
  online,
  disabled,
  loader,
  actionLabel,
}: PickerProps) {
  const [runs, setRuns] = useState<RecordedRunOption[] | null>(null);
  const [runId, setRunId] = useState('');
  const [stepId, setStepId] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [listing, setListing] = useState(false);
  const [listError, setListError] = useState('');
  useEffect(() => {
    if (!online) return;
    const controller = new AbortController();
    setListing(true);
    setListError('');
    api<RecordedRunOption[]>('workflows/' + workflowId + '/run-options', 'GET', undefined, controller.signal)
      .then((options) => {
        if (!controller.signal.aborted)
          setRuns(options.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)));
      })
      .catch((e) => {
        if (!controller.signal.aborted) setListError(message(e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setListing(false);
      });
    return () => controller.abort();
  }, [workflowId, online, refresh]);

  const run = runs?.find((entry) => entry.runId === runId);
  const historicSteps = run ? run.steps : steps;
  const previousId = previousSourceId(historicSteps, targetId, steps);
  const trigger = { id: 'trigger', name: run ? (run.triggerName ?? 'Manual trigger') : 'Trigger input' };
  const sources = [trigger, ...historicSteps, output];
  const source = sources.find((entry) => entry.id === (stepId || previousId));
  const unavailable = !!runId && !run;
  const action =
    actionLabel ??
    (!runId && source?.id === previousId ? 'Use previous step output' : 'Load selected output');
  return (
    <div className="recorded-input" role="group" aria-label="Load recorded input">
      <div className="recorded-select-row">
        <label className="field">
          <span>Source run</span>
          <span className="select-wrap">
            <select
              value={runId}
              disabled={!online || disabled}
              onChange={(event) => {
                loader.cancel();
                setRunId(event.target.value);
              }}
            >
              <option value="">Latest available</option>
              {unavailable && (
                <option value={runId} disabled>
                  Run no longer listed
                </option>
              )}
              {runs?.map((item) => (
                <option key={item.runId} value={item.runId}>
                  {runLabel(item)}
                </option>
              ))}
            </select>
            <ChevronDown size={13} />
          </span>
        </label>
        <button
          type="button"
          className="icon-btn"
          aria-label="Refresh source runs"
          title="Refresh source runs"
          disabled={listing || !online || disabled}
          onClick={() => setRefresh((n) => n + 1)}
        >
          {listing ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}
        </button>
      </div>
      <label className="field">
        <span>Source step</span>
        <span className="select-wrap">
          <select
            value={unavailable ? '' : (source?.id ?? '')}
            disabled={unavailable || !online || disabled}
            onChange={(event) => {
              loader.cancel();
              setStepId(event.target.value);
            }}
          >
            {(!source || unavailable) && (
              <option value="" disabled>
                Choose a recorded step
              </option>
            )}
            {sources.map((item, index) => (
              <option key={item.id} value={item.id}>
                {index > 0 && index <= historicSteps.length ? index + '. ' : ''}
                {item.name || 'Untitled step'}
                {item.id === previousId && targetId !== 'trigger' ? ' (previous step)' : ''}
              </option>
            ))}
          </select>
          <ChevronDown size={13} />
        </span>
      </label>
      <button
        type="button"
        className="btn btn-light js-load-output"
        disabled={!source || unavailable || !online || disabled || loader.loading}
        onClick={() => {
          if (source && !unavailable) void loader.load(source, run);
        }}
      >
        {loader.loading ? <LoaderCircle size={14} className="spin" /> : <ArrowDownToLine size={14} />}
        {loader.loading ? 'Loading output…' : action}
      </button>
      {listError && (
        <p className="js-note" role="alert">
          {listError} Use Refresh source runs to try again.
        </p>
      )}
      {online && !listing && !listError && runs?.length === 0 && !loader.notice && (
        <p className="js-note">Run this workflow once to make recorded outputs available here.</p>
      )}
      {loader.notice && (
        <p className="js-note" role="status">
          {loader.notice}
        </p>
      )}
    </div>
  );
}
