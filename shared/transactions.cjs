'use strict';

const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const { dirname, join } = require('node:path');
const { transactionIndex, uuidPattern } = require('./transaction-index.cjs');
const { isNewer, sameContent, versionDate } = require('./record-version.cjs');

const filename = /^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.\d{6}Z-[0-9a-f-]{36}\.json$/u;
const unsafeName = /^(?:\.|(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$))|[. ]$|[\\:*?"<>|\p{Cc}]/iu;
let lastStamp = 0;

function readOptional(path) {
  try { return fs.readFileSync(path, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function parse(contents) {
  return JSON.parse(contents.replace(/^\uFEFF/u, ''));
}

function serialize(value) {
  return JSON.stringify(value, null, 2) + '\n';
}

function write(path, contents, replace = true) {
  if (contents === undefined) return fs.rmSync(path, { force: true });
  fs.mkdirSync(dirname(path), { recursive: true });
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temporary, contents, { flag: 'wx', mode: 0o600, flush: true });
    if (replace) fs.renameSync(temporary, path);
    else fs.linkSync(temporary, path);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function recordTransaction(root, changes) {
  if (!changes.length) return;
  const uuid = randomUUID();
  const operations = changes.map(({ path, before, after }) => ({
    type: after === undefined ? 'delete' : before === undefined ? 'create' : 'update',
    path,
    value: after === undefined ? undefined : parse(after),
  }));
  const [{ type, path, value }] = operations;
  const transaction = operations.length === 1 ? { uuid, type, data: { path, value } }
    : { uuid, type: 'batch', data: operations };
  lastStamp = Math.max(Date.now() * 1000, lastStamp + 1);
  const stamp = new Date(Math.floor(lastStamp / 1000)).toISOString()
    .replace('Z', String(lastStamp % 1000).padStart(3, '0') + 'Z').replaceAll(':', '-');
  const archive = join(root, 'transactions', stamp + '-' + uuid + '.json');
  write(archive, serialize(transaction), false);
  try { transactionIndex(root).add(uuid); }
  catch (error) { fs.rmSync(archive); throw error; }
}

function applyChanges(root, changes, finish) {
  const applied = [];
  try {
    for (const { path, before, after } of changes) {
      const target = join(root, path);
      if (before !== undefined && readOptional(target) !== before) throw new Error('Fichier modifié · ' + path);
      write(target, after, before !== undefined);
      applied.push({ target, before, after });
    }
    finish();
  } catch (error) {
    const rollback = [];
    for (const { target, before, after } of applied.reverse()) {
      try {
        if (readOptional(target) !== after) throw new Error('Fichier modifié · ' + target);
        write(target, before);
      } catch (failure) { rollback.push(failure); }
    }
    if (rollback.length) throw new AggregateError([error, ...rollback], error.message + ' · Restauration incomplète.');
    throw error;
  }
}

function saveChanges(root, changes) {
  const resolved = changes.map(change => {
    if (change.before === undefined || change.after === undefined) return change;
    const current = readOptional(join(root, change.path));
    return current !== undefined && current !== change.before && isNewer(parse(change.after), parse(current))
      ? { ...change, before: current } : change;
  }).filter(change => change.before !== change.after);
  applyChanges(root, resolved, () => recordTransaction(root, resolved));
}

function validateChange(root, change) {
  if (typeof change?.path !== 'string') throw new Error('Chemin de transaction invalide.');
  const parts = change.path.split('/');
  const [folder, name, file] = parts;
  const jsonFile = part => part?.endsWith('.json') && part.length > 5;
  const valid = ['profiles', 'devices', 'notifications'].includes(folder)
    ? parts.length === 2 && jsonFile(name)
    : (parts.length === 3 && jsonFile(file) &&
      (folder === 'measures' || (folder === 'prefs' && ['measurements', 'measurement-details'].includes(name)))) ||
      (folder === 'prefs' && parts.length === 2 && (name === 'global.json' || /^profil[-~].+\.json$/u.test(name))) || ['interface.json', 'session.json'].includes(change.path);
  if (!valid || parts.some(part => !part || unsafeName.test(part))) {
    throw new Error('Chemin de transaction invalide.');
  }
  if (!['create', 'update', 'delete'].includes(change.type) ||
      (change.type === 'delete' ? Object.hasOwn(change, 'value') : !Object.hasOwn(change, 'value'))) {
    throw new Error('Opération de transaction invalide.');
  }
  ensureNoSymlinks(root, change.path);
}

function ensureNoSymlinks(root, relative) {
  let path = root;
  for (const part of relative.split('/')) {
    path = join(path, part);
    if (fs.lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error('Lien symbolique inattendu dans une transaction.');
    }
  }
}

function archiveUuid(name, contents) {
  const { uuid } = parse(contents);
  if (typeof uuid !== 'string' || !uuidPattern.test(uuid) || !filename.test(name) || !name.endsWith('-' + uuid + '.json')) {
    throw new Error('UUID de transaction invalide · ' + name);
  }
  return uuid;
}

function prepareHistory(entries) {
  const ids = new Set();
  const archives = [];
  for (const { path, contents } of entries) {
    if (path === 'transactions.index') {
      for (const uuid of contents.split(/\r?\n/u).filter(Boolean)) {
        if (!uuidPattern.test(uuid)) throw new Error('Index de transactions invalide.');
        ids.add(uuid);
      }
    } else {
      const uuid = archiveUuid(path.split('/').at(-1), contents);
      const completed = !path.startsWith('transactions.incoming/');
      if (completed) ids.add(uuid);
      archives.push({ path, contents, completed, uuid });
    }
  }
  return { ids, archives };
}

function importHistory(root, { ids, archives }) {
  ensureNoSymlinks(root, 'transactions.index');
  const index = transactionIndex(root);
  let added = 0;
  for (const { path, contents, completed, uuid } of archives) {
    if (!completed && (ids.has(uuid) || index.has(uuid))) continue;
    const target = join(root, path);
    if (readOptional(target) !== undefined) continue;
    write(target, contents, false);
    added++;
  }
  for (const uuid of ids) {
    if (!index.has(uuid)) index.add(uuid);
  }
  return added;
}

function transactionTime(name) {
  return versionDate({ updatedAt: name.slice(0, 27).replace(/T(\d\d)-(\d\d)-(\d\d)/u, 'T$1:$2:$3') });
}

function rememberDeletions(root, tombstones, { type, data }, name) {
  const time = transactionTime(name);
  if (!time) return;
  const operations = type === 'batch' ? data : [{ ...data, type }];
  if (!Array.isArray(operations)) return;
  for (const operation of operations) {
    if (operation?.type !== 'delete') continue;
    try { validateChange(root, operation); } catch { continue; }
    const key = operation.path.toLowerCase();
    if (!tombstones.has(key) || time > tombstones.get(key)) tombstones.set(key, time);
  }
}

// The durable journal is the deletion index; snapshots already carry these archives.
function transactionTombstones(root) {
  const tombstones = new Map();
  for (const folder of ['transactions', 'transactions.sent']) {
    ensureNoSymlinks(root, folder);
    const directory = join(root, folder);
    if (!fs.existsSync(directory)) continue;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !filename.test(entry.name)) continue;
      try {
        const contents = readOptional(join(directory, entry.name));
        if (contents !== undefined) rememberDeletions(root, tombstones, parse(contents), entry.name);
      } catch { /* An unreadable archive must not block recovery of the other entries. */ }
    }
  }
  return tombstones;
}

function transactionChanges(root, { type, data }, name, tombstones = transactionTombstones(root)) {
  const operations = type === 'batch' ? data : [{ ...data, type }];
  if (!Array.isArray(operations) || !operations.length) throw new Error('Transaction vide ou invalide · ' + name);
  const paths = new Set();
  return operations.map(change => {
    validateChange(root, change);
    const key = change.path.toLowerCase();
    if (paths.has(key)) throw new Error('Chemin répété dans la transaction · ' + name);
    paths.add(key);
    const before = readOptional(join(root, change.path));
    const time = change.type === 'delete' ? transactionTime(name) : versionDate(change.value) ?? transactionTime(name);
    const deletion = tombstones.get(key);
    if (change.type !== 'delete' && deletion && (!time || time <= deletion)) return null;
    if (before !== undefined) {
      const current = parse(before);
      const candidate = change.type === 'delete' ? undefined : change.value;
      if (sameContent(candidate, current) || (versionDate(current) && !isNewer({ updatedAt: time }, current))) {
        return null;
      }
    }
    return { path: change.path, before, after: change.type === 'delete' ? undefined : serialize(change.value) };
  }).filter(change => change && (change.before !== undefined || change.after !== undefined));
}

function validateTransaction(root, row) {
  if (typeof row?.uuid !== 'string' || !uuidPattern.test(row.uuid) || typeof row.name !== 'string' ||
      !filename.test(row.name) || !row.name.endsWith('-' + row.uuid + '.json')) throw new Error('Transaction invalide.');
  const operations = row.type === 'batch' ? row.data : [{ ...row.data, type: row.type }];
  if (!Array.isArray(operations) || operations.some(operation => operation?.type !== 'delete' &&
      (!operation?.value || typeof operation.value !== 'object' || Array.isArray(operation.value)))) {
    throw new Error('Valeur de transaction invalide.');
  }
  transactionChanges(root, row, row.name, new Map());
}

function integrateTransactions(root, rows) {
  const tombstones = transactionTombstones(root);
  const ids = new Set();
  for (const folder of ['transactions', 'transactions.sent']) {
    ensureNoSymlinks(root, folder);
    const directory = join(root, folder);
    if (!fs.existsSync(directory)) continue;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isFile() && filename.test(entry.name)) ids.add(entry.name.slice(28, -5));
    }
  }
  ensureNoSymlinks(root, 'transactions.index');
  const index = transactionIndex(root);
  const acknowledged = new Set();
  let changed = false;
  for (const row of rows) {
    if (typeof row?.uuid !== 'string' || !uuidPattern.test(row.uuid)) continue;
    const { name, ...transaction } = row;
    if (ids.has(row.uuid) || index.has(row.uuid)) {
      acknowledged.add(row.uuid);
      continue;
    }
    try {
      if (typeof name !== 'string' || !filename.test(name) || !name.endsWith('-' + row.uuid + '.json')) continue;
      const changes = transactionChanges(root, transaction, name, tombstones);
      const destination = join(root, 'transactions.sent', name);
      applyChanges(root, changes, () => {
        write(destination, serialize(transaction), false);
        try { index.add(row.uuid); }
        catch (error) { fs.unlinkSync(destination); throw error; }
      });
      rememberDeletions(root, tombstones, transaction, name);
      ids.add(row.uuid);
      acknowledged.add(row.uuid);
      changed ||= changes.length > 0;
    } catch {
      // Leave this transaction unacknowledged and continue the batch.
    }
  }
  return { uuids: [...acknowledged], changed };
}

