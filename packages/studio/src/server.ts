import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StudioEngine, root, namespace } from './engine.js';
import { maxTestInputBytes, RequestError, uuid, type WorkflowDocument } from './model.js';
import { StudioStore } from './store.js';
import { StudioConnections } from './connections.js';
import { handleOAuthRoutes } from './oauth-routes.js';
import { StudioTriggers } from './triggers.js';

const port = Number(process.env.RUNSETT_STUDIO_PORT ?? 4310);
const data = process.env.RUNSETT_STUDIO_DIR ?? join(root, '.runsett/studio');
const assets = fileURLToPath(new URL('./public/', import.meta.url));
await mkdir(data, { recursive: true, mode: 0o700 });
const workspaceFile = join(data, 'workspace.sqlite');
const store = new StudioStore(workspaceFile);
store.seed();
const connections = new StudioConnections(join(data, 'connections.sqlite'));
const engine = new StudioEngine(store, connections);
const triggers = new StudioTriggers(workspaceFile, {
  getWorkflow: (id) => store.get(id),
  getSubmissionRevision: (id, requestId) => store.getSubmission('studio-' + id + '-' + requestId)?.revision,
  isAvailable: () => engine.status === 'online',
  run: (...args) => engine.run(...args),
});
const shutdownSignal = new AbortController();
const health = () => ({ status: engine.status, message: engine.message });

