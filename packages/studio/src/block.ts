import { defineBlock } from '@runsett/sdk';
import { dataKinds } from '../modules/data-settings.mjs';
import type { ConnectorKind } from './connector-settings.js';

export function connectorBinding(kind: ConnectorKind, setting: string): string | undefined {
  const { connectionId } = JSON.parse(setting) as { connectionId?: string };
  if (!connectionId && kind === 'http') return undefined;
  if (!connectionId || !connectionId.startsWith(kind + '-')) throw new Error('Choose a matching connection.');
  return connectionId;
}

export function connectorBlock(moduleHash: string, kind: ConnectorKind, binding?: string) {
  if ((binding && !binding.startsWith(kind + '-')) || (!binding && kind !== 'http'))
    throw new Error('Choose a matching connection.');
  return defineBlock({
    name: kind === 'http' ? 'HTTP request' : kind === 'slack' ? 'Send Slack message' : 'Send Teams message',
    version: '1',
    moduleId: 'studio-connector',
    moduleHash,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'setting', 'value'],
      properties: { kind: { const: kind }, setting: { type: 'string' }, value: {} },
    },
    outputSchema: {},
    effect: 'write',
    maximumAttempts: 1,
    credentialBindings: binding ? [binding] : [],
    networkMode: 'configured',
  });
}

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
      properties: {
        kind: { enum: ['format', 'compose', 'field', ...dataKinds] },
        setting: { type: 'string' },
        value: {},
      },
    },
    outputSchema: {},
    effect: 'pure',
    credentialBindings: [],
    networkMode: 'none',
  });
}
