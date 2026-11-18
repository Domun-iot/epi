import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createHostedProxy } from './hosted-proxy.js';

async function listen(server, t) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return server.address().port;
}

test('hosted proxy uses the configured upstream port and keeps API and mutation routes local', async t => {
  const requests = [];
  const upstream = createServer((request, response) => {
    requests.push({ method: request.method, path: request.url, host: request.headers.host });
    response.writeHead(200, { 'Content-Type': 'text/plain' });
    response.end('hosted client');
  });
  const upstreamPort = await listen(upstream, t);
  const previous = process.env.EPI_WEB_PORT;
  process.env.EPI_WEB_PORT = String(upstreamPort);
  t.after(() => {
    if (previous === undefined) delete process.env.EPI_WEB_PORT;
    else process.env.EPI_WEB_PORT = previous;
  });
  const proxy = createHostedProxy();
  const front = createServer(async (request, response) => {
    if (!await proxy(request, response)) response.writeHead(404).end();
  });
  const origin = 'http://127.0.0.1:' + await listen(front, t);
  assert.equal(await (await fetch(origin + '/assets/client.js?v=2')).text(), 'hosted client');
  assert.equal((await fetch(origin + '/index.html', { method: 'HEAD' })).status, 200);
  for (const path of ['/v1/account', '/api/session']) {
    assert.equal((await fetch(origin + path)).status, 404);
  }
  assert.equal((await fetch(origin + '/index.html', { method: 'POST' })).status, 404);
  assert.deepEqual(requests, [
    { method: 'GET', path: '/assets/client.js?v=2', host: '127.0.0.1:' + upstreamPort },
    { method: 'HEAD', path: '/index.html', host: '127.0.0.1:' + upstreamPort },
  ]);
});

test('hosted proxy rejects invalid port configuration before handling a request', () => {
  for (const port of [NaN, 0, -1, 65536, 1.5, '3001']) {
    assert.throws(() => createHostedProxy({ port }), /Invalid EPI_WEB_PORT/);
  }
});