// A document can contain 24 source files, including JSON-escaped characters.
const documentBytes = 5 * 1024 * 1024;
async function body(req: IncomingMessage, limit = 256 * 1024) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json')
    throw new RequestError('Send a JSON document.', 415);
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > limit) throw new RequestError('This request is too large.', 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new RequestError('Invalid JSON.');
  }
}
function json(res: ServerResponse, status: number, result: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(result));
}
const app = createServer(async (req, res) => {
  try {
    const host = req.headers.host;
    if (host !== 'localhost:' + port && host !== '127.0.0.1:' + port)
      throw new RequestError('Use the local Studio address.', 403);
    const origin = 'http://' + host;
    const url = new URL(req.url ?? '/', origin);
    if (url.origin !== origin) throw new RequestError('Use the local Studio address.', 403);
    const callback = req.method === 'GET' && /^\/api\/oauth\/(slack|teams)\/callback$/.test(url.pathname);
    if (req.headers.origin && req.headers.origin !== origin && !callback)
      throw new RequestError('Use Studio to make this change.', 403);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    const path = url.pathname;
    const method = req.method;
    if (method === 'GET' && path === '/' && url.hostname === '127.0.0.1') {
      // Provider callbacks and the editor must share a browser cookie host.
      url.hostname = 'localhost';
      res.writeHead(302, { Location: url.href, 'Cache-Control': 'no-store' });
      return res.end();
    }
    if (await handleOAuthRoutes(req, res, url, connections.oauth, body, json)) return;
    const hook = /^\/hooks\/([^/]+)\/([A-Za-z0-9_-]{43})$/.exec(path);
    if (hook && uuid(hook[1]) && method === 'POST') {
      triggers.assertWebhook(hook[1], hook[2]!);
      const input = await body(req, maxTestInputBytes);
      return json(res, 202, await triggers.webhook(hook[1], hook[2]!, input, req.headers['idempotency-key']));
    }
    if (path === '/api/connections') {
      if (method === 'GET') return json(res, 200, connections.list());
      if (method === 'POST') return json(res, 201, connections.create(await body(req, 24 * 1024)));
    }
    if (path === '/api/workspace' && method === 'GET')
      return json(res, 200, { workflows: store.list(), engine: health(), namespace });
    if (path === '/api/engine' && method === 'GET') {
      await engine.checkConnection();
      return json(res, 200, health());
    }
    if (path === '/api/engine/retry' && method === 'POST') {
      await body(req);
      engine.start();
      return json(res, 202, health());
    }
    if (path === '/api/workflows' && method === 'POST')
      return json(res, 201, store.create(await body(req, documentBytes)));
    if ((path === '/api/javascript/test' || path === '/api/steps/test') && method === 'POST') {
      const controller = new AbortController();
      res.once('close', () => controller.abort());
      const result = await engine.testStep(
        await body(req, maxTestInputBytes + 256 * 1024),
        AbortSignal.any([controller.signal, shutdownSignal.signal]),
        path === '/api/steps/test',
      );
      if (!res.destroyed) json(res, 200, result);
      return;
    }
    const output = /^\/api\/workflows\/([^/]+)\/steps\/([A-Za-z0-9_-]{1,64})\/(last-output|output)$/.exec(
      path,
    );
    if (output && uuid(output[1]) && method === 'GET') {
      let selected;
      if (output[3] === 'output') {
        const id = url.searchParams.get('executionId'),
          runId = url.searchParams.get('runId');
        if (!id || id.length > 1024 || !uuid(runId)) throw new RequestError('Choose a valid recorded run.');
        selected = { id, runId };
      }
      const controller = new AbortController();
      res.once('close', () => controller.abort());
      const result = await engine.previousOutput(output[1], output[2]!, controller.signal, selected);
      if (!res.destroyed) json(res, 200, result);
      return;
    }
    const workflow = /^\/api\/workflows\/([^/]+)(\/runs|\/run-options|\/triggers)?$/.exec(path);
    if (workflow && uuid(workflow[1])) {
      const id = workflow[1];
      if (workflow[2] === '/triggers') {
        if (method === 'GET') return json(res, 200, triggers.get(id));
        if (method === 'PUT') return json(res, 200, triggers.update(id, await body(req, 4096)));
      }
      if (workflow[2] === '/run-options' && method === 'GET')
        return json(res, 200, await engine.history(id, true));
      if (!workflow[2] && method === 'PUT') {
        const input = (await body(req, documentBytes)) as { revision: number; document: WorkflowDocument };
        if (!Number.isSafeInteger(input?.revision)) throw new RequestError('A saved revision is required.');
        return json(res, 200, store.save(id, input.revision, input.document));
      }
      if (workflow[2] === '/runs' && method === 'POST') {
        const input = await body(req, maxTestInputBytes + 256 * 1024);
        if (!input || !uuid(input.requestId)) throw new RequestError('A run request ID is required.');
        return json(res, 202, await engine.run(id, input.revision, input.requestId, input.testInput));
      }
    }
    if (path === '/api/runs' && method === 'GET') {
      const id = url.searchParams.get('workflow');
      if (id !== null && !uuid(id)) throw new RequestError('Unknown workflow.');
      return json(res, 200, await engine.history(id ?? undefined));
    }
    const run = /^\/api\/runs\/([^/]{1,1024})(\/cancel)?$/.exec(path);
    if (run) {
      let id: string;
      try {
        id = decodeURIComponent(run[1]!);
      } catch {
        throw new RequestError('Invalid run ID.');
      }
      if (!run[2] && method === 'GET')
        return json(res, 200, await engine.inspect(id, url.searchParams.get('logs') === '1'));
      if (run[2] && method === 'POST') {
        await body(req);
        await engine.cancel(id);
        return json(res, 202, { requested: true });
      }
    }
    if (method === 'GET' && path === '/') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      return res.end(await readFile(join(assets, 'index.html')));
    }
    const asset = /^\/assets\/([A-Za-z0-9_-]+\.(js|css|woff2|svg))$/.exec(path);
    if (method === 'GET' && asset) {
      const types: Record<string, string> = {
        js: 'text/javascript',
        css: 'text/css',
        woff2: 'font/woff2',
        svg: 'image/svg+xml',
      };
      res.setHeader('Content-Type', types[asset[2]!]!);
      try {
        return res.end(await readFile(join(assets, asset[1]!)));
      } catch {
        /* 404 below */
      }
    }
    throw new RequestError('Not found.', 404);
  } catch (error) {
    if (res.destroyed) return;
    if (!(error instanceof RequestError)) console.error('Studio request:', error);
    json(res, error instanceof RequestError ? error.status : 503, {
      error:
        error instanceof RequestError
          ? error.message
          : 'Could not reach the workflow engine. Check Docker and try again.',
    });
  }
});
app.listen(port, '127.0.0.1', () => {
  const url = 'http://localhost:' + port;
  console.log('Runsett Studio is open at ' + url);
  if (process.env.RUNSETT_OPEN_BROWSER === '1' && process.platform === 'darwin') {
    execFile('open', [url], (error) => {
      if (error) console.error('Open ' + url + ' in your browser.');
    });
  }
  engine.start();
  triggers.start();
});
let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  shutdownSignal.abort();
  const triggersStopped = triggers.close();
  app.close(() => {
    void triggersStopped
      .finally(() => engine.stop())
      .finally(() => {
        connections.close();
        store.close();
      })
      .catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
  });
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
