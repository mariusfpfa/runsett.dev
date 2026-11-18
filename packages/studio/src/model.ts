import {
  assertJsonValue,
  DEFAULT_EXECUTION_LIMITS,
  utf8ByteLength,
  type DiagnosticRecord,
  type JsonValue,
} from '@runsett/contracts';

export type StepKind = 'format' | 'compose' | 'field' | 'wait' | 'javascript';
export type VisualStep = { id: string; kind: StepKind; name: string; setting: string };
export type WorkflowDocument = {
  name: string;
  inputMode: 'text' | 'json';
  sampleInput: string;
  steps: VisualStep[];
};
export type SavedWorkflow = { id: string; revision: number; updatedAt: string; document: WorkflowDocument };
export type RunInput = { name: string; revision: number; value: JsonValue; steps: VisualStep[] };
export const maxSteps = 24;
export const maxSourceBytes = 32 * 1024;
export const maxTestInputBytes = DEFAULT_EXECUTION_LIMITS.inputBytes;
export type TestFixture = { mode: WorkflowDocument['inputMode']; text: string };
export type RecordedStepOutput = { stepName: string; value: JsonValue; runId: string; revision: number };
export type RecordedRunRef = { id: string; runId: string };
export type RecordedRunOption = RecordedRunRef & {
  startedAt: string;
  state: string;
  revision: number;
  steps: Pick<VisualStep, 'id' | 'name'>[];
};

export function previousSourceId(
  steps: Pick<VisualStep, 'id'>[],
  targetId: string,
  draft: Pick<VisualStep, 'id'>[],
) {
  if (targetId === 'trigger') return 'trigger';
  if (targetId === 'output') return steps.at(-1)?.id ?? 'trigger';
  const index = steps.findIndex((s) => s.id === targetId);
  if (index >= 0) return steps[index - 1]?.id ?? 'trigger';
  // A newly added step can use its draft predecessor when testing against an older revision.
  const draftIndex = draft.findIndex((s) => s.id === targetId);
  return draft[draftIndex - 1]?.id ?? 'trigger';
}

