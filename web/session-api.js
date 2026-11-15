import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { actions } from './actions.js';
import { fileStorage } from './file-storage.js';
import { fileRecords } from './file-records.js';

export function json(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(payload));
}

export async function createSessionApi({ root, domain, storage, transactions }) {
  const dataDir = resolve(storage.resolveDataDirectory(root));
  await Promise.all(storage.dataFolders.map(folder => mkdir(resolve(dataDir, folder), { recursive: true })));
  let transactionRevision = 0;
  const files = fileStorage(dataDir, transactions, () => { transactionRevision += 1; });
  const session = domain.createSession({ storage: files });
  let pending = Promise.resolve();
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
    if (![...actions, 'exportFiles', 'importFiles', 'pendingTransactions', 'archiveTransactions', 'integrateTransactions'].includes(input?.action) || !Array.isArray(input.args)) {
      return json(response, 400, { error: 'Action invalide.' });
    }
    try {
      const task = pending.then(async () => {
        const revision = transactionRevision;
        const result = await performAction();
        if (revision !== transactionRevision) response.setHeader('X-Epi-Transactions', 'pending');
        return result;
      });
      pending = task.catch(() => {});
      return json(response, 200, await task);

      async function performAction() {
        if (input.action === 'pendingTransactions') return files.pendingTransactions();
        if (input.action === 'archiveTransactions') {
          if (!Array.isArray(input.args[0])) throw new Error('Liste de transactions invalide.');
          await files.archiveTransactions(input.args[0]);
          return {};
        }
        if (input.action === 'integrateTransactions') {
          if (!Array.isArray(input.args[0])) throw new Error('Liste de transactions invalide.');
          const { uuids, changed } = files.integrateTransactions(input.args[0]);
          return { uuids, state: changed ? await session.reload() : undefined };
        }
        if (input.action === 'exportFiles') return { files: await files.exportFiles() };
        if (input.action === 'importFiles') {
          if (!Array.isArray(input.args[0])) throw new Error('Liste de fichiers invalide.');
          const archive = input.args[0];
          const validator = domain.createSession({ storage: { load: () => null, save: () => {} } });
          await validator.importLegacy(fileRecords(archive));
          const added = await files.importFiles(archive);
          return { added, state: await session.reload() };
        }
        return session[input.action](...input.args);
      }
    } catch (error) {
      return json(response, 400, { error: error.message });
    }
  }

  return { dataDir, handleAction };
}
