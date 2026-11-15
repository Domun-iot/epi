import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { actions } from './actions.js';
import { fileStorage } from './file-storage.js';

export function json(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(payload));
}

export async function createSessionApi({ root, domain, storage }) {
  const dataDir = resolve(storage.resolveDataDirectory(root));
  await Promise.all(storage.dataFolders.map(folder => mkdir(resolve(dataDir, folder), { recursive: true })));
  const session = domain.createSession({ storage: fileStorage(dataDir) });
  await session.load();

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

  return { dataDir, handleAction };
}
