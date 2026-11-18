import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { pinSources } from '../../packages/studio/src/javascript.js';
import {
  greeting,
  maxSourceBytes,
  validateDocument,
  validateForRun,
  validateStepTest,
  type VisualStep,
} from '../../packages/studio/src/model.js';

const source = 'export default async function(input) { return input; }';
const script: VisualStep = { id: 'custom', kind: 'javascript', name: 'My code', setting: source };

test('JavaScript drafts keep the source exactly; empty code can be saved but cannot run', () => {
  const doc = { ...greeting(), steps: [script] };
  assert.equal(validateDocument(doc).steps[0]?.setting, source);
  assert.equal(validateForRun(doc), doc.sampleInput);
  const blank = { ...doc, steps: [{ ...script, setting: ' \n' }] };
  assert.equal(validateDocument(blank).steps[0]?.setting, ' \n');
  assert.throws(() => validateForRun(blank), /JavaScript source/);
  assert.throws(
    () => validateDocument({ ...doc, steps: [{ ...script, setting: 'é'.repeat(maxSourceBytes / 2 + 1) }] }),
    /32 KiB/,
  );
});

test('run inputs pin the exact code bytes, including when steps share a module', () => {
  const normal = greeting().steps[0]!;
  const plan = pinSources([script, normal, { ...script, id: 'copy' }]);
  const expected = createHash('sha256').update(source).digest('hex');
  assert.equal(plan.sources.size, 1);
  assert.equal(plan.sources.get(expected), source);
  assert.deepEqual(
    plan.steps.map((s) => s.setting),
    [expected, normal.setting, expected],
  );
  assert.notEqual(pinSources([{ ...script, setting: source + '\n' }]).steps[0]?.setting, expected);
  assert.equal(script.setting, source);
});

test('step tests accept falsy JSON values and validate the input separately from the workflow', () => {
  for (const input of [null, false, 0, '', ['sample'], { name: 'Alex' }]) {
    assert.deepEqual(validateStepTest({ source, input }), { source, input });
  }
  assert.throws(() => validateStepTest({ source }), /Test input/);
  const large = 'é'.repeat(512 * 1024 - 1);
  assert.equal(validateStepTest({ source, input: large }).input, large);
  assert.throws(() => validateStepTest({ source, input: large + 'é' }), /1 MiB/);
  assert.throws(() => validateStepTest({ source: '', input: null }), /JavaScript source/);
});
