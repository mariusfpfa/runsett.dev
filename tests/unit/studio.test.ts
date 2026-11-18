import test from 'node:test';
import assert from 'node:assert/strict';
import { StudioStore } from '../../packages/studio/src/store.js';
import { greeting, validateForRun } from '../../packages/studio/src/model.js';
import { randomUUID } from 'node:crypto';

test('a workflow test keeps its one-off input on retry and leaves the saved trigger intact', (t) => {
  const store = new StudioStore(':memory:');
  t.after(() => store.close());
  const saved = store.create(greeting());
  const request = randomUUID();
  const submit = (value?: null | false) => store.prepareRun(saved.id, saved.revision, request, 'v1', value);
  const first = submit(null);
  assert.equal(first.input.value, null);
  assert.deepEqual(submit(null), first);
  assert.throws(() => submit(false), /input/);
  assert.throws(() => submit(), /input/);
  assert.deepEqual(store.get(saved.id), saved);
  assert.equal(
    store.prepareRun(saved.id, saved.revision, randomUUID(), 'v1').input.value,
    saved.document.sampleInput,
  );
});

test('a run keeps its saved steps and input after another edit, including on retry', () => {
  const store = new StudioStore(':memory:');
  try {
    const original = store.create(greeting());
    const requestId = 'e45de36c-a0ba-4a62-bb06-b37916e81934';
    const run = store.prepareRun(original.id, original.revision, requestId, 'studio-v1');
    const edited = store.save(original.id, original.revision, {
      ...original.document,
      sampleInput: 'another name',
    });
    assert.equal(edited.revision, original.revision + 1);
    assert.throws(() => store.save(original.id, original.revision, original.document), /another tab/);
    assert.deepEqual(store.prepareRun(original.id, original.revision, requestId, 'studio-v2'), run);
    assert.equal(run.input.value, original.document.sampleInput);
    assert.throws(
      () => store.prepareRun(original.id, edited.revision, requestId, 'studio-v2'),
      /different revision/,
    );
  } finally {
    store.close();
  }
});

test('drafts can be incomplete but invalid inputs and ambiguous step IDs cannot run', () => {
  const doc = greeting();
  assert.throws(() => validateForRun({ ...doc, inputMode: 'json', sampleInput: '{' }), /valid JSON/);
  assert.throws(() => validateForRun({ ...doc, steps: [doc.steps[0]!, doc.steps[0]!] }), /unique/);
  assert.throws(
    () => validateForRun({ ...doc, steps: [{ ...doc.steps[0]!, kind: 'wait', setting: '-1' }] }),
    /seconds/,
  );
  assert.equal(validateForRun({ ...doc, inputMode: 'json', sampleInput: 'false' }), false);
});
