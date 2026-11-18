// Runs inside a registered, network-disabled Runsett container.
export default async function operation({ kind, setting, value }) {
  switch (kind) {
    case 'format': {
      if (typeof value !== 'string') throw new Error('Format text needs a text value. Use Read field to select a string from JSON.');
      switch (setting) {
        case 'upper': return value.toUpperCase();
        case 'lower': return value.toLowerCase();
        case 'trim': return value.trim();
        case 'title': return value.trim().toLowerCase().replace(/(^|\s)(\S)/gu, (_, space, letter) => space + letter.toUpperCase());
        default: throw new Error('Unknown text format.');
      }
    }
    case 'compose':
      return setting.replaceAll('{{value}}', () => typeof value === 'string' ? value : JSON.stringify(value));
    case 'field': {
      let result = value;
      for (const key of setting.split('.')) {
        if (result === null || typeof result !== 'object' || !Object.hasOwn(result, key) ||
            (Array.isArray(result) && !/^(0|[1-9]\d*)$/.test(key))) throw new Error('No value was found at field "' + setting + '".');
        result = result[key];
      }
      return result;
    }
    default: throw new Error('Unknown visual step.');
  }
}
