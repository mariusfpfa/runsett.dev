import isNumber from 'is-number';
import { existsSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
export default async function(input, context) {
  switch (input.mode) {
    case 'transform': await new Promise(r => setTimeout(r, 20)); console.log('ordinary {"ok":true}'); return { value: input.value * 2, dependency: isNumber(input.value), operationKey: context.operationKey, attempt: context.attempt };
    case 'boundary-error': { const error = new Error('m'.repeat(4080) + context.credentials.service); error.stack = 's'.repeat(1980) + context.credentials.service; throw error; }
    case 'throw': console.error(context.credentials.service); throw new Error(`failure ${context.credentials.service}`);
    case 'undefined': return undefined;
    case 'bigint': return 1n;
    case 'cycle': { const a = {}; a.a = a; return a; }
    case 'date': return new Date();
    case 'flood': while (true) { console.log('x'.repeat(8192)); console.error('y'.repeat(8192)); }
    case 'oversize': return 'x'.repeat(1024 * 1024);
    case 'loop': writeFileSync('/tmp/runner-ready', 'ready'); while (true) {}
    case 'descendants': spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' }); process.on('SIGTERM',()=>{}); console.log('descendant-ready'); while(true) {}
    case 'isolation': {
      let readOnly = false; try { writeFileSync('/opt/runsett/write', 'x'); } catch { readOnly = true; }
      writeFileSync('/tmp/writable', 'yes');
      return { uid: process.getuid(), env: Object.keys(process.env), socket: existsSync('/var/run/docker.sock'), readOnly, credentials: Object.keys(context.credentials), secret: context.credentials.service, signal: context.signal.aborted };
    }
    case 'cancel': await new Promise(resolve => context.signal.addEventListener('abort', resolve, { once: true })); return 'aborted';
    default: return input;
  }
}
