import { useEffect, useState } from 'react';
import {
  ArrowUpRight,
  Check,
  ChevronRight,
  Clock3,
  History,
  LoaderCircle,
  RefreshCw,
  Square,
  TriangleAlert,
} from 'lucide-react';
import { api, message } from './workspace.js';
import { ConsoleOutput, IconButton, Modal, Status } from './ui.js';
import type { DiagnosticRecord } from '@runsett/contracts';

type RunRow = {
  id: string;
  name: string;
  state: string;
  startedAt: string;
  finishedAt?: string;
  revision?: number;
};
type StepResult = {
  stepId: string;
  name: string;
  kind: string;
  state: string;
  input?: unknown;
  output?: unknown;
  diagnostics?: DiagnosticRecord[];
  error?: { code: string; message?: string };
};
type RunDetails = {
  id: string;
  runId: string;
  state: string;
  name: string;
  revision?: number;
  input?: unknown;
  output?: unknown;
  steps: StepResult[];
  partial: boolean;
  canCancel: boolean;
  error?: { code: string; message?: string };
};
const pretty = (value: unknown) =>
  typeof value === 'string' ? (value === '' ? '""' : value) : JSON.stringify(value, null, 2);
function duration(row: RunRow) {
  if (!row.finishedAt) return '—';
  const seconds = (Date.parse(row.finishedAt) - Date.parse(row.startedAt)) / 1000;
  return seconds < 60
    ? seconds.toFixed(1) + 's'
    : Math.floor(seconds / 60) + 'm ' + Math.round(seconds % 60) + 's';
}
export function RunHistory({ workflow, open }: { workflow?: string | undefined; open(id: string): void }) {
  const [rows, setRows] = useState<RunRow[] | null>(null);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let live = true,
      timer = 0;
    setRows(null);
    async function load() {
      try {
        const list = await api<RunRow[]>('runs' + (workflow ? '?workflow=' + workflow : ''));
        if (live) {
          setRows(list);
          setError('');
        }
      } catch (e) {
        if (live) setError(message(e));
      }
      if (live) timer = window.setTimeout(load, 5000);
    }
    void load();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [workflow, refresh]);
  return (
    <section className="history-view">
      <div className="history-head">
        <div>
          <h2>{workflow ? 'Workflow runs' : 'Recent runs'}</h2>
          <p>The latest 50 executions{workflow ? ' of this workflow.' : ' in this workspace.'}</p>
        </div>
        <button className="btn btn-light" onClick={() => setRefresh((x) => x + 1)}>
          <RefreshCw size={14} />
          Refresh
        </button>
      </div>
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
      {rows?.length ? (
        <div className="history-table">
          <table>
            <thead>
              <tr>
                <th>Workflow</th>
                <th>Status</th>
                <th>Started</th>
                <th>Duration</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} onClick={() => open(row.id)}>
                  <td>
                    <button
                      className="row-title"
                      onClick={(e) => {
                        e.stopPropagation();
                        open(row.id);
                      }}
                    >
                      {row.name}
                    </button>
                    <small>
                      {row.revision ? 'Revision ' + row.revision + ' · ' : ''}
                      {row.id.slice(-8)}
                    </small>
                  </td>
                  <td>
                    <Status state={row.state} />
                  </td>
                  <td>
                    {new Date(row.startedAt).toLocaleString(undefined, {
                      month: 'short',
                      day: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit',
                    })}
                  </td>
                  <td className="mono">{duration(row)}</td>
                  <td>
                    <ChevronRight size={15} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        !error && (
          <div className="history-empty">
            {rows ? <History /> : <LoaderCircle className="spin" />}
            <strong>{rows ? 'No runs yet' : 'Loading runs…'}</strong>
            {rows && <p>Run the workflow to see its steps and output here.</p>}
          </div>
        )
      )}
    </section>
  );
}
export function ResultDialog({ id, namespace, close }: { id: string; namespace: string; close(): void }) {
  const [run, setRun] = useState<RunDetails | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [cancelling, setCancelling] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  useEffect(() => {
    let live = true,
      timer = 0;
    async function load() {
      try {
        const value = await api<RunDetails>('runs/' + encodeURIComponent(id) + (showLogs ? '?logs=1' : ''));
        if (!live) return;
        setRun(value);
        setError('');
        if (value.state === 'RUNNING') timer = window.setTimeout(load, 850);
      } catch (e) {
        if (live) setError(message(e));
      }
    }
    void load();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [id, attempt, showLogs]);
  return (
    <Modal title="Run details" close={close} wide>
      <div className="dialog-body result-body">
        {error && (
          <div className="inline-error" role="alert">
            {error}
            <IconButton label="Retry inspection" onClick={() => setAttempt((x) => x + 1)}>
              <RefreshCw size={15} />
            </IconButton>
          </div>
        )}
        {!run && !error && (
          <p className="loading">
            <LoaderCircle size={17} className="spin" />
            Reading execution…
          </p>
        )}
        {run && (
          <>
            <div className="result-heading">
              <div>
                <h3>{run.name}</h3>
                <small>
                  {run.revision ? 'Revision ' + run.revision + ' · ' : ''}Run {run.runId.slice(-8)}
                </small>
              </div>
              <Status state={run.state} />
            </div>
            {run.error && (
              <div className="inline-error">
                <TriangleAlert size={16} />
                {run.error.message ?? run.error.code}
              </div>
            )}
            {run.partial && (
              <p className="body-note">Some execution details are unavailable in the recorded history.</p>
            )}
            {Object.hasOwn(run, 'output') && (
              <section className="result-output">
                <h4>
                  <Check size={15} />
                  Workflow output
                </h4>
                <pre>{pretty(run.output)}</pre>
              </section>
            )}
            <h4>Steps</h4>
            <div className="step-results">
              {run.steps.map((step) => (
                <details key={step.stepId}>
                  <summary>
                    <ChevronRight size={14} />
                    <strong>{step.name}</strong>
                    <Status state={step.state} />
                  </summary>
                  <div>
                    {step.error && <p className="error-text">{step.error.message ?? step.error.code}</p>}
                    {Object.hasOwn(step, 'output') ? (
                      <>
                        <small>Step output</small>
                        <pre>{pretty(step.output)}</pre>
                      </>
                    ) : (
                      <p className="body-note">
                        {step.kind === 'wait'
                          ? 'This timer passes its input through.'
                          : 'No output recorded for this step.'}
                      </p>
                    )}
                    {step.kind === 'javascript' &&
                      (showLogs ? (
                        <>
                          <small>Console</small>
                          {step.diagnostics ? (
                            <ConsoleOutput records={step.diagnostics} />
                          ) : (
                            <p className="body-note">No console output loaded.</p>
                          )}
                        </>
                      ) : (
                        <button className="btn btn-light" onClick={() => setShowLogs(true)}>
                          Show console
                        </button>
                      ))}
                  </div>
                </details>
              ))}
              {!run.steps.length && (
                <p className="body-note">
                  {run.state === 'RUNNING' ? 'Waiting for the worker…' : 'No action steps in this run.'}
                </p>
              )}
            </div>
            <details className="input-details">
              <summary>Run input</summary>
              <pre>{pretty(run.input)}</pre>
            </details>
          </>
        )}
      </div>
      <div className="dialog-bottom result-bottom">
        {run && (
          <a
            href={
              'http://localhost:8080/namespaces/' +
              encodeURIComponent(namespace) +
              '/workflows/' +
              encodeURIComponent(id) +
              '/' +
              encodeURIComponent(run.runId) +
              '/history'
            }
            target="_blank"
            rel="noreferrer"
          >
            Temporal history
            <ArrowUpRight size={13} />
          </a>
        )}
        {run?.state === 'RUNNING' && run.canCancel ? (
          <button
            className="btn btn-light"
            disabled={cancelling}
            onClick={async () => {
              setCancelling(true);
              try {
                await api('runs/' + encodeURIComponent(id) + '/cancel', 'POST', {});
                setAttempt((x) => x + 1);
              } catch (e) {
                setError(message(e));
                setCancelling(false);
              }
            }}
          >
            {cancelling ? <Clock3 size={14} /> : <Square size={13} />}{' '}
            {cancelling ? 'Cancelling…' : 'Cancel run'}
          </button>
        ) : (
          <button className="btn btn-light" onClick={close}>
            Close
          </button>
        )}
      </div>
    </Modal>
  );
}