function replayTransactions(root) {
  const incoming = join(root, 'transactions.incoming');
  if (!fs.existsSync(incoming)) return 0;
  const lockPath = join(root, 'transactions.replay.lock');
  const lock = fs.openSync(lockPath, 'wx');
  try {
    return replayIncoming(root, incoming);
  } finally {
    fs.closeSync(lock);
    fs.unlinkSync(lockPath);
  }
}

function replayIncoming(root, incoming) {
  const entries = fs.readdirSync(incoming, { withFileTypes: true });
  const index = transactionIndex(root);
  const tombstones = transactionTombstones(root);
  let count = 0;
  for (const name of entries.filter(entry => entry.isFile() && filename.test(entry.name)).map(entry => entry.name).sort()) {
    const source = join(incoming, name);
    const contents = fs.readFileSync(source, 'utf8');
    const uuid = archiveUuid(name, contents);
    if (!index.has(uuid)) {
      const destination = join(root, 'transactions', name);
      const archived = readOptional(destination) ?? readOptional(join(root, 'transactions.sent', name));
      if (archived === undefined) {
        const changes = transactionChanges(root, parse(contents), name, tombstones);
        // Keep the incoming file until the archive and the index are both written.
        applyChanges(root, changes, () => write(destination, contents, false));
      } else if (archived !== contents) {
        throw new Error('Transaction archivée différente · ' + name);
      }
      index.add(uuid);
      rememberDeletions(root, tombstones, parse(contents), name);
      count++;
    }
    fs.unlinkSync(source);
  }
  return count;
}

module.exports = { validateTransaction, transactionTombstones, ensureNoSymlinks, integrateTransactions, importHistory, prepareHistory, readOptional, recordTransaction, replayTransactions, saveChanges, serialize };
