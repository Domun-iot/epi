'use strict';

// Installation settings never enter a dataset, an export, or a transaction.
const fs = require('node:fs');
const { dirname, join } = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { withInstallationLock } = require('./installation-lock.cjs');
const { recordTransaction, integrateTransactions, validateTransaction } = require('./transactions.cjs');

const accountPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const datasetEntries = ['devices', 'measures', 'profiles', 'prefs', 'notifications',
  'transactions', 'transactions.sent', 'transactions.incoming', 'transactions.index',
  'interface.json', 'session.json'];

function exists(path) { return fs.existsSync(path); }
function read(path, fallback) {
  try { return JSON.parse(fs.readFileSync(path, 'utf8').replace(/^\uFEFF/u, '')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
function write(path, value) {
  fs.mkdirSync(dirname(path), { recursive: true });
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600, flush: true });
    fs.renameSync(temporary, path);
  } finally { fs.rmSync(temporary, { force: true }); }
}
function safeTree(path) {
  const info = fs.lstatSync(path, { throwIfNoEntry: false });
  if (!info) return;
  if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw new Error('Unexpected data path: ' + path);
  if (info.isDirectory()) for (const entry of fs.readdirSync(path)) safeTree(join(path, entry));
}
function safeDirectory(path) {
  const info = fs.lstatSync(path, { throwIfNoEntry: false });
  if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error('Unexpected data directory: ' + path);
}
function validAccount(accountId) {
  if (typeof accountId !== 'string' || !accountPattern.test(accountId)) throw new Error('Invalid account UUID.');
  return accountId;
}
function settings(root) {
  const value = read(join(root, 'installation.json'), {});
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || (value.activeAccountId != null && (typeof value.activeAccountId !== 'string' || !accountPattern.test(value.activeAccountId)))
      || (value.accountModeEnabled !== undefined && typeof value.accountModeEnabled !== 'boolean')) {
    throw new Error('Invalid installation settings.');
  }
  return { ...value, activeAccountId: value.activeAccountId ?? null,
    accountModeEnabled: value.accountModeEnabled === true };
}
function save(root, value) { write(join(root, 'installation.json'), value); }

function finishMigration(root, migration) {
  if (!Array.isArray(migration.entries) || migration.entries.some(name => !datasetEntries.includes(name))) {
    throw new Error('Invalid migration journal.');
  }
  fs.mkdirSync(join(root, 'local'), { recursive: true });
  for (const name of migration.entries) {
    const from = join(root, name), to = join(root, 'local', name);
    if (!exists(from)) continue;
    if (exists(to)) throw new Error('Ambiguous interrupted migration: ' + name);
    safeTree(from);
    fs.renameSync(from, to);
  }
  fs.rmSync(join(root, 'migration.json'));
}

