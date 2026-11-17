import { createSessionApi, json } from './session-api.js';
import { fileStorage } from './file-storage.js';
import { fileRecords } from './file-records.js';
import { accountApi } from './account-api.js';
import { createRequire } from 'node:module';
const accounts = createRequire(import.meta.url)('../shared/account-storage.cjs');
const { withInstallationLock } = createRequire(import.meta.url)('../shared/installation-lock.cjs');

export function createLocalApi({ root, domain, storage, transactions, verifyAccount, readPaidUntil }) {
  const installationRoot = storage.resolveDataDirectory(root);
  let pending = Promise.resolve();
  const sessions = new Map();
  const serialize = task => {
    const next = pending.then(task);
    pending = next.catch(() => {});
    return next;
  };
  const verify = verifyAccount ?? (async token => {
    const response = await fetch(accountApi + '/v1/account', {
      headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw Object.assign(new Error('Sign-in required.'), { status: response.status });
    return response.json();
  });
  const verifiedTokens = new Map();
  async function paidForDataset(token, accountId, refresh) {
    if (!token || !accountId) return 0;
    const cached = verifiedTokens.get(token);
    let info = cached?.info;
    if (refresh || !cached || Date.now() - cached.checkedAt >= 60000) {
      try {
        info = await verify(token);
        verifiedTokens.set(token, { info, checkedAt: Date.now() });
      } catch (error) {
        if (error.status === 401 || error.status === 403) {
          verifiedTokens.delete(token);
          return 0;
        }
      }
    }
    if (info?.accountId !== accountId || info.paid !== true) return 0;
    return Date.parse(info.paidUntil) || 0;
  }
  async function input(request) {
    if (request.method !== 'POST' || request.headers['content-type'] !== 'application/json') {
      throw Object.assign(new Error('POST JSON required.'), { status: 415 });
    }
    let size = 0;
    const chunks = [];
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 32 * 1024 * 1024) throw Object.assign(new Error('Request too large.'), { status: 413 });
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw Object.assign(new Error('Invalid JSON.'), { status: 400 }); }
  }
  async function session(request, response, body) {
    const context = accounts.getDatasetContext(installationRoot);
    if ((body.datasetId === undefined || body.datasetGeneration === undefined) && context.accountModeEnabled) {
      return json(response, 409, { error: 'dataset_changed' });
    }
    const dataDir = accounts.resolveActiveDataset(installationRoot, body.datasetId, body.datasetGeneration);
    let api = sessions.get(dataDir);
    if (!api) {
      api = await createSessionApi({ root, dataDir, domain, storage, transactions,
        readPaidUntil: async (token, refresh) => {
          const active = accounts.getDatasetContext(installationRoot);
          const paidUntil = await paidForDataset(token, active.activeAccountId, refresh);
          return readPaidUntil ? Math.min(paidUntil, await readPaidUntil(token, refresh)) : paidUntil;
        } });
      sessions.set(dataDir, api);
    }
    // Replay the already validated body into the reusable session handler.
    const { Readable } = await import('node:stream');
    const replay = Readable.from([Buffer.from(JSON.stringify(body))]);
    replay.method = 'POST'; replay.headers = request.headers;
    return api.handleAction(replay, response);
  }
  async function installation(request, response, body) {
    if (!Array.isArray(body?.args)) throw new Error('Invalid installation request.');
    const [accountId, mode, remoteFiles = [], syncReady, syncRevision] = body.args;
    let value;
    if (body.action === 'context') value = accounts.getDatasetContext(installationRoot);
    else if (body.action === 'logout') value = accounts.logoutDataset(installationRoot);
    else if (['prepare', 'activate', 'confirmSync'].includes(body.action)) {
      const token = /^Bearer (\S+)$/.exec(request.headers.authorization ?? '')?.[1];
      if (!token) throw Object.assign(new Error('Sign-in required.'), { status: 401 });
      const info = await verify(token);
      if (info.accountId !== accountId) throw Object.assign(new Error('Invalid account.'), { status: 403 });
      if (body.action === 'confirmSync') value = accounts.confirmDatasetSync(installationRoot, accountId, mode);
      else if (body.action === 'prepare') value = accounts.prepareAccountDataset(installationRoot, accountId);
      else {
        if (!Array.isArray(remoteFiles)) throw new Error('Invalid remote files.');
        if (remoteFiles.length && !(info.paid === true && Date.parse(info.paidUntil) > Date.now())) {
          throw Object.assign(new Error('PRO required.'), { status: 403 });
        }
        const prepared = accounts.prepareAccountDataset(installationRoot, accountId);
        const stage = accounts.stageAccountDataset(installationRoot, accountId, mode, syncReady, syncRevision);
        try {
          if (remoteFiles.length) {
            await domain.createSession({ storage: { load: () => null, save: () => {} } }).importLegacy(fileRecords(remoteFiles));
            await fileStorage(stage.root, transactions).importFiles(remoteFiles);
          }
          if (mode === 'merge') {
            if (prepared.accountExists) accounts.mergeAccountIntoStage(installationRoot, accountId, stage.root);
            else accounts.mergeAnonymousIntoStage(installationRoot, stage.root);
          }
          value = stage.commit();
          sessions.clear();
        } catch (error) { stage.abort(); throw error; }
      }
    } else throw new Error('Unknown installation action.');
    return json(response, 200, value);
  }
  return {
    installationRoot,
    handle(request, response, pathname) {
      return serialize(async () => {
        try {
          const body = await input(request);
          return await withInstallationLock(installationRoot, async () => {
            if (pathname === '/api/installation') return await installation(request, response, body);
            return await session(request, response, body);
          });
        } catch (error) {
          if (response.headersSent) throw error;
          return json(response, error.status ?? (error.code === 'dataset_locked' ? 401 : error.code === 'dataset_changed' ? 409 : 400),
            { error: error.code ?? error.message });
        }
      });
    },
  };
}