export function fixtureFromOutput(value: JsonValue): TestFixture {
  if (typeof value === 'string') return { mode: 'text', text: value };
  const compact = JSON.stringify(value);
  // Keep large samples editable without expanding them with indentation.
  const text = compact.length <= 8192 ? JSON.stringify(value, null, 2) : compact;
  return { mode: 'json', text: text.length <= maxTestInputBytes ? text : compact };
}
export type StepTestResult = { diagnostics: DiagnosticRecord[]; durationMs: number } & (
  | { ok: true; output: JsonValue }
  | { ok: false; error: { code: string; message: string; line?: number } }
);
export const formats = ['title', 'upper', 'lower', 'trim'] as const;
export const kindSettings: Record<StepKind, { name: string; initial: string }> = {
  format: { name: 'Format text', initial: 'title' },
  compose: { name: 'Compose message', initial: 'Hello, {{value}}!' },
  field: { name: 'Read field', initial: 'name' },
  wait: { name: 'Wait', initial: '2' },
  javascript: {
    name: 'JavaScript',
    initial: [
      'export default async function (input, context) {',
      '  const name = typeof input === "string" ? input : input?.name;',
      '  context.log("Preparing a greeting");',
      '  return { greeting: `Hello, ${name || "world"}!` };',
      '}',
    ].join('\n'),
  },
};
export function greeting(): WorkflowDocument {
  return {
    name: 'Welcome message',
    inputMode: 'text',
    sampleInput: 'alex morgan',
    steps: [
      { id: 'format-name', kind: 'format', name: 'Format name', setting: 'title' },
      { id: 'write-greeting', kind: 'compose', name: 'Compose greeting', setting: 'Welcome, {{value}}!' },
    ],
  };
}
export class RequestError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
export function uuid(value: unknown): value is string {
  return (
    typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)
  );
}
function boundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max;
}
export function validateSource(source: unknown, allowBlank = false): asserts source is string {
  if (typeof source !== 'string' || utf8ByteLength(source) > maxSourceBytes)
    throw new RequestError('JavaScript source must fit within 32 KiB.');
  if (!allowBlank && !source.trim())
    throw new RequestError('Enter JavaScript source before running the step.');
}
export function validateStepTest(value: unknown): { source: string; input: JsonValue } {
  if (!value || typeof value !== 'object')
    throw new RequestError('Provide JavaScript source and a test input.');
  const { source, input } = value as { source?: unknown; input?: unknown };
  validateSource(source);
  assertTestInput(input);
  return { source, input };
}
export function assertTestInput(input: unknown): asserts input is JsonValue {
  try {
    assertJsonValue(input, maxTestInputBytes);
  } catch {
    throw new RequestError('Test input must be a JSON value of up to 1 MiB.');
  }
}
export function validateDocument(value: unknown): WorkflowDocument {
  if (!value || typeof value !== 'object') throw new RequestError('A workflow is required.');
  const doc = value as WorkflowDocument;
  if (
    !boundedText(doc.name, 100) ||
    !['text', 'json'].includes(doc.inputMode) ||
    !boundedText(doc.sampleInput, 16_384)
  ) {
    throw new RequestError('Check the workflow name and trigger input (up to 16,384 characters).');
  }
  if (!Array.isArray(doc.steps) || doc.steps.length > maxSteps)
    throw new RequestError('Use up to ' + maxSteps + ' steps.');
  const ids = new Set<string>();
  const steps = doc.steps.map((step) => {
    if (
      !step ||
      typeof step.id !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(step.id) ||
      step.id === 'trigger' ||
      step.id === 'output' ||
      ids.has(step.id)
    )
      throw new RequestError('Step IDs must be unique.');
    ids.add(step.id);
    if (
      !Object.hasOwn(kindSettings, step.kind) ||
      !boundedText(step.name, 100) ||
      (step.kind !== 'javascript' && !boundedText(step.setting, 2048))
    ) {
      throw new RequestError('Check the step type, name and settings.');
    }
    if (step.kind === 'javascript') validateSource(step.setting, true);
    return { id: step.id, kind: step.kind, name: step.name, setting: step.setting };
  });
  return { name: doc.name, inputMode: doc.inputMode, sampleInput: doc.sampleInput, steps };
}
function validateStepSettings(step: Pick<VisualStep, 'kind' | 'name' | 'setting'>) {
  if (step.kind === 'javascript') validateSource(step.setting);
  if (!step.name.trim()) throw new RequestError('Give each step a name.');
  if (step.kind === 'format' && !formats.some((mode) => mode === step.setting))
    throw new RequestError('Choose a text format for ' + step.name + '.');
  if (step.kind === 'field' && step.setting.split('.').some((key) => !key.trim()))
    throw new RequestError('Enter a field path for ' + step.name + '.');
  if (
    step.kind === 'wait' &&
    (!/^\d+$/.test(step.setting) || Number(step.setting) < 1 || Number(step.setting) > 86400)
  ) {
    throw new RequestError('Waits must be between 1 and 86,400 whole seconds.');
  }
}
export function validateOperationTest(value: unknown) {
  if (!value || typeof value !== 'object') throw new RequestError('Provide a step and a test input.');
  const { kind, setting, input } = value as { kind?: unknown; setting?: unknown; input?: unknown };
  if (
    (kind !== 'format' && kind !== 'compose' && kind !== 'field' && kind !== 'wait') ||
    !boundedText(setting, 2048)
  )
    throw new RequestError('Choose a supported step and its settings.');
  validateStepSettings({ kind, name: kindSettings[kind].name, setting });
  assertTestInput(input);
  return { kind, setting, input };
}
export function validateForRun(value: WorkflowDocument, testInput?: JsonValue): JsonValue {
  const doc = validateDocument(value);
  if (!doc.name.trim()) throw new RequestError('Give the workflow a name before running it.');
  for (const step of doc.steps) validateStepSettings(step);
  if (testInput !== undefined) {
    assertTestInput(testInput);
    return testInput;
  }
  if (doc.inputMode === 'text') return doc.sampleInput;
  try {
    return JSON.parse(doc.sampleInput) as JsonValue;
  } catch {
    throw new RequestError('Enter valid JSON in the manual trigger, or choose Text.');
  }
}