function recoverReplacement(root) {
  const journal = read(join(root, 'replacement.json'));
  if (!journal) return;
  validAccount(journal.accountId);
  if (!/^\.account-[0-9a-f-]{36}$/u.test(journal.temporary)
      || (journal.backup != null && !/^account-[0-9a-f-]{36}-[0-9a-f-]{36}$/u.test(journal.backup))
      || journal.nextConfig?.activeAccountId !== journal.accountId) throw new Error('Invalid replacement journal.');
  const target = join(root, 'accounts', journal.accountId);
  const temporary = join(root, journal.temporary), backup = journal.backup ? join(root, 'backups', journal.backup) : undefined;
  safeDirectory(target); safeDirectory(temporary); if (backup) safeDirectory(backup);
  if (!exists(target) && !exists(temporary) && (!backup || !exists(backup))) throw new Error('Missing staged account dataset.');
  if (exists(target) && !exists(temporary)) save(root, journal.nextConfig);
  else {
    if (!exists(target) && backup && exists(backup)) fs.renameSync(backup, target);
    if (exists(temporary)) fs.rmSync(temporary, { recursive: true, force: true });
  }
  fs.rmSync(join(root, 'replacement.json'));
}
function initializeInstallation(root) {
  fs.mkdirSync(root, { recursive: true });
  for (const name of ['local', 'accounts', 'backups']) safeDirectory(join(root, name));
  for (const name of ['installation.json', 'migration.json', 'replacement.json']) safeTree(join(root, name));
  recoverReplacement(root);
  safeTree(join(root, 'installation.json'));
  const migration = read(join(root, 'migration.json'));
  if (migration) finishMigration(root, migration);
  const legacy = datasetEntries.filter(name => exists(join(root, name)));
  if (legacy.length) {
    if (exists(join(root, 'local')) && fs.readdirSync(join(root, 'local')).length) {
      throw new Error('Both legacy and local datasets exist; migration requires recovery.');
    }
    if (exists(join(root, 'transactions.replay.lock'))) throw new Error('Transaction replay is active.');
    const backup = join(root, 'backups', 'legacy-' + randomUUID());
    for (const name of legacy) {
      safeTree(join(root, name));
      fs.mkdirSync(backup, { recursive: true });
      fs.cpSync(join(root, name), join(backup, name), { recursive: true, errorOnExist: true, force: false });
    }
    const journal = { entries: legacy };
    write(join(root, 'migration.json'), journal);
    finishMigration(root, journal);
  }
  const config = settings(root);
  const accounts = join(root, 'accounts');
  if (exists(accounts)) {
    if (fs.readdirSync(accounts, { withFileTypes: true }).some(entry => entry.isDirectory() && accountPattern.test(entry.name))) config.accountModeEnabled = true;
  }
  if (config.activeAccountId) config.accountModeEnabled = true;
  if (config.pendingAnonymousBackup) {
    if (!/^anonymous-[0-9a-f-]{36}$/u.test(config.pendingAnonymousBackup)) throw new Error('Invalid backup journal.');
    const source = join(root, 'local');
    const destination = join(root, 'backups', config.pendingAnonymousBackup);
    if (exists(source)) {
      if (exists(destination)) throw new Error('Ambiguous anonymous backup.');
      fs.mkdirSync(dirname(destination), { recursive: true });
      fs.renameSync(source, destination);
    }
    delete config.pendingAnonymousBackup;
  }
  if (config.window === undefined) {
    const old = read(join(root, 'local/prefs/global.json')) ?? read(join(root, 'local/interface.json'));
    if (old?.window !== undefined) config.window = old.window;
  }
  if (!Array.isArray(config.syncReadyAccountIds ?? [])) throw new Error('Invalid synchronization settings.');
  config.syncReadyAccountIds ??= [];
  if (config.syncReadyAccountIds.some(id => typeof id !== 'string' || !accountPattern.test(id))) throw new Error('Invalid synchronization account UUID.');
  config.syncRevisions ??= {};
  if (!config.syncRevisions || typeof config.syncRevisions !== 'object' || Array.isArray(config.syncRevisions)
      || Object.entries(config.syncRevisions).some(([id, revision]) => !accountPattern.test(id) || typeof revision !== 'string' || !/^[0-9a-f]{64}$/u.test(revision))) {
    throw new Error('Invalid synchronization revision settings.');
  }
  config.datasetGeneration ??= 0;
  if (!Number.isSafeInteger(config.datasetGeneration) || config.datasetGeneration < 0) throw new Error('Invalid dataset generation.');
  config.layoutVersion = 1;
  save(root, config);
  if (!config.accountModeEnabled) fs.mkdirSync(join(root, 'local'), { recursive: true });
  return config;
}

