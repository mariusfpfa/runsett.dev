import { Ajv2020 } from 'ajv/dist/2020.js';
import { assertJsonValue, assertRecord, type JsonValue } from '@runsett/contracts';
export type JsonSchema = { [key: string]: JsonValue };
export interface BlockDefinition {
  name: string; version: string; moduleId: string; moduleHash: string;
  inputSchema: JsonSchema; outputSchema: JsonSchema;
  effect: 'pure' | 'read' | 'write'; maximumAttempts: number;
  credentialBindings: string[]; networkMode: 'none' | 'configured';
}
const validator = new Ajv2020({ strict: true, allErrors: true });
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
}
export function defineBlock(definition: Omit<BlockDefinition, 'maximumAttempts'> & { maximumAttempts?: number }): BlockDefinition {
  assertRecord(definition, ['name', 'version', 'moduleId', 'moduleHash', 'inputSchema', 'outputSchema', 'effect', 'maximumAttempts', 'credentialBindings', 'networkMode'], 'block');
  assertJsonValue(definition, 262_144);
  const block = { ...definition, maximumAttempts: definition.maximumAttempts ?? 1 };
  for (const key of ['name', 'version', 'moduleId'] as const) if (typeof block[key] !== 'string' || !block[key]) throw new TypeError(`Invalid block ${key}`);
  if (!/^[a-f0-9]{64}$/.test(block.moduleHash)) throw new TypeError('moduleHash must be SHA-256');
  if (!['pure', 'read', 'write'].includes(block.effect)) throw new TypeError('Invalid effect');
  if (!Number.isSafeInteger(block.maximumAttempts) || block.maximumAttempts < 1) throw new TypeError('maximumAttempts must be positive');
  if (!['none', 'configured'].includes(block.networkMode)) throw new TypeError('Invalid networkMode');
  if (!Array.isArray(block.credentialBindings) || block.credentialBindings.some(name => typeof name !== 'string' || !name) || new Set(block.credentialBindings).size !== block.credentialBindings.length) throw new TypeError('Invalid credential bindings');
  for (const schema of [block.inputSchema, block.outputSchema]) {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new TypeError('Schema must be a JSON Schema object');
    const compiled = validator.compile(schema); // Checks 2020-12 and unresolved references.
    if ('$async' in compiled && compiled.$async) throw new TypeError('Async validator schemas are not supported');
  }
  return freeze(JSON.parse(JSON.stringify(block)) as BlockDefinition);
}
export function validateBlockValue(schema: JsonSchema, value: JsonValue): void {
  const compiled = validator.compile(schema);
  if (('$async' in compiled && compiled.$async) || !compiled(value)) throw new TypeError('Value does not match block schema');
}
