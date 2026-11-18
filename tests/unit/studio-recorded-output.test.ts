import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { StudioEngine } from '../../packages/studio/src/engine.js';
import { fixtureFromOutput, greeting, previousSourceId } from '../../packages/studio/src/model.js';
import { StudioStore } from '../../packages/studio/src/store.js';

test('the default source follows the recorded order and supports a newly added test step', () => {
  const historic = [{ id: 'first' }, { id: 'js' }, { id: 'last' }];
  const draft = [{ id: 'last' }, { id: 'js' }, { id: 'first' }, { id: 'new' }];
  assert.equal(previousSourceId(historic, 'js', draft), 'first');
  assert.equal(previousSourceId(historic, 'new', draft), 'first');
  assert.equal(previousSourceId(historic, 'first', draft), 'trigger');
  assert.equal(previousSourceId(historic, 'output', draft), 'last');
});

test('an explicit run pins the execution and never substitutes another run or workflow', async (t) => {
  const store = new StudioStore(':memory:');
  t.after(() => store.close());
  const engine = new StudioEngine(store);
  const original = store.create(greeting());
  const saved = store.prepareRun(original.id, 1, randomUUID(), 'test');
  const selected = { id: saved.id, runId: randomUUID() };
  const wrongRunId = randomUUID();
  const different = store.create(greeting());
  const signal = new AbortController().signal;
  // The first step has since been removed from the draft.
  store.save(original.id, 1, { ...original.document, steps: [] });
  t.mock.method(engine, 'history', () => {
    throw new Error('A pinned execution cannot search for a substitute');
  });
  const inspect = t.mock.method(
    engine,
    'inspect',
    async (id: string, logs: boolean, selection: { runId: string; outputStepId: string | null }) => {
      assert.equal(id, saved.id);
      assert.equal(logs, false);
      if (selection.runId !== selected.runId) throw new Error('Execution is unavailable');
      return {
        state: 'COMPLETED',
        partial: false,
        output: null,
        steps: [
          { stepId: 'format-name', state: 'COMPLETED', output: 0 },
          { stepId: 'write-greeting', state: 'FAILED' },
        ],
      };
    },
  );
  const load = (stepId: string) => engine.previousOutput(original.id, stepId, signal, selected);
  assert.deepEqual(await load('format-name'), {
    stepName: 'Format name',
    value: 0,
    revision: 1,
    runId: selected.runId,
  });
  assert.equal(await load('write-greeting'), null);
  assert.equal(await load('new-in-draft'), null);
  assert.deepEqual(await load('output'), {
    stepName: 'Return result',
    value: null,
    revision: 1,
    runId: selected.runId,
  });
  assert.equal((await load('trigger'))?.value, original.document.sampleInput);
  assert.equal(inspect.mock.calls.at(-1)?.arguments[2]?.runId, selected.runId);
  await assert.rejects(
    engine.previousOutput(original.id, 'trigger', signal, { ...selected, runId: wrongRunId }),
    /unavailable/,
  );
  await assert.rejects(engine.previousOutput(different.id, 'trigger', signal, selected), /workflow/i);
});

test('loading an output preserves JSON types, including strings that resemble JSON', () => {
  for (const value of [null, false, 0, { items: [1, 2] }, [], 'false', '', '{"total":25}']) {
    const fixture = fixtureFromOutput(value);
    assert.equal(fixture.mode, typeof value === 'string' ? 'text' : 'json');
    assert.deepEqual(fixture.mode === 'json' ? JSON.parse(fixture.text) : fixture.text, value);
  }
});

test('the latest available output comes from the matching step in a recorded workflow revision', async (t) => {
  const store = new StudioStore(':memory:');
  t.after(() => store.close());
  const engine = new StudioEngine(store);
  const doc = greeting();
  const source = { ...doc.steps[0]!, name: 'Pick amount' };
  const wait = { id: 'pause', kind: 'wait' as const, name: 'Pause', setting: '1' };
  const workflow = store.create({ ...doc, inputMode: 'json', sampleInput: 'false', steps: [source, wait] });
  const older = store.prepareRun(workflow.id, 1, randomUUID(), 'v1');
  const newer = store.prepareRun(workflow.id, 1, randomUUID(), 'v1');
  store.save(workflow.id, 1, { ...doc, steps: [wait, source] });
  const olderRunId = randomUUID(),
    newerRunId = randomUUID();
  t.mock.method(engine, 'history', async (id: string) => {
    assert.equal(id, workflow.id);
    return [
      { id: older.id, runId: olderRunId, startedAt: new Date(1) },
      { id: newer.id, runId: newerRunId, startedAt: new Date(2) },
    ];
  });
  const inspection = t.mock.method(engine, 'inspect', async (id: string) => ({
    partial: false,
    steps:
      id === newer.id
        ? [
            { stepId: source.id, state: 'FAILED' },
            { stepId: wait.id, state: 'PENDING' },
          ]
        : [
            { stepId: source.id, state: 'COMPLETED', output: null },
            { stepId: wait.id, state: 'COMPLETED' },
          ],
  }));
  const load = (stepId: string) => engine.previousOutput(workflow.id, stepId, new AbortController().signal);
  assert.deepEqual(await load('trigger'), {
    stepName: 'Manual trigger',
    value: false,
    revision: 1,
    runId: newerRunId,
  });
  assert.equal(inspection.mock.callCount(), 0);
  assert.deepEqual(await load(wait.id), { stepName: 'Pause', value: null, revision: 1, runId: olderRunId });
  assert.deepEqual(await load(source.id), {
    stepName: 'Pick amount',
    value: null,
    revision: 1,
    runId: olderRunId,
  });
  assert.equal(await load('brand-new-step'), null);
});
