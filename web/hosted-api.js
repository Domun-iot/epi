import { createHash } from 'node:crypto';
import { mkdir, rm, lstat, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import domain from '../tauri/domain/session.cjs';
import transactions from '../shared/transactions.cjs';
import { createSessionApi } from './session-api.js';
import { fileRecords } from './file-records.js';

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const privateActions = new Set(['pendingTransactions', 'archiveTransactions', 'integrateTransactions']);
function failure(status, code) {
  return Object.assign(new Error(code), { status, code });
}

export function accountUuid(id) {
  if (!/^[a-f0-9]{32}$/u.test(id)) throw new Error('Invalid account identity');
  return id.slice(0, 8) + '-' + id.slice(8, 12) + '-' + id.slice(12, 16) + '-' + id.slice(16, 20) + '-' + id.slice(20);
}

function materializedRow({ payload }) {
  const row = JSON.parse(payload);
  if (!['create', 'update', 'delete', 'batch'].includes(row.type)) return undefined;
  // A sequence number cannot recover the time of an old deletion safely.
  if (row.name === undefined) throw failure(503, 'dataset_recovery_required');
  return row;
}

function summary(files) {
  const records = fileRecords(files);
  const measurements = [...new Map(records.measurements.map((row, index) => [row.uuid ?? index, row])).values()];
  const preferences = files.find(file => file.path === 'prefs/global.json')
    ?? files.find(file => file.path === 'interface.json') ?? files.find(file => file.path === 'session.json');
  const pending = preferences ? JSON.parse(preferences.contents.replace(/^\uFEFF/u, ''))?.pending : undefined;
  let first = Infinity;
  let last = -Infinity;
  for (const row of measurements) {
    const time = Date.parse(row.receivedAt);
    if (Number.isFinite(time)) { first = Math.min(first, time); last = Math.max(last, time); }
  }
  return { count: measurements.length, from: Number.isFinite(first) ? new Date(first).toISOString() : null,
    to: Number.isFinite(last) ? new Date(last).toISOString() : null,
    hasData: Boolean(records.profiles.length || records.devices.length || measurements.length
      || (Array.isArray(pending) && pending.length)) };
}

async function ensureDatasetTree(root) {
  const metadata = await lstat(root);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw failure(409, 'invalid_dataset_path');
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw failure(409, 'invalid_dataset_path');
    if (entry.isDirectory()) await ensureDatasetTree(join(root, entry.name));
  }
}

