import { accountPattern, changedDataset, clone, emptyDataset, exportSnapshot, filesSnapshot,
  importSnapshot, integrate, mergeImportedFiles, recordChanges, replaceFiles, snapshotFiles, summarize } from './snapshot-files.js';

export const browserStorageKey = 'epi-browser-storage-v1';
const legacySnapshotKey = 'epi-session-v1';
const blank = () => ({ version: 1, generation: 0, accountModeEnabled: false, activeAccountId: null,
  usageLocal: false, datasets: {}, backups: {} });
const unavailable = error => Object.assign(new Error('epi-i18n:browserStorageUnavailable'), { cause: error });

/** Browser implementation of DatasetPort + PersistencePort. One setItem commits data and journal together. */
export function createBrowserStorage({ storage, versions, domain, locks, onTransactions = () => {} }) {
  const read = () => {
    try {
      const value = JSON.parse(storage.getItem(browserStorageKey) ?? 'null');
      if (value === null) return blank();
      if (value.version !== 1 || !Number.isSafeInteger(value.generation) || !value.datasets || !value.backups) throw new Error('Invalid storage document.');
      return value;
    } catch (error) { throw unavailable(error); }
  };
  const persist = value => {
    try { storage.setItem(browserStorageKey, JSON.stringify(value)); }
    catch (error) { throw unavailable(error); }
  };
  const atomic = task => locks ? locks.request(browserStorageKey, task) : Promise.resolve().then(task);
  const mutate = task => atomic(() => { const value = read(); const result = task(value); persist(value); return result; });
  const selected = value => value.activeAccountId ?? (value.accountModeEnabled ? null : 'local');
  const contextFor = value => {
    const id = selected(value), dataset = value.datasets[id];
    return { activeAccountId: value.activeAccountId, accountModeEnabled: value.accountModeEnabled,
      datasetId: id, datasetGeneration: value.generation, locked: id === null,
      syncReady: dataset?.syncReady === true, syncRevision: dataset?.syncRevision,
      localSummary: summarize(value.datasets.local?.files ?? {}) };
  };
  let migration;
  async function initialize() {
    if (storage.getItem(browserStorageKey) !== null) return;
    migration ??= (async () => {
      const snapshots = [];
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (key === legacySnapshotKey || (key?.startsWith(legacySnapshotKey + ':') && accountPattern.test(key.slice(legacySnapshotKey.length + 1)))) {
          const id = key === legacySnapshotKey ? 'local' : key.slice(legacySnapshotKey.length + 1);
          let snapshot = JSON.parse(storage.getItem(key));
          if (!snapshot) continue;
          const session = domain.createSession({ storage: { load: () => snapshot, save: value => { snapshot = value; } } });
          await session.load();
          const dataset = emptyDataset();
          replaceFiles(dataset, snapshotFiles(snapshot, versions.globalKeys), versions);
          snapshots.push([id, dataset]);
        }
      }
      if (!snapshots.length) return;
      await atomic(() => {
        if (storage.getItem(browserStorageKey) !== null) return;
        const old = JSON.parse(storage.getItem('epi-installation-v1') ?? '{}');
        const value = { ...blank(), usageLocal: true, datasets: Object.fromEntries(snapshots),
          accountModeEnabled: old.accountModeEnabled === true,
          activeAccountId: accountPattern.test(old.activeAccountId ?? '') ? old.activeAccountId : null };
        persist(value); // Legacy originals are retained until the migration is durable.
      });
    })();
    return migration;
  }
  const check = (value, binding) => {
    if (selected(value) !== binding.datasetId || value.generation !== binding.datasetGeneration) throw changedDataset();
    return value.datasets[binding.datasetId] ??= emptyDataset();
  };
  const prepared = new Map();
  const backend = {
    async context() { await initialize(); return contextFor(read()); },
    async prepare(accountId) {
      if (!accountPattern.test(accountId)) throw new Error('invalid_account_id');
      await initialize();
      const value = read(), account = value.datasets[accountId];
      prepared.set(accountId, JSON.stringify(value));
      return { ...contextFor(value), accountExists: Boolean(account), accountSummary: summarize(account?.files ?? {}),
        syncReady: account?.syncReady === true, syncRevision: account?.syncRevision };
    },
    async activate(accountId, mode, remoteFiles = [], token, syncReady, syncRevision) {
      if (!accountPattern.test(accountId) || !['attach', 'existing', 'remote', 'merge'].includes(mode)) throw new Error('Invalid activation.');
      if (syncRevision !== undefined && !/^[0-9a-f]{64}$/u.test(syncRevision)) throw new Error('Invalid revision.');
      const remote = importSnapshot(remoteFiles, versions);
      const validation = domain.createSession({ storage: { load: () => filesSnapshot(remote.files), save: () => {} } });
      await validation.load();
      return mutate(value => {
        if (prepared.get(accountId) !== JSON.stringify(value)) throw changedDataset();
        const source = value.datasets[accountId] ?? (!value.accountModeEnabled ? value.datasets.local : undefined);
        let target;
        if (mode === 'existing') {
          if (!value.datasets[accountId]) throw changedDataset();
          target = value.datasets[accountId];
        } else if (mode === 'attach') target = source ? clone(source) : emptyDataset();
        else {
          target = remote;
          if (source) {
            value.backups[accountId] = clone(source);
            if (mode === 'merge') {
              // Replay deletions and current records, independently of old server acknowledgements.
              const local = clone(source);
              recordChanges(local, Object.entries(local.files).map(([path, record]) => ({ type: 'update', path, value: record })));
              const rows = [...Object.entries(local.sent), ...Object.entries(local.pending)]
                .map(([name, row]) => ({ ...row, name })).sort((a, b) => a.name.localeCompare(b.name));
              const result = integrate(target, rows, versions);
              if (new Set(result.uuids).size !== new Set(rows.map(row => row.uuid)).size) throw new Error('Invalid local journal.');
              // Keep the local queue for the conditional first upload.
              Object.assign(target.pending, local.pending);
              for (const name of Object.keys(local.pending)) delete target.sent[name];
            }
          }
        }
        target.syncReady ||= syncReady === true;
        if (syncRevision !== undefined) target.syncRevision = syncRevision;
        value.datasets[accountId] = target;
        if (!value.accountModeEnabled && value.datasets.local) {
          value.backups.anonymous = value.datasets.local;
          delete value.datasets.local;
        }
        value.accountModeEnabled = true;
        value.activeAccountId = accountId;
        value.usageLocal = true;
        value.generation += 1;
        return contextFor(value);
      });
    },
    async confirmSync(accountId, datasetGeneration) {
      return mutate(value => {
        const dataset = check(value, { datasetId: accountId, datasetGeneration });
        delete dataset.syncRevision;
      });
    },
    async logout() {
      return mutate(value => {
        value.activeAccountId = null;
        value.generation += 1;
        return contextFor(value);
      });
    },
  };

  return {
    kind: 'browser-local', backend,
    async hasLocalUsage() {
      await initialize();
      const value = read();
      return value.usageLocal || Object.keys(value.datasets).length > 0;
    },
    async pinLocal() { await initialize(); await mutate(value => { value.usageLocal = true; }); },
    async seedAccount(accountId, state) {
      if (!accountPattern.test(accountId)) throw new Error('invalid_account_id');
      await mutate(value => {
        if (!value.datasets[accountId] && state) {
          const dataset = emptyDataset();
          replaceFiles(dataset, snapshotFiles(state, versions.globalKeys), versions);
          value.datasets[accountId] = dataset;
        }
        value.usageLocal = true;
      });
    },
    files(binding, isCurrent = () => true) {
      let loaded;
      const current = value => { if (!isCurrent()) throw changedDataset(); return check(value, binding); };
      return {
        async load() { const dataset = current(read()); loaded = clone(dataset.files); return filesSnapshot(dataset.files); },
        async save(state) {
          const saved = await mutate(value => {
            const dataset = current(value);
            if (!versions.sameContent(dataset.files, loaded)) throw changedDataset();
            const next = snapshotFiles(state, versions.globalKeys);
            // Deleted profiles keep their preferences for a later restoration.
            for (const [path, record] of Object.entries(dataset.files)) {
              if (/^prefs\/profil[-~]/u.test(path) && !Object.hasOwn(next, path)) next[path] = record;
            }
            const count = replaceFiles(dataset, next, versions);
            value.usageLocal = true;
            return { count, files: clone(dataset.files) };
          });
          loaded = saved.files;
          if (saved.count) onTransactions();
        },
        async pendingTransactions() {
          return Object.entries(current(read()).pending).sort(([a], [b]) => a.localeCompare(b))
            .map(([name, transaction]) => ({ name, transaction: clone(transaction) }));
        },
        async archiveTransactions(names) {
          await mutate(value => {
            const dataset = current(value);
            for (const name of names) if (Object.hasOwn(dataset.pending, name)) {
              dataset.sent[name] = dataset.pending[name]; delete dataset.pending[name];
            }
          });
        },
        async integrateTransactions(rows) { return mutate(value => integrate(current(value), rows, versions)); },
        async exportFiles() { return exportSnapshot(current(read())); },
        async importFiles(entries) {
          const incoming = importSnapshot(entries, versions); // Validate the entire archive before the first write.
          const validator = domain.createSession({ storage: { load: () => filesSnapshot(incoming.files), save: () => {} } });
          await validator.load();
          const count = await mutate(value => {
            const dataset = current(value), merged = mergeImportedFiles(dataset.files, incoming.files);
            let count = merged.added;
            replaceFiles(dataset, merged.files, versions);
            for (const [name, row] of Object.entries(incoming.pending)) {
              if (!dataset.ids.includes(row.uuid)) { dataset.pending[name] = row; dataset.ids.push(row.uuid); count += 1; }
            }
            // Archives retain deletion history without replaying over current files.
            Object.assign(dataset.sent, incoming.sent);
            dataset.ids = [...new Set([...dataset.ids, ...incoming.ids])];
            for (const [path, time] of Object.entries(incoming.tombstones)) {
              if (!dataset.tombstones[path] || time > dataset.tombstones[path]) dataset.tombstones[path] = time;
            }
            value.usageLocal = true;
            return count;
          });
          if (count) onTransactions();
          return count;
        },
      };
    },
  };
}
