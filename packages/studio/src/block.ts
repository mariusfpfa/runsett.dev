import { defineBlock } from '@runsett/sdk';
export function javaScriptBlock(moduleHash: string) {
  return defineBlock({
    name: 'JavaScript',
    version: '1',
    moduleId: 'studio-js-' + moduleHash,
    moduleHash,
    inputSchema: {},
    outputSchema: {},
    effect: 'write',
    credentialBindings: [],
    networkMode: 'none',
  });
}
export function visualBlock(moduleHash: string) {
  return defineBlock({
    name: 'Studio operation',
    version: '1',
    moduleId: 'studio-operation',
    moduleHash,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'setting', 'value'],
      properties: { kind: { enum: ['format', 'compose', 'field'] }, setting: { type: 'string' }, value: {} },
    },
    outputSchema: {},
    effect: 'pure',
    credentialBindings: [],
    networkMode: 'none',
  });
}
