export const dataKinds: readonly ['parse-json', 'set-field', 'filter-list', 'choose'];
export function parseDataSetting(kind: (typeof dataKinds)[number], setting: string): object;
