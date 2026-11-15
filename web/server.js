import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import config from './config.js';
import { createSessionApi, json } from './session-api.js';
import domain from './tauri/domain/session.cjs';
import storage from './shared/data-directory.cjs';

const root = dirname(fileURLToPath(import.meta.url));
const { dataDir, handleAction } = await createSessionApi({ root, config, domain, storage });
const types = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
]);
const local = ['localhost', '127.0.0.1', '::1'].includes(config.host);

async function handle(request, response) {
  if (local && !/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(request.headers.host ?? '')) {
    return json(response, 403, { error: 'Hôte non autorisé.' });
  }
  const { pathname } = new URL(request.url, 'http://localhost');
  if (pathname === '/api/session') return handleAction(request, response);
  const file = pathname === '/' ? '/index.html' : pathname;
  const type = types.get(extname(file));
  if (!['GET', 'HEAD'].includes(request.method) || !type
      || (file !== '/index.html' && !/^\/assets\/[\w.-]+$/.test(file))) {
    return json(response, 404, { error: 'Page introuvable.' });
  }
  let bytes;
  try {
    bytes = await readFile(resolve(root, 'public', '.' + file));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return json(response, 404, { error: 'Page introuvable.' });
  }
  response.writeHead(200, {
    'Content-Type': type, 'Content-Length': bytes.length, 'Cache-Control': 'no-cache',
  });
  response.end(request.method === 'HEAD' ? undefined : bytes);
}

const server = createServer((request, response) => {
  handle(request, response).catch(error => {
    console.error(error);
    if (!response.headersSent) json(response, 500, { error: 'Erreur du serveur.' });
    else response.destroy();
  });
});
server.listen(config.port, config.host, () => {
  const { address, port, family } = server.address();
  console.log(`éPI Web · http://${family === 'IPv6' ? '[' + address + ']' : address}:${port}`);
  console.log(`Stockage · ${dataDir}`);
});
