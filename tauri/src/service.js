import { localizeMessage, t } from './i18n.js';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open, save } from '@tauri-apps/plugin-dialog';
import { readFile, writeFile } from '@tauri-apps/plugin-fs';
import { domain } from 'virtual:epi-domain';
import { createWebSession } from './web-session.js';
import { isPaidAccount, syncToken, getAccountId, getAccountInfo, getSavedAccount, checkAccountConnection,
  configureAccountDatasets, setDatasetAccess } from './account.js';
import { createDatasetController } from './dataset-controller.js';
import { chooseAccountData } from './account-data-dialog.js';
import { requestWebSession } from './web-session.js';
import { snapshotKey } from './preferences.js';
import composition from 'virtual:epi-composition';
import { datasetFiles, fileRecords, readArchive, writeArchive } from './legacy-import.js';

const translatedMethods = new Set(['IMC', 'Mi', 'D60*', 'HW', 'HB', 'Owe', 'Cun*']);
export const METHOD_COLUMNS = composition.columns.map(([id, name]) =>
  [id, translatedMethods.has(id) ? t('method.' + id.replace('*', '')) : name]);
export const METRICS = composition.metrics.map(([id, , precision]) =>
  [id, t('metric.' + id), precision]);

const zipFilters = [{ name: t('zipArchive'), extensions: ['zip'] }];

