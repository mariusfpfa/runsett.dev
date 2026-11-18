import type { DiagnosticRecord } from '@runsett/contracts';
import { useEffect, useRef, type ReactNode } from 'react';
import {
  ArrowDownToLine,
  Braces,
  CaseSensitive,
  Clock3,
  FileCode2,
  MessageSquareText,
  MousePointer2,
  X,
} from 'lucide-react';
import type { StepKind, VisualStep } from '../src/model.js';

export const kinds = {
  trigger: {
    icon: MousePointer2,
    label: 'Trigger',
    name: 'Manual trigger',
    hint: 'Start with an input value.',
  },
  format: {
    icon: CaseSensitive,
    label: 'Transform',
    name: 'Format text',
    hint: 'Change the case or spacing of text.',
  },
  compose: {
    icon: MessageSquareText,
    label: 'Action',
    name: 'Compose message',
    hint: 'Combine text with the previous value.',
  },
  field: { icon: Braces, label: 'Transform', name: 'Read field', hint: 'Pick a value from JSON data.' },
  wait: { icon: Clock3, label: 'Timing', name: 'Wait', hint: 'Pause before continuing.' },
  javascript: {
    icon: FileCode2,
    label: 'Code',
    name: 'JavaScript',
    hint: 'Write and test a JavaScript function.',
  },
  output: {
    icon: ArrowDownToLine,
    label: 'Output',
    name: 'Return result',
    hint: 'Return the final step’s value.',
  },
};
export type NodeKind = keyof typeof kinds;
export const formatLabels: Record<string, string> = {
  title: 'Title case',
  upper: 'UPPERCASE',
  lower: 'lowercase',
  trim: 'Trim whitespace',
};
export function subtitle(step: VisualStep) {
  if (step.kind === 'format') return formatLabels[step.setting] ?? 'Select a format';
  if (step.kind === 'javascript') return step.setting.trim() ? 'step.mjs' : 'Add your code';
  if (step.kind === 'wait') return step.setting + (step.setting === '1' ? ' second' : ' seconds');
  return step.setting || (step.kind === 'field' ? 'Choose a field' : 'Empty message');
}
export function Tile({ kind, small = false }: { kind: NodeKind; small?: boolean }) {
  const Icon = kinds[kind].icon;
  return (
    <span className={'tile tile-' + kind + (small ? ' small' : '')}>
      <Icon size={small ? 17 : 23} strokeWidth={1.8} />
    </span>
  );
}
export function IconButton({
  label,
  children,
  onClick,
  disabled = false,
  className = '',
}: {
  label: string;
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={'icon-btn ' + className}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
export function Modal({
  title,
  close,
  children,
  wide = false,
  className = '',
}: {
  title: string;
  close: () => void;
  children: ReactNode;
  wide?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={'dialog ' + className + (wide ? ' wide' : '')}
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div className="dialog-inner">
        <div className="dialog-heading">
          <h2>{title}</h2>
          <IconButton label="Close dialog" onClick={close}>
            <X size={18} />
          </IconButton>
        </div>
        {children}
      </div>
    </dialog>
  );
}
export const actionKinds = Object.keys(kinds).filter(
  (key) => key !== 'trigger' && key !== 'output',
) as StepKind[];
export function Status({ state }: { state: string }) {
  const label = state.toLowerCase().replaceAll('_', ' ');
  return (
    <span className={'status status-' + state.toLowerCase()}>
      <i />
      {label.charAt(0).toUpperCase() + label.slice(1)}
    </span>
  );
}

export function ConsoleOutput({ records }: { records: DiagnosticRecord[] }) {
  return records.length ? (
    <pre className="js-console-lines">
      {records.map((record, i) => (
        <span className={'js-log-' + record.stream} key={i}>
          <b>{record.stream}</b>
          {'  '}
          {record.message}
          {'\n'}
        </span>
      ))}
    </pre>
  ) : (
    <p className="js-empty">No console output.</p>
  );
}
