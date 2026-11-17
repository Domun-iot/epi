import { createHash } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
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
  const measurements = records.measurements;
  let first = Infinity;
  let last = -Infinity;
  for (const row of measurements) {
    const time = Date.parse(row.receivedAt);
    if (Number.isFinite(time)) { first = Math.min(first, time); last = Math.max(last, time); }
  }
  return { count: measurements.length, from: Number.isFinite(first) ? new Date(first).toISOString() : null,
    to: Number.isFinite(last) ? new Date(last).toISOString() : null,
    hasData: Boolean(records.profiles.length || records.devices.length || measurements.length) };
}

export function createHostedApi({ dataRoot, store, now = Date.now }) {
  dataRoot = resolve(dataRoot);
  const accounts = new Map();

  async function synchronize(entry, context) {
    const rows = store.allTransactions(context.accountNumber).map(materializedRow).filter(Boolean);
    const result = transactions.integrateTransactions(entry.dataDir, rows);
    if (result.uuids.length !== rows.length) throw failure(503, 'dataset_recovery_required');
    await entry.api.session.reload();
    if (context.paidUntil > now()) await publish(entry, context);
  }

  async function publish(entry, context) {
    const pending = (await entry.api.files.pendingTransactions()).filter(row => row.transaction);
    for (let offset = 0; offset < pending.length; offset += 100) {
      const batch = pending.slice(offset, offset + 100);
      context.checkActive();
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
      async afterAction() {
        created.current.checkActive();
        if (created.current.paidUntil > now()) await publish(created, created.current);
      },
    });
    accounts.set(context.accountId, created);
    return created;
  }

  // Installing the promise immediately also serializes simultaneous first requests.
  const opening = new Map();
  async function run(context, callback) {
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
      await synchronize(entry, context);
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
    async session(request, response, context) {
      return run(context, entry => {
        response.setHeader('X-Epi-Dataset', context.accountId);
        return entry.api.handleAction(request, response);
      });
    },
    async snapshot(context, summaryOnly = false) {
      return run(context, async entry => {
        const files = await snapshotFiles(entry);
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