export function createHostedApi({ dataRoot, store, now = Date.now }) {
  dataRoot = resolve(dataRoot);
  const accounts = new Map();

  async function synchronize(entry, context, allowDeferred = false) {
    const rows = store.allTransactions(context.accountNumber).map(materializedRow).filter(Boolean);
    const result = transactions.integrateTransactions(entry.dataDir, rows);
    if (result.uuids.length !== rows.length) throw failure(503, 'dataset_recovery_required');
    await entry.api.session.reload();
    if (context.paidUntil > now()) await tryPublish(entry, context, allowDeferred);
  }

  async function tryPublish(entry, context, allowDeferred) {
    try {
      await publish(entry, context);
      entry.publicationDeferred = false;
    } catch (error) {
      if (error.status === 401 || error.status === 403) throw error;
      if (!allowDeferred) throw failure(503, 'storage_saved_sync_pending');
      entry.publicationDeferred = true;
    }
  }

  async function publish(entry, context) {
    const pending = (await entry.api.files.pendingTransactions()).filter(row => row.transaction);
    for (let offset = 0; offset < pending.length; offset += 100) {
      const batch = pending.slice(offset, offset + 100);
      context.checkActive();
      if (!(context.paidUntil > now())) throw failure(403, 'pro_required');
      const result = store.uploadServer(context.accountNumber, batch.map(({ name, transaction }) => ({
        uuid: transaction.uuid, payload: JSON.stringify({ ...transaction, name }),
      })));
      const accepted = new Set(result.uuids);
      await entry.api.files.archiveTransactions(batch.filter(row => accepted.has(row.transaction.uuid)).map(row => row.name));
    }
  }

  async function prepare(context) {
    if (!uuid.test(context.accountId)) throw failure(401, 'invalid_token');
    const entry = accounts.get(context.accountId);
    if (entry) return entry;
    const dataDir = join(dataRoot, 'accounts', context.accountId);
    transactions.ensureNoSymlinks(dataRoot, 'accounts/' + context.accountId);
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    await ensureDatasetTree(dataDir);
    const created = { dataDir, queue: Promise.resolve(), current: context };
    created.api = await createSessionApi({
      root: dataRoot, dataDir, domain, transactions,
      storage: { dataFolders: ['devices', 'measures', 'profiles'] }, now,
      readPaidUntil: async () => created.current.paidUntil,
      beforeAction(request, input) {
        created.current.checkActive();
        if (input.datasetId !== undefined && input.datasetId !== created.current.accountId) {
          throw failure(409, 'dataset_changed');
        }
        if (privateActions.has(input.action)) throw failure(403, 'hosted_action_forbidden');
      },
      async afterAction(request, input, result, response) {
        created.current.checkActive();
        if (created.current.paidUntil > now()) await tryPublish(created, created.current, true);
        if (created.publicationDeferred) response.setHeader('X-Epi-Sync', 'pending');
      },
    });
    accounts.set(context.accountId, created);
    return created;
  }

  // Installing the promise immediately also serializes simultaneous first requests.
  const opening = new Map();
  async function run(context, callback, allowDeferred = false) {
    let entryPromise = opening.get(context.accountId);
    if (!entryPromise) {
      entryPromise = prepare(context);
      opening.set(context.accountId, entryPromise);
      entryPromise.catch(() => opening.delete(context.accountId));
    }
    const entry = await entryPromise;
    const task = entry.queue.then(async () => {
      context.checkActive();
      entry.current = context;
      await ensureDatasetTree(entry.dataDir);
      await synchronize(entry, context, allowDeferred);
      return callback(entry);
    });
    entry.queue = task.catch(() => {});
    return task;
  }

  async function snapshotFiles(entry) {
    return (await entry.api.files.exportFiles()).sort((a, b) => a.path.localeCompare(b.path));
  }
  function revision(files) {
    return createHash('sha256').update(JSON.stringify(files)).digest('hex');
  }

  return {
    async flush(context) {
      return run(context, () => { context.checkActive(); });
    },
    async session(request, response, context) {
      return run(context, entry => {
        response.setHeader('X-Epi-Dataset', context.accountId);
        return entry.api.handleAction(request, response);
      }, true);
    },
    async snapshot(context, summaryOnly = false) {
      return run(context, async entry => {
        const files = await snapshotFiles(entry);
        context.checkActive();
        return { accountId: context.accountId, summary: summary(files), revision: revision(files), ...(!summaryOnly && { files }) };
      });
    },
    async upload(context, rows, expectedRevision) {
      return run(context, async entry => {
        if (expectedRevision !== undefined && expectedRevision !== revision(await snapshotFiles(entry))) {
          throw failure(409, 'dataset_changed');
        }
        context.checkActive();
        for (const row of rows) {
          try { transactions.validateTransaction(entry.dataDir, materializedRow({ sequence: 0, payload: row.payload })); }
          catch { throw failure(400, 'invalid_transaction'); }
        }
        const result = store.upload(context.accountNumber, context.deviceId, rows);
        await synchronize(entry, context);
        return result;
      });
    },
    async purge(ids) {
      for (const id of ids) {
        const accountId = accountUuid(id);
        if (store.hasAccountIdentity(id)) continue;
        const pending = opening.get(accountId);
        const entry = pending && await pending;
        await entry?.queue;
        transactions.ensureNoSymlinks(dataRoot, 'accounts/' + accountId);
        await rm(join(dataRoot, 'accounts', accountId), { recursive: true, force: true });
        opening.delete(accountId);
        accounts.delete(accountId);
      }
    },
  };
}