function summary(root) {
  const ids = new Set();
  let count = 0, from = null, to = null;
  function visit(directory) {
    if (!exists(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Unexpected measurement symlink.');
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith('.json')) {
        const value = read(path);
        const identity = value?.uuid ?? path;
        if (ids.has(identity)) continue;
        ids.add(identity); count += 1;
        const time = Date.parse(value?.receivedAt);
        if (!Number.isFinite(time)) continue;
        const date = new Date(time).toISOString();
        if (from === null || date < from) from = date;
        if (to === null || date > to) to = date;
      }
    }
  }
  visit(join(root, 'measures'));
  const hasData = count > 0 || ['profiles', 'devices'].some(folder =>
    exists(join(root, folder)) && fs.readdirSync(join(root, folder)).length > 0)
    || (read(join(root, 'prefs/global.json'), {})?.pending?.length ?? 0) > 0;
  return { count, from, to, hasData };
}
function queueBaseline(root) {
  const validate = (name, contents) => {
    const value = JSON.parse(contents.replace(/^\uFEFF/u, ''));
    if (name === 'prefs/global.json' || name === 'interface.json') delete value.window;
    const uuid = randomUUID();
    const transaction = { uuid, name: '2000-01-01T00-00-00.000000Z-' + uuid + '.json',
      type: 'create', data: { path: name, value } };
    validateTransaction(root, transaction);
    return JSON.stringify(value);
  };
  // A historical installation may contain records predating its transaction journal.
  // Each file is a separate small transaction, so a large history is uploadable in batches.
  const baselinePath = /^(?:profiles\/(?:profil-[^/]+|[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})\.json|devices\/[^/]+\.json|measures\/[^/]+\/[^/]+\.json|prefs\/(?:global|profil[-~][^/]+|(?:measurements|measurement-details)\/[^/]+)\.json|notifications\/[^/]+\.json)$/u;
  function visit(directory, relative) {
    if (!exists(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name), name = relative ? relative + '/' + entry.name : entry.name;
      if (entry.isSymbolicLink()) throw new Error('Unexpected dataset symlink.');
      if (entry.isDirectory()) visit(path, name);
      else if (entry.isFile() && baselinePath.test(name)) {
        const contents = validate(name, fs.readFileSync(path, 'utf8'));
        recordTransaction(root, [{ path: name, after: contents }]);
      }
    }
  }
  for (const folder of ['profiles', 'devices', 'measures', 'prefs', 'notifications']) visit(join(root, folder), folder);
  for (const name of ['interface.json', 'session.json']) {
    const path = join(root, name);
    if (exists(path)) recordTransaction(root, [{ path: name, after: validate(name, fs.readFileSync(path, 'utf8')) }]);
  }
}

function getDatasetContext(root) {
  const config = initializeInstallation(root);
  const locked = config.accountModeEnabled && !config.activeAccountId;
  const datasetId = locked ? null : config.activeAccountId ?? 'local';
  return { activeAccountId: config.activeAccountId, accountModeEnabled: config.accountModeEnabled,
    locked, datasetId, datasetGeneration: config.datasetGeneration,
    syncReady: config.syncReadyAccountIds.includes(config.activeAccountId),
    ...(config.syncRevisions[config.activeAccountId] && { syncRevision: config.syncRevisions[config.activeAccountId] }),
    localSummary: summary(join(root, 'local')) };
}
function resolveActiveDataset(root, expectedDatasetId, expectedGeneration) {
  const context = getDatasetContext(root);
  if (context.locked) throw Object.assign(new Error('Account sign-in required.'), { code: 'dataset_locked' });
  if ((expectedDatasetId !== undefined && expectedDatasetId !== context.datasetId)
      || (expectedGeneration !== undefined && expectedGeneration !== context.datasetGeneration)) {
    throw Object.assign(new Error('The active dataset changed.'), { code: 'dataset_changed' });
  }
  const target = context.activeAccountId ? join(root, 'accounts', context.activeAccountId) : join(root, 'local');
  safeDirectory(target); safeTree(target);
  if (context.activeAccountId && !exists(target)) throw new Error('The selected account dataset is missing.');
  return target;
}
function prepareAccountDataset(root, accountId) {
  validAccount(accountId);
  const context = getDatasetContext(root);
  const target = join(root, 'accounts', accountId);
  safeDirectory(target); safeTree(target);
  return { ...context, accountExists: exists(target), accountSummary: summary(target),
    syncReady: settings(root).syncReadyAccountIds.includes(accountId), syncRevision: settings(root).syncRevisions[accountId] };
}

