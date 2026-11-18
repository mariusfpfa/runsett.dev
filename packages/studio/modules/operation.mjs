import { isDeepStrictEqual } from 'node:util';
import { parseDataSetting } from './data-settings.mjs';

function fieldValue(input, path) {
  let result = input;
  for (const key of path ? path.split('.') : []) {
    if (
      result === null ||
      typeof result !== 'object' ||
      !Object.hasOwn(result, key) ||
      (Array.isArray(result) && !/^(0|[1-9]\d*)$/.test(key))
    )
      return undefined;
    result = result[key];
  }
  return result;
}

function setField(input, { path, value }) {
  const parts = path.split('.');
  function set(object, depth) {
    if (object === null || typeof object !== 'object' || Array.isArray(object))
      throw new Error('Set field needs a JSON object at each part of the path.');
    const key = parts[depth];
    const child = Object.hasOwn(object, key) ? object[key] : {};
    return { ...object, [key]: depth + 1 === parts.length ? value : set(child, depth + 1) };
  }
  return set(input, 0);
}

// Runs inside a registered, network-disabled Runsett container.
export default async function operation({ kind, setting, value }) {
  switch (kind) {
    case 'format': {
      if (typeof value !== 'string')
        throw new Error('Format text needs a text value. Use Read field to select a string from JSON.');
      switch (setting) {
        case 'upper':
          return value.toUpperCase();
        case 'lower':
          return value.toLowerCase();
        case 'trim':
          return value.trim();
        case 'title':
          return value
            .trim()
            .toLowerCase()
            .replace(/(^|\s)(\S)/gu, (_, space, letter) => space + letter.toUpperCase());
        default:
          throw new Error('Unknown text format.');
      }
    }
    case 'compose':
      return setting.replaceAll('{{value}}', () =>
        typeof value === 'string' ? value : JSON.stringify(value),
      );
    case 'field': {
      const result = fieldValue(value, setting);
      if (result === undefined) throw new Error('No value was found at field "' + setting + '".');
      return result;
    }
    case 'parse-json':
      if (typeof value !== 'string') throw new Error('Parse JSON needs text input.');
      try {
        return JSON.parse(value);
      } catch {
        throw new Error('The input is not valid JSON.');
      }
    case 'set-field':
      return setField(value, parseDataSetting(kind, setting));
    case 'filter-list': {
      if (!Array.isArray(value)) throw new Error('Filter list needs a JSON array.');
      const config = parseDataSetting(kind, setting);
      return value.filter((item) => isDeepStrictEqual(fieldValue(item, config.path), config.equals));
    }
    case 'choose': {
      const config = parseDataSetting(kind, setting);
      return isDeepStrictEqual(fieldValue(value, config.path), config.equals) ? config.then : config.else;
    }
    default:
      throw new Error('Unknown visual step.');
  }
}
