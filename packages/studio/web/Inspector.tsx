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
import { kindSettings, type VisualStep, type WorkflowDocument } from '../src/model.js';
import { isConnectorKind, parseConnectorSetting } from '../src/connector-settings.js';
import { HttpFields, MessagingFields, type ConnectionControls } from './ConnectorFields.js';
import { DataFields } from './DataFields.js';
import { enabledTriggers, OptionalTrigger, type TriggerControls } from './Triggers.js';
import {
  formatLabels,
  IconButton,
  isTriggerKind,
  Tile,
  kinds,
  settingObject,
  triggerKinds,
  type MarkInvalid,
  type NodeKind,
  type TriggerKind,
} from './ui.js';
import { message } from './workspace.js';

function StepFields({
  workflowId,
  step,
  connections,
  change,
  markInvalid,
}: {
  workflowId: string;
  step: VisualStep;
  connections: ConnectionControls;
  change(setting: string): void;
  markInvalid: MarkInvalid;
}) {
  const { kind, setting } = step;
  try {
    if (isConnectorKind(kind)) {
      if (kind === 'http')
        return (
          <HttpFields
            settings={parseConnectorSetting(kind, setting, true)}
            connections={connections}
            change={change}
            markInvalid={markInvalid}
          />
        );
      return (
        <MessagingFields
          signInKey={'runsett.signin.' + workflowId + '.' + step.id}
          kind={kind}
          settings={parseConnectorSetting(kind, setting, true)}
          connections={connections}
          change={change}
          markInvalid={markInvalid}
        />
      );
    }
    if (kind === 'set-field' || kind === 'filter-list' || kind === 'choose') {
      const settings = settingObject(setting);
      if (!settings) throw new Error('The settings for this step could not be read.');
      return <DataFields kind={kind} settings={settings} change={change} markInvalid={markInvalid} />;
    }
    return null;
  } catch (error) {
    return (
      <div className="setting-error" role="alert">
        {message(error)}
        <button className="text-action" onClick={() => change(kindSettings[kind].initial)}>
          Reset step settings
        </button>
      </div>
    );
  }
}

type Props = {
  workflowId: string;
  doc: WorkflowDocument;
  selection: string;
  triggerKind: TriggerKind;
  triggers: TriggerControls;
  connections: ConnectionControls;
  invalidDraft: boolean;
  markInvalid: MarkInvalid;
  configureTrigger(kind: TriggerKind): void;
  edit(doc: WorkflowDocument): void;
  select(id: string): void;
  move(id: string, index: number): void;
  remove(id: string): void;
  test(id: string): void;
  close(): void;
};
export function Inspector({
  workflowId,
  doc,
  selection,
  triggerKind,
  triggers,
  connections,
  invalidDraft,
  markInvalid,
  configureTrigger,
  edit,
  select,
  move,
  remove,
  test,
  close,
}: Props) {
  const index = doc.steps.findIndex((s) => s.id === selection),
    step = doc.steps[index];
  const kind: NodeKind = step?.kind ?? (selection === 'output' ? 'output' : triggerKind);
  const activeTriggers = enabledTriggers(triggers.data);
  const nodes = [
    {
      id: 'trigger',
      name: activeTriggers.length === 1 ? 'Manual trigger' : 'Workflow triggers',
      kind: 'trigger' as NodeKind,
    },
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
        {isTriggerKind(kind) && (
          <div className="trigger-tabs" role="group" aria-label="Workflow triggers">
            {triggerKinds.map((item) => (
              <button
                key={item}
                type="button"
                aria-pressed={item === kind}
                aria-label={'Configure ' + kinds[item].name}
                onClick={() => configureTrigger(item)}
              >
                <i className={activeTriggers.includes(item) ? 'enabled' : ''} />
                {item === 'trigger' ? 'Manual' : kinds[item].name}
              </button>
            ))}
          </div>
        )}
        <section className="inspector-section">
          <h3>Configuration</h3>
          {step && (
            <label className="field">
              Step name
              <input maxLength={100} value={step.name} onChange={(e) => change({ name: e.target.value })} />
            </label>
          )}
          {step && (
            <StepFields
              workflowId={workflowId}
              key={step.id}
              step={step}
              connections={connections}
              change={(setting) => change({ setting })}
              markInvalid={markInvalid}
            />
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
          {(kind === 'webhook' || kind === 'schedule') && (
            <OptionalTrigger
              key={kind}
              kind={kind}
              controls={triggers}
              doc={doc}
              editInput={() => configureTrigger('trigger')}
            />
          )}
          {kind === 'output' && (
            <p className="body-note">
              The final value appears in the run details. Select an earlier step to change how it is produced.
            </p>
          )}
          {step && step.kind !== 'javascript' && (
            <button className="btn btn-light" disabled={invalidDraft} onClick={() => test(step.id)}>
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
