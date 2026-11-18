import { useEffect, useRef, useState } from 'react';
import { Braces, Check, CircleAlert, FileCode2, LoaderCircle, Play, Square, Terminal } from 'lucide-react';
import type { JsonValue } from '@runsett/contracts';
import {
  assertTestInput,
  fixtureFromOutput,
  maxTestInputBytes,
  validateSource,
  type StepTestResult,
  type TestFixture,
  type VisualStep,
  type WorkflowDocument,
} from '../src/model.js';
import { JavaScriptEditor } from './JavaScriptEditor.js';
import { ConsoleOutput, kinds, Modal, subtitle } from './ui.js';
import { RecordedInputPicker, recordedOrigin, useRecordedInput } from './RecordedInput.js';
import { api, message, type Engine } from './workspace.js';

type Fixture = TestFixture & { origin?: string };
function initialFixture(key: string, doc: WorkflowDocument): Fixture {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (
      stored &&
      typeof stored === 'object' &&
      'mode' in stored &&
      'text' in stored &&
      (stored.mode === 'text' || stored.mode === 'json') &&
      typeof stored.text === 'string'
    )
      return {
        mode: stored.mode,
        text: stored.text,
        ...('origin' in stored && typeof stored.origin === 'string' ? { origin: stored.origin } : {}),
      };
  } catch {
    /* A fresh test uses the manual trigger's example. */
  }
  return { mode: doc.inputMode, text: doc.sampleInput };
}

type Props = {
  step: VisualStep | null;
  workflowId: string;
  document: WorkflowDocument;
  engine: Engine;
  saveState: string;
  saveError: string;
  edit(source: string): void;
  runWorkflow(input: JsonValue): Promise<void>;
  close(): void;
};
type LastTest = { source: string; fixture: Fixture; result: StepTestResult };

