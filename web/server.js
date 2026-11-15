import { createServer } from 'node:http';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import config from './config.js';
import { actions } from './actions.js';
import domain from './tauri/domain/session.cjs';
import storage from './shared/data-directory.cjs';

const root = dirname(fileURLToPath(import.meta.url));
const selection = config.dataDir?.trim() ? null : storage.resolveDataDirectory(root);
const dataDir = selection ? resolve(selection.directory) : resolve(root, config.dataDir);
const snapshot = resolve(dataDir, 'session.json');
const temporary = resolve(dataDir, `session-${process.pid}.tmp`);
const types = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
]);
const local = ['localhost', '127.0.0.1', '::1'].includes(config.host);

await mkdir(dataDir, { recursive: true });
if (selection && !selection.shared) {
  await Promise.all(storage.dataFolders.map(folder => mkdir(resolve(dataDir, folder), { recursive: true })));
}
const session = domain.createSession({
  storage: {
    async load() {
      try {
        return JSON.parse(await readFile(snapshot, 'utf8'));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        return null;
      }
    },
    async save(state) {
      await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
      await rename(temporary, snapshot);
    },
  },
});
await session.load();

function json(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(payload));
}

async function handleAction(request, response) {
  if (request.method !== 'POST' || request.headers['content-type'] !== 'application/json') {
    return json(response, 415, { error: 'Une requête POST JSON est requise.' });
  }

  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 32 * 1024 * 1024) {
      json(response, 413, { error: 'Requête trop volumineuse.' });
      return;
    }
    chunks.push(chunk);
  }
  let input;
  try {
    input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return json(response, 400, { error: 'JSON invalide.' });
  }
  if (!actions.includes(input?.action) || !Array.isArray(input.args)) {
    return json(response, 400, { error: 'Action invalide.' });
  }
  try {
    const state = await session[input.action](...input.args);
    return json(response, 200, state);
  } catch (error) {
    return json(response, 400, { error: error.message });
  }
}

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
