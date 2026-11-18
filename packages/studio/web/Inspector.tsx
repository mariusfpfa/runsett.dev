import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Code2,
  CornerDownRight,
  Play,
  SlidersHorizontal,
  Trash2,
  X,
} from 'lucide-react';
import type { VisualStep, WorkflowDocument } from '../src/model.js';
import { formatLabels, IconButton, Tile, kinds, type NodeKind } from './ui.js';

type Props = {
  doc: WorkflowDocument;
  selection: string;
  edit(doc: WorkflowDocument): void;
  select(id: string): void;
  move(id: string, index: number): void;
  remove(id: string): void;
  test(id: string): void;
  close(): void;
};
export function Inspector({ doc, selection, edit, select, move, remove, test, close }: Props) {
  const index = doc.steps.findIndex((s) => s.id === selection),
    step = doc.steps[index];
  const kind: NodeKind = step?.kind ?? (selection === 'output' ? 'output' : 'trigger');
  const nodes = [
    { id: 'trigger', name: 'Manual trigger', kind: 'trigger' as NodeKind },
    ...doc.steps,
    { id: 'output', kind: 'output' as NodeKind, name: 'Return result' },
  ];
  const position = nodes.findIndex((item) => item.id === selection);
  const previous = nodes[position - 1],
    next = nodes[position + 1];
  function change(patch: Partial<VisualStep>) {
    edit({ ...doc, steps: doc.steps.map((item) => (item.id === selection ? { ...item, ...patch } : item)) });
  }
  return (
    <aside className="inspector" aria-label="Step inspector">
      <div className="inspector-bar">
        <span>
          <SlidersHorizontal size={16} />
          Inspector
        </span>
        <IconButton label="Close inspector" onClick={close}>
          <X size={15} />
        </IconButton>
      </div>
      <div className="inspector-scroll">
        <div className="inspector-summary">
          <Tile kind={kind} />
          <div>
            <small className={'category ink-' + kind}>
              {step ? 'Step ' + String(index + 1).padStart(2, '0') + ' / ' : ''}
              {kinds[kind].label}
            </small>
            <h2>{kinds[kind].name}</h2>
          </div>
        </div>
        <p className="inspector-hint">{kinds[kind].hint}</p>
        <section className="inspector-section">
          <h3>Configuration</h3>
          {step && (
            <label className="field">
              Step name
              <input maxLength={100} value={step.name} onChange={(e) => change({ name: e.target.value })} />
            </label>
          )}
          {kind === 'format' && step && (
            <label className="field">
              Text format
              <span className="select-wrap">
                <select value={step.setting} onChange={(e) => change({ setting: e.target.value })}>
                  {Object.entries(formatLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
                <ChevronDown size={14} />
              </span>
            </label>
          )}
          {kind === 'compose' && step && (
            <label className="field">
              Message
              <textarea
                rows={4}
                maxLength={2048}
                value={step.setting}
                onChange={(e) => change({ setting: e.target.value })}
              />
              <small>
                Use <code>{'{{value}}'}</code> to insert the previous step’s output.
              </small>
            </label>
          )}
          {kind === 'field' && step && (
            <label className="field">
              Field path
              <input
                className="mono"
                maxLength={2048}
                value={step.setting}
                onChange={(e) => change({ setting: e.target.value })}
              />
              <small>
                Use dots for nested fields, for example <code>contact.name</code>.
              </small>
            </label>
          )}
          {kind === 'javascript' && step && (
            <div className="field">
              Source file
              <div className="source-file">
                <Code2 size={16} />
                <code>step.mjs</code>
              </div>
              <button className="btn btn-light" onClick={() => test(step.id)}>
                Edit &amp; test code
              </button>
              <small>
                Your function receives the previous step’s output as <code>input</code>.
              </small>
            </div>
          )}
          {kind === 'wait' && step && (
            <label className="field">
              Duration in seconds
              <input
                type="number"
                min="1"
                max="86400"
                value={step.setting}
                onChange={(e) => change({ setting: e.target.value })}
              />
              <small>The next step receives the same value after the wait.</small>
            </label>
          )}
          {kind === 'trigger' && (
            <>
              <label className="field">
                Input type
                <span className="select-wrap">
                  <select
                    value={doc.inputMode}
                    onChange={(e) =>
                      edit({ ...doc, inputMode: e.target.value as WorkflowDocument['inputMode'] })
                    }
                  >
                    <option value="text">Text</option>
                    <option value="json">JSON</option>
                  </select>
                  <ChevronDown size={14} />
                </span>
              </label>
              <label className="field">
                Run input
                <textarea
                  className={doc.inputMode === 'json' ? 'mono' : ''}
                  rows={5}
                  maxLength={16384}
                  value={doc.sampleInput}
                  onChange={(e) => edit({ ...doc, sampleInput: e.target.value })}
                />
                <small>This value goes into the first step when you run the workflow.</small>
              </label>
            </>
          )}
          {kind === 'output' && (
            <p className="body-note">
              The final value appears in the run details. Select an earlier step to change how it is produced.
            </p>
          )}
          {step && step.kind !== 'javascript' && (
            <button className="btn btn-light" onClick={() => test(step.id)}>
              <Play size={14} />
              Test step
            </button>
          )}
          {kind === 'trigger' && (
            <button className="btn btn-light" onClick={() => test('trigger')}>
              <Play size={14} />
              Test workflow with input
            </button>
          )}
        </section>
        <section className="inspector-section">
          <h3>Connections</h3>
          <div className="connections">
            {previous && (
              <button onClick={() => select(previous.id)}>
                <Tile kind={previous.kind} small />
                <span>
                  <small>Input from</small>
                  <strong>{previous.name || 'Untitled step'}</strong>
                </span>
                <ChevronRight size={14} />
              </button>
            )}
            {previous && next && (
              <div className="connection-stem">
                <CornerDownRight size={13} />
              </div>
            )}
            {next && (
              <button onClick={() => select(next.id)}>
                <Tile kind={next.kind} small />
                <span>
                  <small>Output to</small>
                  <strong>{next.name || 'Untitled step'}</strong>
                </span>
                <ChevronRight size={14} />
              </button>
            )}
          </div>
        </section>
      </div>
      {step && (
        <div className="inspector-actions">
          <span>Step actions</span>
          <div>
            <IconButton label="Move step up" disabled={index === 0} onClick={() => move(step.id, index - 1)}>
              <ArrowUp size={15} />
            </IconButton>
            <IconButton
              label="Move step down"
              disabled={index === doc.steps.length - 1}
              onClick={() => move(step.id, index + 1)}
            >
              <ArrowDown size={15} />
            </IconButton>
            <IconButton label="Remove step" className="danger-icon" onClick={() => remove(step.id)}>
              <Trash2 size={15} />
            </IconButton>
          </div>
        </div>
      )}
    </aside>
  );
}
