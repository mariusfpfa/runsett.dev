import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
// Docker-heavy suites must run in series: concurrent startup/removal makes
// readiness bounds unreliable and obscures genuine recovery observations.
for (const file of readdirSync('tests/integration').filter(file => file.endsWith('.test.ts')).sort()) {
  console.log(`\nIntegration suite: ${file}`);
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', `tests/integration/${file}`], { stdio: 'inherit', timeout: 300_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