// Async web callers import validated remote files into stage.root before commit().
// The active dataset and anonymous originals remain untouched until commit.
function fingerprint(root) {
  const hash = createHash('sha256');
  function visit(directory, relative = '') {
    if (!exists(directory)) { hash.update('missing'); return; }
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = relative + '/' + entry.name, path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Unexpected dataset symlink.');
      hash.update(name + '\0');
      if (entry.isDirectory()) visit(path, name);
      else if (entry.isFile()) hash.update(fs.readFileSync(path));
    }
  }
  visit(root); return hash.digest('hex');
}
function stageAccountDataset(root, accountId, mode, syncReady = false, syncRevision) {
  if (syncRevision !== undefined && (typeof syncRevision !== 'string' || !/^[0-9a-f]{64}$/u.test(syncRevision))) throw new Error('Invalid synchronization revision.');
  validAccount(accountId);
  if (!['attach', 'merge', 'remote', 'existing'].includes(mode)) throw new Error('Invalid account activation mode.');
  const config = initializeInstallation(root);
  const target = join(root, 'accounts', accountId);
  safeDirectory(target);
  const replacing = exists(target);
  if (replacing && !['remote', 'merge'].includes(mode)) {
    if (mode !== 'existing') throw new Error('This account already has a local dataset.');
    return { root: target, commit: () => {
      const current = settings(root);
      if (current.datasetGeneration !== config.datasetGeneration || current.activeAccountId !== config.activeAccountId
          || current.accountModeEnabled !== config.accountModeEnabled) throw new Error('The active dataset changed.');
      const ready = syncReady ? [...new Set([...current.syncReadyAccountIds, accountId])] : current.syncReadyAccountIds;
      save(root, { ...current, activeAccountId: accountId, accountModeEnabled: true,
        datasetGeneration: current.datasetGeneration + 1, syncReadyAccountIds: ready,
        syncRevisions: { ...current.syncRevisions, ...(syncRevision && { [accountId]: syncRevision }) } });
      return getDatasetContext(root);
    }, abort() {} };
  }
  if (mode === 'existing') throw new Error('The account dataset does not exist.');
  const temporary = join(root, '.account-' + randomUUID());
  const anonymous = join(root, 'local');
  const attachAnonymous = !config.accountModeEnabled && exists(anonymous);
  const source = replacing ? target : attachAnonymous ? anonymous : undefined;
  const sourceFingerprint = source ? fingerprint(source) : undefined;
  fs.mkdirSync(temporary, { recursive: true });
  try {
    if (attachAnonymous && mode === 'attach') {
      safeTree(anonymous);
      fs.cpSync(anonymous, temporary, { recursive: true, force: false });
      queueBaseline(temporary);
    }
  } catch (error) { fs.rmSync(temporary, { recursive: true, force: true }); throw error; }
  let committed = false;
  return { root: temporary, commit() {
    if (committed) throw new Error('Dataset stage already committed.');
    safeTree(temporary);
    if (source && fingerprint(source) !== sourceFingerprint) throw Object.assign(new Error('The dataset changed while preparing this operation.'), { code: 'dataset_changed' });
    const current = settings(root);
    if (current.datasetGeneration !== config.datasetGeneration || current.activeAccountId !== config.activeAccountId
        || current.accountModeEnabled !== config.accountModeEnabled) throw new Error('The active dataset changed.');
    fs.mkdirSync(dirname(target), { recursive: true });
    const ready = syncReady ? [...new Set([...current.syncReadyAccountIds, accountId])] : current.syncReadyAccountIds;
    const next = { ...current, activeAccountId: accountId, accountModeEnabled: true,
      datasetGeneration: current.datasetGeneration + 1, syncReadyAccountIds: ready,
      syncRevisions: { ...current.syncRevisions, ...(syncRevision && { [accountId]: syncRevision }) } };
    if (attachAnonymous) next.pendingAnonymousBackup = 'anonymous-' + randomUUID();
    let backup;
    if (replacing) {
      backup = join(root, 'backups', 'account-' + accountId + '-' + randomUUID());
      fs.mkdirSync(dirname(backup), { recursive: true });
    }
    write(join(root, 'replacement.json'), { accountId, temporary: require('node:path').basename(temporary),
      backup: backup ? require('node:path').basename(backup) : null, nextConfig: next });
    if (backup) fs.renameSync(target, backup);
    fs.renameSync(temporary, target);
    try { save(root, next); }
    catch (error) {
      fs.renameSync(target, temporary);
      if (backup) fs.renameSync(backup, target);
      fs.rmSync(join(root, 'replacement.json'), { force: true });
      throw error;
    }
    fs.rmSync(join(root, 'replacement.json'), { force: true });
    committed = true;
    return getDatasetContext(root);
  }, abort() {
    if (!committed) {
      const journal = read(join(root, 'replacement.json'));
      if (journal?.temporary === require('node:path').basename(temporary)) recoverReplacement(root);
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  } };
}
function mergeSourceIntoStage(root, sourceRoot, stageRoot) {
  const source = join(root, '.anonymous-' + randomUUID());
  try {
    safeTree(sourceRoot);
    fs.cpSync(sourceRoot, source, { recursive: true, force: false });
    queueBaseline(source);
    const rows = new Map();
    for (const folder of ['transactions', 'transactions.sent']) {
      const directory = join(source, folder);
      if (!exists(directory)) continue;
      for (const name of fs.readdirSync(directory)) {
        if (!/^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.\d{6}Z-[0-9a-f-]{36}\.json$/u.test(name)) continue;
        const contents = fs.readFileSync(join(directory, name), 'utf8');
        const transaction = JSON.parse(contents);
        rows.set(name, { ...transaction, name });
      }
    }
    const transactions = [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
    const result = integrateTransactions(stageRoot, transactions);
    if (result.uuids.length !== new Set(transactions.map(row => row.uuid)).size) throw new Error('Anonymous dataset merge failed.');
    fs.mkdirSync(join(stageRoot, 'transactions'), { recursive: true });
    for (const [name, row] of rows) {
      const { name: ignored, ...transaction } = row;
      const path = join(stageRoot, 'transactions', name);
      if (!exists(path)) fs.writeFileSync(path, JSON.stringify(transaction, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    }
  } finally { fs.rmSync(source, { recursive: true, force: true }); }
}
function mergeAnonymousIntoStage(root, stageRoot) {
  const config = initializeInstallation(root);
  if (config.accountModeEnabled || !exists(join(root, 'local'))) return;
  mergeSourceIntoStage(root, join(root, 'local'), stageRoot);
}
function mergeAccountIntoStage(root, accountId, stageRoot) {
  validAccount(accountId);
  const source = join(root, 'accounts', accountId);
  if (!exists(source)) throw new Error('The account dataset does not exist.');
  mergeSourceIntoStage(root, source, stageRoot);
}
function activateAccountDataset(root, accountId, mode, syncReady = false, syncRevision) {
  const stage = stageAccountDataset(root, accountId, mode, syncReady, syncRevision);
  try { return stage.commit(); }
  catch (error) { stage.abort(); throw error; }
}
function logoutDataset(root) {
  const config = initializeInstallation(root);
  save(root, { ...config, activeAccountId: null, datasetGeneration: config.datasetGeneration + 1 });
  return getDatasetContext(root);
}

function markDatasetSyncReady(root, accountId) {
  validAccount(accountId);
  const config = initializeInstallation(root);
  if (config.activeAccountId !== accountId) throw new Error('The active dataset changed.');
  save(root, { ...config, syncReadyAccountIds: [...new Set([...config.syncReadyAccountIds, accountId])] });
  return getDatasetContext(root);
}

function confirmDatasetSync(root, accountId, generation) {
  validAccount(accountId);
  const config = initializeInstallation(root);
  if (config.activeAccountId !== accountId || config.datasetGeneration !== generation) {
    throw Object.assign(new Error('The active dataset changed.'), { code: 'dataset_changed' });
  }
  delete config.syncRevisions[accountId]; save(root, config);
  return getDatasetContext(root);
}
const lockedMethods = { confirmDatasetSync, markDatasetSyncReady, initializeInstallation, getDatasetContext, resolveActiveDataset,
  prepareAccountDataset, mergeAnonymousIntoStage, mergeAccountIntoStage, activateAccountDataset, logoutDataset };
module.exports = Object.fromEntries(Object.entries(lockedMethods).map(([name, method]) =>
  [name, (root, ...args) => withInstallationLock(root, () => method(root, ...args))]));
module.exports.stageAccountDataset = (root, ...args) => {
  const stage = withInstallationLock(root, () => stageAccountDataset(root, ...args));
  return { root: stage.root, commit: () => withInstallationLock(root, () => stage.commit()),
    abort: () => withInstallationLock(root, () => stage.abort()) };
};
module.exports.summary = summary;
module.exports.queueBaseline = queueBaseline;
