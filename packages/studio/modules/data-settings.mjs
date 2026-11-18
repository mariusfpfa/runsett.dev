export const dataKinds = ['parse-json', 'set-field', 'filter-list', 'choose'];

export function parseDataSetting(kind, setting) {
  if (kind === 'parse-json') return {};
  let config;
  try {
    config = JSON.parse(setting);
  } catch {
    throw new Error('Enter valid JSON for the step settings.');
  }
  if (!config || typeof config !== 'object' || Array.isArray(config) || typeof config.path !== 'string')
    throw new Error('Enter a field path.');
  const parts = config.path === '' ? [] : config.path.split('.');
  if (
    parts.length > 32 ||
    parts.some((key) => !key.trim()) ||
    (kind === 'set-field' &&
      (!parts.length || parts.some((key) => ['__proto__', 'prototype', 'constructor'].includes(key))))
  )
    throw new Error('Enter a valid dotted field path of up to 32 parts.');
  const required =
    kind === 'set-field' ? ['value'] : kind === 'choose' ? ['equals', 'then', 'else'] : ['equals'];
  for (const key of required) {
    if (!Object.hasOwn(config, key)) throw new Error('Enter a JSON value for “' + key + '”.');
  }
  return config;
}
