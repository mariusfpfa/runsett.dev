import { useEffect, useRef, useState } from 'react';
import { ArrowDown, Check, CircleDot, Focus, GitBranch, GripVertical, Minus, Plus } from 'lucide-react';
import { maxSteps, type VisualStep, type WorkflowDocument } from '../src/model.js';
import type { ConnectionSummary } from '../src/connector-settings.js';
import type { TriggerSettings } from '../src/triggers.js';
import { enabledTriggers, intervalLabel } from './Triggers.js';
import { IconButton, Tile, kinds, subtitle, type NodeKind, type TriggerKind } from './ui.js';

type Props = {
  doc: WorkflowDocument;
  selection: string;
  triggerKind: TriggerKind;
  triggers: TriggerSettings | null;
  connections: ConnectionSummary[];
  onTrigger(kind: TriggerKind): void;
  onSelect(id: string): void;
  onInsert(index: number): void;
  onMove(stepId: string, index: number): void;
};
export function Canvas({
  doc,
  selection,
  triggerKind,
  triggers,
  connections,
  onTrigger,
  onSelect,
  onInsert,
  onMove,
}: Props) {
  const [zoom, setZoom] = useState(1);
  const [dragging, setDragging] = useState('');
  const [over, setOver] = useState('');
  const stage = useRef<HTMLDivElement>(null);
  const flow = useRef<HTMLDivElement>(null);
  const starts = enabledTriggers(triggers);
  useEffect(() => {
    const node = flow.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]');
    if (node && stage.current) {
      const card = node.getBoundingClientRect(),
        viewport = stage.current.getBoundingClientRect();
      if (card.bottom > viewport.bottom - 56)
        stage.current.scrollBy({ top: card.bottom - viewport.bottom + 68, behavior: 'smooth' });
      else if (card.top < viewport.top + 12)
        stage.current.scrollBy({ top: card.top - viewport.top - 20, behavior: 'smooth' });
    }
  }, [selection, doc.steps.length]);
  function fit() {
    if (!stage.current || !flow.current) return;
    setZoom(
      Math.max(
        0.4,
        Math.min(
          1,
          (stage.current.clientHeight - 105) / flow.current.offsetHeight,
          (stage.current.clientWidth - 36) / flow.current.offsetWidth,
        ),
      ),
    );
    stage.current.scrollTo({ top: 0, left: 0 });
  }
  function link(index: number) {
    return (
      <div
        className={'flow-link' + (dragging ? ' drag-active' : '')}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          if (dragging) {
            const from = doc.steps.findIndex((s) => s.id === dragging);
            onMove(dragging, from < index ? index - 1 : index);
          }
          setDragging('');
          setOver('');
        }}
      >
        <button
          title="Insert a step here"
          aria-label={'Insert step at position ' + (index + 1)}
          disabled={doc.steps.length >= maxSteps}
          onClick={() => onInsert(index)}
        >
          <Plus size={11} />
        </button>
      </div>
    );
  }
  function card(
    id: string,
    kind: NodeKind,
    title: string,
    detail: string,
    step?: VisualStep,
    number?: number,
  ) {
    const selected = selection === id;
    return (
      <button
        type="button"
        className={[
          'flow-card',
          'node-' + kind,
          selected ? 'selected' : '',
          over === id ? 'drop-target' : '',
        ].join(' ')}
        aria-label={title + ', ' + kinds[kind].label}
        aria-pressed={selected}
        onClick={() => (id === 'trigger' ? onTrigger('trigger') : onSelect(id))}
        draggable={!!step}
        onDragStart={(e) => {
          if (step) {
            e.dataTransfer.setData('text/plain', id);
            e.dataTransfer.effectAllowed = 'move';
            setDragging(id);
          }
        }}
        onDragOver={(e) => {
          if (step && dragging && dragging !== id) {
            e.preventDefault();
            setOver(id);
          }
        }}
        onDrop={(e) => {
          if (step && dragging) {
            e.preventDefault();
            onMove(
              dragging,
              doc.steps.findIndex((s) => s.id === id),
            );
          }
          setDragging('');
          setOver('');
        }}
        onDragEnd={() => {
          setDragging('');
          setOver('');
        }}
      >
        <Tile kind={kind} />
        <span className="node-copy">
          <span className="node-category">{kinds[kind].label}</span>
          <strong>{title}</strong>
          <span className="node-detail">{detail}</span>
        </span>
        <span className="node-tail">
          {kind === 'trigger' ? (
            <CircleDot size={15} />
          ) : kind === 'output' ? (
            <Check size={15} />
          ) : (
            <>
              <span className="node-number">{String(number).padStart(2, '0')}</span>
              <GripVertical className="node-grip" size={15} />
            </>
          )}
        </span>
      </button>
    );
  }
  return (
    <section className="canvas" aria-label="Workflow canvas">
      <div className="canvas-head">
        <span>
          <GitBranch size={15} /> Workflow canvas
        </span>
        <button
          className="btn btn-light add-step"
          onClick={() => onInsert(doc.steps.length)}
          disabled={doc.steps.length >= maxSteps}
        >
          <Plus size={15} />
          Add step
        </button>
      </div>
      <div className="canvas-scroll" ref={stage}>
        <div className="flow-position">
          <div className="flow" ref={flow} style={{ zoom }}>
            {starts.length === 1 ? (
              card(
                'trigger',
                'trigger',
                'Manual trigger',
                doc.inputMode === 'json' ? 'JSON input' : 'Text input',
              )
            ) : (
              <div
                className={
                  'flow-card node-trigger trigger-group' + (selection === 'trigger' ? ' selected' : '')
                }
                role="group"
                aria-label="Workflow triggers"
              >
                <span className="node-category">Start on any trigger</span>
                {starts.map((kind) => (
                  <button
                    type="button"
                    key={kind}
                    aria-label={kinds[kind].name + ', Trigger'}
                    aria-pressed={selection === 'trigger' && triggerKind === kind}
                    onClick={() => onTrigger(kind)}
                  >
                    <Tile kind={kind} small />
                    <span className="node-copy">
                      <strong>{kinds[kind].name}</strong>
                      <span className="node-detail">
                        {kind === 'webhook'
                          ? 'Incoming JSON request'
                          : kind === 'schedule'
                            ? intervalLabel(triggers!.schedule.intervalMinutes)
                            : doc.inputMode === 'json'
                              ? 'JSON input'
                              : 'Text input'}
                      </span>
                    </span>
                    <CircleDot size={13} />
                  </button>
                ))}
              </div>
            )}
            {doc.steps.map((step, i) => (
              <div className="flow-unit" key={step.id}>
                {link(i)}
                {card(
                  step.id,
                  step.kind,
                  step.name || 'Untitled step',
                  subtitle(step, connections),
                  step,
                  i + 1,
                )}
              </div>
            ))}
            {link(doc.steps.length)}
            {card('output', 'output', 'Return result', 'Workflow output')}
          </div>
        </div>
      </div>
      <div className="canvas-foot">
        <div className="zoom-tools">
          <IconButton
            label="Zoom out"
            onClick={() => setZoom((z) => Math.max(0.4, z - 0.1))}
            disabled={zoom <= 0.4}
          >
            <Minus size={15} />
          </IconButton>
          <button className="zoom-label" onClick={() => setZoom(1)} title="Reset to 100%">
            {Math.round(zoom * 100)}%
          </button>
          <IconButton
            label="Zoom in"
            onClick={() => setZoom((z) => Math.min(1.6, z + 0.1))}
            disabled={zoom >= 1.6}
          >
            <Plus size={15} />
          </IconButton>
          <i />
          <IconButton label="Fit workflow to view" onClick={fit}>
            <Focus size={16} />
          </IconButton>
        </div>
        <span className="canvas-order">
          <ArrowDown size={12} /> Runs top to bottom
        </span>
      </div>
    </section>
  );
}