export async function connect(onState, onStatus, onRaw, onWeighing, onTransactions, recoverDataConflict, queueReload) {
  const native = isTauri();
  const hosted = import.meta.env.MODE === 'hosted' && !native;
  const web = ['web', 'hosted'].includes(import.meta.env.MODE) && !native;
  let active;
  let credentials;
  let datasets;
  const proFeatures = isPaidAccount;
  const empty = () => domain.createSession({ hasProViews: () => false, storage: { load: () => null, save: () => { throw new Error('dataset_locked'); } } });
  const installation = async (action, args = [], token) => {
    const response = await fetch('/api/installation', { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token && { Authorization: 'Bearer ' + token }) },
      body: JSON.stringify({ action, args }) });
    const value = await response.json();
    if (!response.ok) throw Object.assign(new Error(value.error), { code: value.error });
    return value;
  };
  const backend = native ? {
    context: () => invoke('get_dataset_context'),
    prepare: accountId => invoke('prepare_account_dataset', { accountId }),
    activate: (accountId, mode, remoteFiles, token, syncReady) => invoke('activate_account_dataset', { accountId, mode, remoteFiles, syncReady }),
    logout: () => invoke('logout_dataset'),
  } : web && !hosted ? {
    context: () => installation('context'),
    prepare: (accountId, token) => installation('prepare', [accountId], token),
    activate: (accountId, mode, remoteFiles, token, syncReady) => installation('activate', [accountId, mode, remoteFiles, syncReady], token),
    logout: () => installation('logout'),
  } : hosted ? { hosted: true } : browserBackend();

  datasets = createDatasetController({ backend, chooseData: chooseAccountData,
    access: access => {
      setDatasetAccess(access);
      if (!access.locked) queueMicrotask(onTransactions);
    },
    readRemote: async token => {
      const response = await fetch(__DEV_ACCOUNT_API__ + '/v1/dataset', {
        headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(15000),
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error);
      return value;
    },
    async change(context, saved, epoch) {
      window.dispatchEvent(new CustomEvent('epi:dataset-reset', { detail: { datasetId: context.datasetId, epoch } }));
      credentials = saved;
      const current = () => datasets.epoch === epoch;
      const stateChanged = state => { if (current()) onState(state); };
      if (context.locked) {
        active = empty();
        onState(await active.load());
        return;
      }
      const datasetId = context.datasetId;
      const datasetGeneration = context.datasetGeneration;
      const token = () => credentials?.token ?? syncToken();
      const storage = native ? {
        load: () => { if (!current()) throw new Error('dataset_changed'); return invoke('load_session', { datasetId, datasetGeneration }); },
        integrateTransactions: transactions => { if (!current()) throw new Error('dataset_changed'); return invoke('integrate_transactions', { transactions, datasetId, datasetGeneration }); },
        async save(session, previous) {
          if (!current()) throw new Error('dataset_changed');
          if (await invoke('save_session', { session, previous, datasetId, datasetGeneration })) onTransactions();
        },
      } : {
        load: () => JSON.parse(localStorage.getItem(browserSnapshotKey(datasetId)) ?? 'null'),
        save: session => localStorage.setItem(browserSnapshotKey(datasetId), JSON.stringify(session)),
      };
      active = web ? createWebSession(stateChanged, hosted ? () => {} : onTransactions,
        token, () => datasetId, current, () => datasetGeneration) : domain.createSession({ storage,
        onWeighing: () => { if (current()) onWeighing?.(); }, hasProViews: proFeatures });
      if (!web) active.subscribe(stateChanged);
      stateChanged(await active.load());
    },
  });

  const requireActive = () => {
    datasets.capture();
    return active;
  };
  configureAccountDatasets({
    beforeSignIn: (info, token) => datasets.signIn(info, token),
    beforeSignOut: () => datasets.signOut(),
    onExpired: () => datasets.expire(),
  });
  await datasets.initialize();
  const saved = getSavedAccount();
  if (saved?.token) {
    void Promise.resolve(checkAccountConnection()).then(async info => {
      if (info && syncToken() === saved.token) await datasets.signIn(info, saved.token);
    }).catch(error => onStatus?.(localizeMessage(error.message), true));
  }

  let reviewingConflict = false;
  let dismissedConflict;
  window.addEventListener('epi:dataset-conflict', event => {
    if (reviewingConflict || hosted || datasets.locked || !proFeatures()) return;
    if (!event.detail?.manual && dismissedConflict === datasets.revision) return;
    const info = getAccountInfo();
    const token = syncToken();
    if (!info || !token || info.accountId !== datasets.context.activeAccountId) return;
    reviewingConflict = true;
    void datasets.signIn(info, token, { forceReview: true }).then(accepted => {
      if (!accepted) dismissedConflict = datasets.revision;
    }).catch(error => onStatus?.(localizeMessage(error.message), true))
      .finally(() => { reviewingConflict = false; });
  });

  let reviewingUpgrade = false;
  window.addEventListener('epi:entitlement', () => {
    if (hosted || reviewingUpgrade || datasets.locked || datasets.context.syncReady || !proFeatures()) return;
    const info = getAccountInfo();
    const token = syncToken();
    if (!info || !token || datasets.context.activeAccountId !== info.accountId) return;
    reviewingUpgrade = true;
    void datasets.signIn(info, token).catch(error => onStatus?.(localizeMessage(error.message), true))
      .finally(() => { reviewingUpgrade = false; });
  });

  window.addEventListener('epi:account', event => {
    credentials = undefined;
    if (event.detail?.reason === 'storage') {
      // A different tab's account must never be paired with this tab's old dataset.
      datasets.invalidate();
      void (async () => {
        await datasets.waitIdle();
        if (hosted) await datasets.signOut();
        else await datasets.refresh();
        const verified = await checkAccountConnection();
        const account = getSavedAccount();
        if (verified && account?.token) await datasets.signIn(verified, account.token);
      })().catch(error => onStatus?.(localizeMessage(error.message), true));
    }
  });

  function receive(line) {
    if (datasets.locked) return;
    onRaw?.(line);
    if (line.startsWith('PAYLOAD ')) return;
    const binding = datasets.capture();
    active.ingest(line).catch(error => {
      if (datasets.isCurrent(binding) && !recoverDataConflict(error)) {
        onStatus?.(t('bluetoothProcessingError', { detail: localizeMessage(error?.message ?? String(error)) }), true);
      }
    });
  }
  async function retryBluetooth() {
    if (native) await invoke('start_bluetooth');
  }
  if (native) {
    await listen('ble-frame', event => receive(event.payload));
    await listen('ble-status', ({ payload }) => onStatus?.(localizeMessage(payload),
      !['epi-i18n:bluetoothStarting', 'epi-i18n:diagnostic.startingBluetoothListening', 'epi-i18n:diagnostic.activeBluetoothListening'].includes(payload)));
    onStatus?.(t('bluetoothStarting'));
    try { await retryBluetooth(); }
    catch (error) { onStatus?.(t('bluetoothUnavailable', { detail: localizeMessage(String(error)) }), true); }
  } else if (web) onStatus?.(t('webMode'));
  else {
    onStatus?.(t('simulationMode'), true);
    window.addEventListener('epi:frame', event => receive(event.detail));
  }

  // Keep the public session facade stable while rebuilding its account-bound implementation.
  const emptySession = empty();
  const names = Object.keys(emptySession).filter(name => typeof emptySession[name] === 'function' && name !== 'subscribe');
  const facade = Object.fromEntries(names.map(name => [name, (...args) => {
    if (datasets.locked && ['load', 'reload', 'refreshView'].includes(name)) return active[name](...args);
    return requireActive()[name](...args);
  }]));
  const txFor = binding => ({
    pendingTransactions: () => native ? invoke('pending_transactions', { datasetId: binding.datasetId, datasetGeneration: binding.datasetGeneration })
      : requestWebSession('pendingTransactions', [], binding.token, binding.datasetId, binding.datasetGeneration).then(result => result.state),
    archiveTransactions: names => native ? invoke('archive_transactions', { names, datasetId: binding.datasetId, datasetGeneration: binding.datasetGeneration })
      : requestWebSession('archiveTransactions', [names], binding.token, binding.datasetId, binding.datasetGeneration).then(result => result.state),
    integrateTransactions: transactions => queueReload(async () => {
      if (!datasets.isCurrent(binding)) return [];
      if (native) {
        const result = await invoke('integrate_transactions', { transactions, datasetId: binding.datasetId, datasetGeneration: binding.datasetGeneration });
        if (datasets.isCurrent(binding)) onState(await active.reload());
        return result.uuids ?? result;
      }
      const result = await requestWebSession('integrateTransactions', [transactions], binding.token, binding.datasetId, binding.datasetGeneration);
      if (result.state.state && datasets.isCurrent(binding)) onState(result.state.state);
      return result.state.uuids;
    }),
  });
  async function importBytes(bytes, binding = datasets.capture()) {
    if (!proFeatures() || !datasets.isCurrent(binding)) return 0;
    const files = readArchive(bytes);
    if (!files.length) return 0;
    await domain.createSession({ storage: { load: () => null, save: () => {} } }).importLegacy(fileRecords(files));
    return queueReload(async () => {
      if (!proFeatures() || !datasets.isCurrent(binding)) return 0;
      if (web) return active.importFiles(files);
      if (!native) return active.importLegacy(fileRecords(files));
      const added = await invoke('import_files', { files, datasetId: binding.datasetId, datasetGeneration: binding.datasetGeneration });
      if (added) onTransactions();
      if (datasets.isCurrent(binding)) onState(await active.reload());
      return added;
    });
  }
  return {
    ...facade, native, web, hosted,
    retryBluetooth: native ? retryBluetooth : undefined,
    async prepareSync() {
      if (hosted || datasets.locked || datasets.context.syncReady || !proFeatures()) return;
      const info = await checkAccountConnection();
      const token = syncToken();
      if (info && token && info.accountId === datasets.context.activeAccountId) await datasets.signIn(info, token);
    },
    getSyncContext() {
      const token = syncToken();
      if (hosted || (!native && !web) || datasets.locked || !proFeatures()
          || !token || !datasets.context.syncReady || datasets.context.activeAccountId !== getAccountId()) return;
      const binding = { ...datasets.capture(), datasetGeneration: datasets.context.datasetGeneration, token };
      return { ...binding, ...txFor(binding), revision: datasets.revision,
        clearRevision: () => datasets.clearRevision(),
        isCurrent: () => datasets.isCurrent(binding) && syncToken() === token && proFeatures()
          && datasets.context.activeAccountId === getAccountId() };
    },
    async importLegacy(file) {
      const binding = datasets.capture();
      const bytes = new Uint8Array(await file.arrayBuffer());
      return importBytes(bytes, binding);
    },
    ...(native && {
      async pickLegacy() {
        const binding = datasets.capture();
        const path = await open({ title: t('importAZipArchive'), multiple: false, filters: zipFilters });
        if (!path || !proFeatures() || !datasets.isCurrent(binding)) return;
        const bytes = await readFile(path);
        return importBytes(bytes, binding);
      },
    }),
    async exportData() {
      if (!proFeatures()) return false;
      const binding = datasets.capture();
      const filename = 'epi-data-' + new Date().toISOString().slice(0, 10) + '.zip';
      if (native) {
        const path = await save({ title: t('exportZip'), defaultPath: filename, filters: zipFilters });
        if (!path || !proFeatures() || !datasets.isCurrent(binding)) return false;
        const files = await invoke('export_files', { datasetId: binding.datasetId, datasetGeneration: binding.datasetGeneration });
        if (!proFeatures() || !datasets.isCurrent(binding)) return false;
        await writeFile(path, writeArchive(files));
      } else {
        const files = web ? await active.exportFiles() : datasetFiles(await active.load());
        if (!proFeatures() || !datasets.isCurrent(binding)) return false;
        const url = URL.createObjectURL(new Blob([writeArchive(files)], { type: 'application/zip' }));
        Object.assign(document.createElement('a'), { href: url, download: filename }).click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      return true;
    },
  };
}

const browserInstallationKey = 'epi-installation-v1';
const browserSnapshotKey = id => id === 'local' ? snapshotKey : snapshotKey + ':' + id;
function browserBackend() {
  const read = () => JSON.parse(localStorage.getItem(browserInstallationKey) ?? '{}');
  const context = () => {
    const prefs = read();
    const id = prefs.activeAccountId;
    const state = JSON.parse(localStorage.getItem(snapshotKey) ?? 'null');
    const dates = (state?.measurements ?? []).map(row => row.receivedAt).filter(Boolean).sort();
    return { activeAccountId: id ?? null, accountModeEnabled: prefs.accountModeEnabled === true,
      syncReady: true, locked: prefs.accountModeEnabled === true && !id, datasetId: id ?? (prefs.accountModeEnabled ? null : 'local'),
      localSummary: { count: dates.length, from: dates[0] ?? null, to: dates.at(-1) ?? null,
        hasData: ['profiles', 'devices', 'measurements'].some(key => state?.[key]?.length) } };
  };
  return {
    context,
    prepare: accountId => ({ ...context(), accountExists: localStorage.getItem(browserSnapshotKey(accountId)) !== null }),
    async activate(accountId, mode, remoteFiles = []) {
      const key = browserSnapshotKey(accountId);
      if (localStorage.getItem(key) === null) {
        const anonymous = JSON.parse(localStorage.getItem(snapshotKey) ?? 'null');
        let selected = anonymous;
        if (remoteFiles.length) {
          selected = fileRecords(remoteFiles);
          if (mode === 'merge') {
            const merging = domain.createSession({ storage: { load: () => selected, save: state => { selected = state; } } });
            await merging.load();
            await merging.importLegacy(anonymous ?? {});
          }
        }
        localStorage.setItem(key, JSON.stringify(selected));
        if (anonymous) localStorage.setItem(snapshotKey + ':backup', JSON.stringify(anonymous));
        localStorage.removeItem(snapshotKey);
      }
      localStorage.setItem(browserInstallationKey, JSON.stringify({ activeAccountId: accountId, accountModeEnabled: true }));
      return context();
    },
    logout() {
      localStorage.setItem(browserInstallationKey, JSON.stringify({ accountModeEnabled: true }));
      return context();
    },
  };
}
