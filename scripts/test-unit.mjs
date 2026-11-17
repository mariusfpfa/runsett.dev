import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const filters = process.argv.slice(2);
const files = readdirSync('tests/unit').filter((name) => name.endsWith('.test.ts') &&
  (filters.length === 0 || filters.some((filter) => name.includes(filter))));
if (files.length === 0) {
  console.error(`No unit tests matched: ${filters.join(', ')}`);
  process.exit(1);
}
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...files.map((name) => `tests/unit/${name}`)], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
