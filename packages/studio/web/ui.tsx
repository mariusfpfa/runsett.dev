import type { DiagnosticRecord } from '@runsett/contracts';
import { useEffect, useRef, type ReactNode } from 'react';
import {
  ArrowDownToLine,
  Braces,
  CaseSensitive,
  Clock3,
  FileCode2,
  FileJson2,
  GitFork,
  Globe2,
  Hash,
  ListFilter,
  MessageSquareText,
  MousePointer2,
  PencilLine,
  Timer,
  UsersRound,
  Webhook,
  X,
} from 'lucide-react';
import { kindSettings, type StepKind, type VisualStep } from '../src/model.js';
import type { JsonValue } from '@runsett/contracts';
import type { ConnectionSummary } from '../src/connector-settings.js';

export const kinds = {
  trigger: {
    icon: MousePointer2,
    label: 'Trigger',
    name: 'Manual trigger',
    hint: 'Start with an input value.',
  },
  webhook: {
    icon: Webhook,
    label: 'Trigger',
    name: 'Webhook',
    hint: 'Start a run when a JSON request reaches Studio.',
  },
  schedule: {
    icon: Timer,
    label: 'Trigger',
    name: 'Schedule',
    hint: 'Run at a regular interval with the workflow’s saved input.',
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
  'parse-json': {
    icon: FileJson2,
    label: 'Transform',
    name: kindSettings['parse-json'].name,
    hint: 'Turn JSON text into a value other steps can use.',
  },
  'set-field': {
    icon: PencilLine,
    label: 'Transform',
    name: kindSettings['set-field'].name,
    hint: 'Add or replace a field in a JSON object.',
  },
  'filter-list': {
    icon: ListFilter,
    label: 'Transform',
    name: kindSettings['filter-list'].name,
    hint: 'Keep list items that match a value.',
  },
  choose: {
    icon: GitFork,
    label: 'Logic',
    name: kindSettings.choose.name,
    hint: 'Return one of two values based on a condition.',
  },
  http: {
    icon: Globe2,
    label: 'Request',
    name: kindSettings.http.name,
    hint: 'Call an HTTP endpoint and receive its response.',
  },
  slack: {
    icon: Hash,
    label: 'Messaging',
    name: kindSettings.slack.name,
    hint: 'Send a message to a channel in your Slack workspace.',
  },
  teams: {
    icon: UsersRound,
    label: 'Messaging',
    name: kindSettings.teams.name,
    hint: 'Send a message to a channel in Microsoft Teams.',
  },
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
export type MarkInvalid = (change: 1 | -1) => void;

export function useInvalidDraft(invalid: boolean, markInvalid: MarkInvalid) {
  useEffect(() => {
    if (!invalid) return;
    markInvalid(1);
    return () => markInvalid(-1);
  }, [invalid, markInvalid]);
}

export type TriggerKind = 'trigger' | 'webhook' | 'schedule';
export const triggerKinds = ['trigger', 'webhook', 'schedule'] as const;
export function isTriggerKind(kind: NodeKind): kind is TriggerKind {
  return kind === 'trigger' || kind === 'webhook' || kind === 'schedule';
}
export const libraryGroups = [
  { name: 'Apps & APIs', kinds: ['http', 'slack', 'teams'] },
  { name: 'Data', kinds: ['format', 'compose', 'parse-json', 'field', 'set-field', 'filter-list'] },
  { name: 'Logic & code', kinds: ['choose', 'wait', 'javascript'] },
  { name: 'Triggers', kinds: triggerKinds },
] as const satisfies readonly { name: string; kinds: readonly (StepKind | TriggerKind)[] }[];
export const formatLabels: Record<string, string> = {
  title: 'Title case',
  upper: 'UPPERCASE',
  lower: 'lowercase',
  trim: 'Trim whitespace',
};
export function settingObject(setting: string): Record<string, JsonValue> | null {
  try {
    const parsed: unknown = JSON.parse(setting);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, JsonValue>)
      : null;
  } catch {
    return null;
  }
}
export function subtitle(step: VisualStep, connections: ConnectionSummary[] = []) {
  if (step.kind === 'format') return formatLabels[step.setting] ?? 'Select a format';
  if (step.kind === 'javascript') return step.setting.trim() ? 'step.mjs' : 'Add your code';
  if (step.kind === 'wait') return step.setting + (step.setting === '1' ? ' second' : ' seconds');
  if (step.kind === 'field') return step.setting || 'Choose a field';
  if (step.kind === 'compose') return step.setting || 'Empty message';
  if (step.kind === 'parse-json') return 'JSON text → value';
  const config = settingObject(step.setting);
  if (!config) return 'Check step settings';
  if (step.kind === 'http') {
    try {
      return String(config.method) + ' · ' + new URL(String(config.url)).host;
    } catch {
      return 'Set a request URL';
    }
  }
  if (step.kind === 'slack' || step.kind === 'teams') {
    const account = connections.find((item) => item.id === config.connectionId);
    const channel = config.channelName || config.channelId;
    if (typeof channel === 'string' && channel) {
      if (step.kind === 'slack') return '#' + channel.replace(/^#/, '');
      const team = config.teamName || config.teamId;
      return team ? team + ' / ' + channel : channel;
    }
    if (account && 'auth' in account && account.auth === 'oauth') {
      return step.kind === 'teams' && !config.teamId ? 'Choose a team' : 'Choose a channel';
    }
    return account?.name ?? (config.connectionId ? 'Saved connection' : 'Choose an account');
  }
  const path = typeof config.path === 'string' ? config.path : '';
  if (step.kind === 'set-field') return path || 'Choose a field';
  return path || (step.kind === 'filter-list' ? 'Compare each item' : 'Compare the input');
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