export function StepTestDialog({
  step,
  workflowId,
  document: doc,
  engine,
  saveState,
  saveError,
  edit,
  runWorkflow,
  close,
}: Props) {
  const targetId = step?.id ?? 'trigger';
  const isCode = step?.kind === 'javascript';
  const key = 'runsett.test-input.' + workflowId + '.' + targetId;
  const [fixture, setFixture] = useState(() => initialFixture(key, doc));
  const [last, setLast] = useState<LastTest | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const active = useRef<AbortController | null>(null);
  const loader = useRecordedInput(workflowId, (record) =>
    saveFixture(fixtureFromOutput(record.value), recordedOrigin(record)),
  );
  useEffect(
    () => () => {
      active.current?.abort();
    },
    [],
  );

  function saveFixture({ mode, text }: TestFixture, origin?: string) {
    const next: Fixture = { mode, text, ...(origin ? { origin } : {}) };
    setFixture(next);
    setError('');
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      /* Editing still works without storage. */
    }
  }
  function changeFixture(next: TestFixture) {
    loader.cancel();
    saveFixture(next);
  }
  async function test() {
    if (active.current || loader.loading || engine.status !== 'online') return;
    setError('');
    const source = step?.setting ?? '';
    let input: unknown = fixture.text;
    if (fixture.mode === 'json') {
      try {
        input = JSON.parse(fixture.text);
      } catch {
        setError('Enter valid JSON in the test input.');
        return;
      }
    }
    try {
      assertTestInput(input);
      if (isCode) validateSource(source);
    } catch (e) {
      setError(message(e));
      return;
    }
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setLast(null);
    try {
      if (!step) {
        await runWorkflow(input);
        return;
      }
      const result = await api<StepTestResult>(
        isCode ? 'javascript/test' : 'steps/test',
        'POST',
        isCode ? { source, input } : { kind: step.kind, setting: step.setting, input },
        controller.signal,
      );
      if (!controller.signal.aborted) setLast({ source, fixture, result });
    } catch (e) {
      if (!controller.signal.aborted) setError(message(e));
    } finally {
      if (active.current === controller) {
        active.current = null;
        if (!controller.signal.aborted) setBusy(false);
      }
    }
  }
  function stopTest() {
    active.current?.abort();
    setBusy(false);
    setError('Test stopped.');
  }
  const stale =
    last &&
    (last.source !== step?.setting ||
      last.fixture.mode !== fixture.mode ||
      last.fixture.text !== fixture.text);
  const result = last?.result;
  return (
    <Modal
      title={
        isCode ? 'JavaScript editor' : step ? 'Test ' + (step.name || kinds[step.kind].name) : 'Test workflow'
      }
      close={() => {
        if (step || !busy) close();
      }}
      className={isCode ? 'js-dialog' : 'step-test-dialog'}
    >
      <div
        onKeyDownCapture={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault();
            event.stopPropagation();
            void test();
          }
        }}
      >
        <div className={isCode ? 'js-workbench' : ''}>
          {isCode && step && (
            <section className="js-program">
              <div className="js-filebar">
                <span>
                  <FileCode2 size={16} />
                  step.mjs
                </span>
                <small>JavaScript</small>
              </div>
              <JavaScriptEditor source={step.setting} edit={edit} />
              <p className="js-contract">
                <code>input</code> is the previous step’s value. Return a JSON value to pass it to the next
                step.
              </p>
            </section>
          )}
          <section className="js-testbench" aria-label={step ? 'Step test' : 'Workflow test'}>
            {step && !isCode && (
              <p className="step-test-setting">
                {kinds[step.kind].name} · {subtitle(step)}
              </p>
            )}
            {!step && <p className="step-test-setting">This input applies to one new workflow run.</p>}
            <RecordedInputPicker
              workflowId={workflowId}
              steps={doc.steps}
              targetId={targetId}
              {...(!step ? { actionLabel: 'Load selected output' } : {})}
              online={engine.status === 'online'}
              disabled={busy}
              loader={loader}
            />
            <div className="js-section-title">
              <label htmlFor="js-fixture">Test input</label>
              <div className="js-modes" aria-label="Test input format">
                {(['text', 'json'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    aria-pressed={fixture.mode === mode}
                    onClick={() => changeFixture({ ...fixture, mode })}
                  >
                    {mode === 'text' ? 'Text' : 'JSON'}
                  </button>
                ))}
              </div>
            </div>
            <textarea
              id="js-fixture"
              className="js-fixture"
              spellCheck={false}
              rows={4}
              maxLength={maxTestInputBytes}
              placeholder={fixture.mode === 'json' ? '{ "name": "Alex" }' : 'Enter a sample value'}
              value={fixture.text}
              onChange={(e) => changeFixture({ ...fixture, text: e.target.value })}
            />
            <div className="js-test-action">
              {busy && step ? (
                <button className="btn btn-light" onClick={stopTest}>
                  <Square size={13} />
                  Stop test
                </button>
              ) : (
                <button
                  className="btn btn-primary"
                  onClick={() => void test()}
                  disabled={engine.status !== 'online' || loader.loading || busy}
                >
                  <Play size={14} />
                  {step ? 'Test step' : 'Run workflow with this input'}
                </button>
              )}
              {busy && (
                <span className="js-running" role="status">
                  <LoaderCircle size={13} className="spin" />
                  {step ? 'Running…' : 'Starting…'}
                </span>
              )}
            </div>
            {fixture.origin && (
              <p className="js-note js-input-origin" role="status">
                {fixture.origin}
              </p>
            )}
            {engine.status !== 'online' && (
              <div role="status" className="js-note">
                {engine.message}
              </div>
            )}
            {error && (
              <div className="js-problem" role="alert">
                {error}
              </div>
            )}
            {stale && (
              <p className="js-note" role="status">
                The code or input changed. Test again for a current result.
              </p>
            )}
            {step && (
              <section className="js-result" aria-label="Test result" aria-live="polite">
                <div className="js-section-title">
                  <h3>
                    <Braces size={15} />
                    Output
                  </h3>
                  {result && <small>{(result.durationMs / 1000).toFixed(2)} s</small>}
                </div>
                {result ? (
                  result.ok ? (
                    <>
                      <p className="js-test-pass">
                        <Check size={13} />
                        Test passed
                      </p>
                      <pre className="js-value">{JSON.stringify(result.output, null, 2)}</pre>
                    </>
                  ) : (
                    <div className="js-test-fail">
                      <strong>
                        <CircleAlert size={14} />
                        Test failed{result.error.line ? ' on line ' + result.error.line : ''}
                      </strong>
                      <pre>{result.error.message}</pre>
                    </div>
                  )
                ) : (
                  <p className="js-empty">
                    {busy ? 'Waiting for the runner…' : 'Run this step to see its return value.'}
                  </p>
                )}
              </section>
            )}
            {(isCode || !!result?.diagnostics.length) && (
              <section className="js-logs" aria-label="Test console">
                <div className="js-section-title">
                  <h3>
                    <Terminal size={15} />
                    Console
                  </h3>
                </div>
                {result ? (
                  <ConsoleOutput records={result.diagnostics} />
                ) : (
                  <p className="js-empty">
                    Messages from <code>context.log()</code> and <code>console</code> appear here.
                  </p>
                )}
              </section>
            )}
          </section>
        </div>
        <div className="dialog-bottom js-footer">
          {isCode && (
            <span className={saveError ? 'error-text' : ''} role="status">
              {saveError || (saveState === 'Saved' ? 'Code saved to workflow' : saveState)}
            </span>
          )}
          <button className="btn btn-light" disabled={!step && busy} onClick={close}>
            Done
          </button>
        </div>
      </div>
    </Modal>
  );
}
