export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** UTF-8 length without Node or browser globals, for deterministic workflow use. */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff &&
      value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4;
      index++;
    } else bytes += 3;
  }
  return bytes;
}

/** Only own enumerable data properties are permitted; getters are never invoked. */
export function assertRecord(value: unknown, keys: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== 'string' || !keys.includes(key) || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(`${label} has an unsupported property: ${String(key)}`);
    }
  }
}

export function assertJsonValue(value: unknown, maxBytes: number): asserts value is JsonValue {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError('maxBytes must be a positive safe integer');
  }
  const ancestors = new Set<object>();
  const pending: { value: unknown; exit?: boolean }[] = [{ value }];
  while (pending.length > 0) {
    const entry = pending.pop()!;
    const item = entry.value;
    if (entry.exit) {
      ancestors.delete(item as object);
      continue;
    }
    if (item === null || typeof item === 'boolean' || typeof item === 'string') continue;
    if (typeof item === 'number' && Number.isFinite(item)) continue;
    if (typeof item !== 'object' || item === null) throw new TypeError('Value is not JSON-compatible');
    if (ancestors.has(item)) throw new TypeError('JSON value contains a cycle');
    const array = Array.isArray(item);
    if (array && Object.getPrototypeOf(item) !== Array.prototype) {
      throw new TypeError('JSON arrays must not be class instances');
    }
    if (!array && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
      throw new TypeError('JSON objects must be plain objects');
    }
    ancestors.add(item);
    pending.push({ value: item, exit: true });
    const keys = Reflect.ownKeys(item);
    if (array && keys.length !== item.length + 1) throw new TypeError('JSON arrays must be dense and have no extra properties');
    for (const key of keys) {
      if (array && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
      if (typeof key !== 'string' || !descriptor.enumerable || !('value' in descriptor) ||
        (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= item.length))) {
        throw new TypeError('JSON values must have only enumerable string-keyed data properties');
      }
      pending.push({ value: descriptor.value });
    }
  }
  // JSON.stringify also escapes control characters and lone surrogates. Measure
  // that exact representation rather than the unescaped strings above.
  const serialized = JSON.stringify(value);
  if (utf8ByteLength(serialized) > maxBytes) throw new RangeError(`Serialized JSON exceeds ${maxBytes} bytes`);
}
