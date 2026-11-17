import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
export interface Receipt { key: string; tag: string; attempt: number; acceptedAt: number; duplicate: boolean }
/** Real HTTP receiver: commits the operation before optionally withholding its response.
 * Idempotency storage belongs to this receiver, independently of the worker process.
 */
export async function createReceiver(gateway: string) {
  const healthToken = randomUUID();
  const attempts: Receipt[] = []; const operations = new Map<string, Receipt>();
  const held = new Map<ServerResponse, Receipt>(); let peakHeld = 0;
  const server = createServer(async (request, response) => {
    if (request.url === `/health/${healthToken}`) { response.end(healthToken); return; }
    try {
      let body = ''; for await (const chunk of request) { body += chunk; if (body.length > 4096) throw new Error('Request too large'); }
      const value = JSON.parse(body);
      const receipt = { key: String(value.key), tag: String(value.tag), attempt: Number(value.attempt), acceptedAt: Date.now(), duplicate: operations.has(value.key) };
      attempts.push(receipt);
      if (!receipt.duplicate) operations.set(receipt.key, receipt);
      response.setHeader('content-type', 'application/json');
      if ((value.hold && !receipt.duplicate) || value.holdAttempt === receipt.attempt) { held.set(response, receipt); peakHeld = Math.max(peakHeld, held.size); response.on('close', () => held.delete(response)); }
      else response.end(JSON.stringify({ accepted: true, duplicate: receipt.duplicate }));
    } catch { response.writeHead(400).end(); }
  });
  server.listen(0, '0.0.0.0'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Receiver address missing');
  function release(tag?: string) { for (const [response, receipt] of held) if (!tag || receipt.tag === tag) { held.delete(response); response.end(JSON.stringify({ accepted: true, duplicate: receipt.duplicate })); } }
  return { port: address.port, healthToken, url: `http://${gateway}:${address.port}`, attempts, operations, release, get peakHeld() { return peakHeld; }, get held() { return held.size; },
    async close() { release(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}
