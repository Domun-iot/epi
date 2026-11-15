import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { actions } from './actions.js';
import { fileRecords, recordPath } from './file-records.js';

export function json(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(payload));
}

async function readDataset(dataDir, dataFolders) {
  async function collect(folder, includeSubfolders) {
    let entries;
    try {
      entries = await readdir(resolve(dataDir, folder), { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    const files = [];
    for (const entry of entries) {
      const path = folder + '/' + entry.name;
      if (includeSubfolders && entry.isDirectory()) {
        files.push(...await collect(path, false));
      } else if (entry.isFile() && recordPath.test(path)) {
        files.push({ path, contents: await readFile(resolve(dataDir, path), 'utf8') });
      }
    }
    return files;
  }

  const files = await Promise.all(dataFolders.map(folder => collect(folder, folder === 'measures')));
  return fileRecords(files.flat());
}

export async function createSessionApi({ root, config, domain, storage }) {
  const selection = config.dataDir?.trim() ? null : storage.resolveDataDirectory(root);
  const dataDir = selection ? resolve(selection.directory) : resolve(root, config.dataDir);
  const snapshot = resolve(dataDir, 'session.json');
  const temporary = resolve(dataDir, `session-${process.pid}.tmp`);
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
          return readDataset(dataDir, storage.dataFolders);
        }
      },
      async save(state) {
        await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
        await rename(temporary, snapshot);
      },
    },
  });
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
