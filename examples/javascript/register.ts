import { execFileSync } from 'node:child_process';
import { registerExample } from './deployment.js';
const version = process.env.RUNSETT_EXAMPLE_VERSION ?? '1';
if (version !== '1' && version !== '2') throw new TypeError('RUNSETT_EXAMPLE_VERSION must be 1 or 2');
const image = execFileSync('docker', ['build', '-q', '-f', 'packages/runner/Dockerfile', '--build-arg', 'MODULE_BUNDLE=examples/javascript/modules', '.'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
const deployment = await registerExample({ registryDirectory: process.env.RUNSETT_DEPLOYMENTS_DIR ?? '.runsett/deployments', deploymentId: process.env.RUNSETT_DEPLOYMENT_ID ?? `example-v${version}`, version, image });
console.log(JSON.stringify({ deploymentId: deployment.deploymentId, version: deployment.version, fingerprint: deployment.fingerprint }));
