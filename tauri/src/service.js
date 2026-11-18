import { localizeMessage, t } from './i18n.js';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open, save } from '@tauri-apps/plugin-dialog';
import { readFile, writeFile } from '@tauri-apps/plugin-fs';
import { domain, versions } from 'virtual:epi-domain';
import { createStorageAdapter } from './storage/adapters.js';
import { isPaidAccount, syncToken, getAccountId, getAccountInfo, getSavedAccount, checkAccountConnection,
  configureAccountDatasets, setDatasetAccess, forgetAccountSession } from './account.js';
import { createDatasetController } from './dataset-controller.js';
import { chooseAccountData } from './account-data-dialog.js';
import composition from 'virtual:epi-composition';
import { datasetFiles, fileRecords, readArchive, writeArchive } from './legacy-import.js';

export const METHOD_COLUMNS = composition.columns.map(([id]) =>
  [id, t('method.' + id.replace('*', ''))]);
export const METRICS = composition.metrics.map(([id, , precision]) =>
  [id, t('metric.' + id), precision]);

const zipFilters = [{ name: t('zipArchive'), extensions: ['zip'] }];

export async function connect(onState, onStatus, onRaw, onWeighing, onTransactions, recoverDataConflict, queueReload) {
  const native = isTauri();
  const sharedWeb = import.meta.env.MODE === 'hosted' && !native;
  const web = ['web', 'hosted'].includes(import.meta.env.MODE) && !native;
  let active;
  let credentials;
  let datasets;
  const proFeatures = isPaidAccount;
  const empty = () => domain.createSession({ hasProViews: () => false, storage: { load: () => null, save: () => { throw new Error('dataset_locked'); } } });
  const adapter = createStorageAdapter({ native, mode: import.meta.env.MODE, invoke, domain, versions,
    storage: localStorage, getToken: syncToken, hasSavedAccount: () => Boolean(getSavedAccount()?.token),
    locks: navigator.locks, onTransactions });
  const backend = adapter.backend;
  datasets = createDatasetController({ backend, chooseData: chooseAccountData,
    access: access => {
      setDatasetAccess(access);
      if (!access.locked && !access.repaired) queueMicrotask(onTransactions);
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
      if (!saved?.repair) window.dispatchEvent(new CustomEvent('epi:dataset-reset', { detail: { datasetId: context.datasetId, epoch } }));
      credentials = saved;
      const current = () => datasets.epoch === epoch;
      const stateChanged = (state, context) => { if (current()) onState(state, context); };
      if (context.locked) {
        active = empty();
        onState(await active.load());
        return;
      }
      const datasetId = context.datasetId;
      const datasetGeneration = context.datasetGeneration;
      const token = () => credentials?.token ?? syncToken();
      active = adapter.open({ binding: { datasetId, datasetGeneration }, current, onState: stateChanged,
        onTransactions, token, hasProViews: proFeatures,
        onWeighing: () => { if (current()) onWeighing?.(); } });
      stateChanged(await active.load());
      if (web) onStatus?.(t(adapter.kind === 'browser-local' ? 'browserStorageMode' : 'webMode'));
    },
  });

  const requireActive = () => {
    datasets.capture();
    return active;
  };
  const attachments = new Map();
  configureAccountDatasets({
    beforeSignIn: (info, token) => { attachments.set(token, { ...datasets.context }); return datasets.signIn(info, token); },
    beforeSignOut: async () => {
      const token = syncToken();
      datasets.invalidate();
      const logoutEpoch = datasets.epoch;
      await datasets.waitIdle();
      if (datasets.epoch !== logoutEpoch || syncToken() !== token) throw new Error('dataset_changed');
      await datasets.signOut();
    },
    onExpired: () => datasets.expire(),
    onCancelled: async ({ token } = {}) => {
      const previous = attachments.get(token);
      attachments.delete(token);
      const previousStoredToken = syncToken();
      datasets.invalidate();
      const cancellationEpoch = datasets.epoch;
      await datasets.waitIdle();
      if (datasets.epoch !== cancellationEpoch || syncToken() !== previousStoredToken) return;
      if (!adapter.remote && previous) {
        const current = await backend.context();
        if (datasets.epoch !== cancellationEpoch || syncToken() !== previousStoredToken) return;
        if (current.activeAccountId === previous.activeAccountId && current.accountModeEnabled === previous.accountModeEnabled) {
          await datasets.refresh();
          return;
        }
      }
      await datasets.signOut();
    },
  });
  await datasets.initialize();
  if (!adapter.remote && datasets.context.accountModeEnabled && datasets.context.locked) await forgetAccountSession();
  const saved = getSavedAccount();
  if (saved?.token) {
    void Promise.resolve(checkAccountConnection()).then(async info => {
      if (info && syncToken() === saved.token) await datasets.signIn(info, saved.token);
    }).catch(error => onStatus?.(localizeMessage(error.message), true));
  }

  let reviewingConflict = false;
  let dismissedConflict;
  window.addEventListener('epi:dataset-conflict', event => {
    if (reviewingConflict || adapter.remote || datasets.locked || !proFeatures()) return;
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
    if (reviewingUpgrade || datasets.locked) return;
    const becomingLocal = sharedWeb && adapter.remote && !proFeatures();
    if (!becomingLocal && (adapter.remote || datasets.context.syncReady || !proFeatures())) return;
    const info = getAccountInfo();
    const token = syncToken();
    if (!info || !token || datasets.context.activeAccountId !== info.accountId) return;
    reviewingUpgrade = true;
    void datasets.signIn(becomingLocal ? { ...info, paid: false } : info, token)
      .catch(error => onStatus?.(localizeMessage(error.message), true))
      .finally(() => { reviewingUpgrade = false; });
  });

  window.addEventListener('epi:account', event => {
    attachments.clear();
    credentials = undefined;
    if (event.detail?.reason === 'storage') {
      // A different tab's account must never be paired with this tab's old dataset.
      datasets.invalidate();
      void (async () => {
        await datasets.waitIdle();
        if (adapter.remote) await datasets.signOut();
        else await datasets.refresh();
        const verified = await checkAccountConnection();
        const account = getSavedAccount();
        if (verified && account?.token) await datasets.signIn(verified, account.token);
      })().catch(error => onStatus?.(localizeMessage(error.message), true));
    }
  });

  window.addEventListener('storage', event => {
    if (!sharedWeb || adapter.remote || !datasets.context || !adapter.storageChanged?.(event)) return;
    let next;
    try { next = event.newValue === null ? null : JSON.parse(event.newValue); }
    catch { return; }
    if (next?.generation === datasets.context.datasetGeneration) return;
    datasets.invalidate();
    const epoch = datasets.epoch;
    void (async () => {
      await datasets.waitIdle();
      if (datasets.epoch !== epoch) return;
      // Activation is durable before the matching token: never expose another
      // tab's new account until its credential event has reached this tab too.
      if (next?.activeAccountId && next.activeAccountId !== getSavedAccount()?.accountId) return;
      await datasets.refresh();
    })().catch(error => onStatus?.(localizeMessage(error.message), true));
  });

  function receive(line) {
    if (datasets.locked) return;
    onRaw?.(line);
    if (line.startsWith('PAYLOAD ')) return;
    const binding = datasets.capture();
    active.ingest(line).catch(error => {
      if (datasets.isCurrent(binding) && !recoverDataConflict(error)) {
        onStatus?.(t('bluetoothProcessingError', { detail: localizeMessage(error?.message ?? String(error)) }), true, String(error));
      }
    });
  }
  async function retryBluetooth() {
    if (native) await invoke('start_bluetooth');
  }
  if (native) {
    await listen('ble-frame', event => receive(event.payload));
    await listen('ble-status', ({ payload }) => onStatus?.(localizeMessage(payload),
      !['epi-i18n:bluetoothStarting', 'epi-i18n:diagnostic.startingBluetoothListening', 'epi-i18n:diagnostic.activeBluetoothListening'].includes(payload), payload));
    onStatus?.(t('bluetoothStarting'));
    try { await retryBluetooth(); }
    catch (error) { onStatus?.(t('bluetoothUnavailable', { detail: localizeMessage(String(error)) }), true, String(error)); }
  } else if (web) onStatus?.(t(adapter.kind === 'browser-local' ? 'browserStorageMode' : 'webMode'));
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
  const txFor = binding => {
    const persistence = adapter.files(binding, () => datasets.isCurrent(binding));
    return {
      pendingTransactions: () => persistence.pendingTransactions(),
      archiveTransactions: names => persistence.archiveTransactions(names),
      integrateTransactions: transactions => queueReload(async () => {
        if (!datasets.isCurrent(binding)) return [];
        const result = await persistence.integrateTransactions(transactions);
        if (datasets.isCurrent(binding)) {
          if (result.state) onState(result.state, { source: 'sync' });
          else await active.reload({ source: 'sync' });
        }
        return result.uuids ?? result;
      }),
    };
  };
  async function importBytes(bytes, binding = datasets.capture()) {
    if (!proFeatures() || !datasets.isCurrent(binding)) return 0;
    const files = readArchive(bytes);
    if (!files.length) return 0;
    await domain.createSession({ storage: { load: () => null, save: () => {} } }).importLegacy(fileRecords(files));
    return queueReload(async () => {
      if (!proFeatures() || !datasets.isCurrent(binding)) return 0;
      return native || web ? active.importFiles(files) : active.importLegacy(fileRecords(files));
    });
  }
  return {
    ...facade, native, web, get hosted() { return adapter.remote; },
    get storageMode() { return adapter.kind; },
    retryBluetooth: native ? retryBluetooth : undefined,
    async prepareSync(repair = false) {
      const info = await checkAccountConnection();
      const token = syncToken();
      if (!adapter.synchronizes || datasets.locked || !proFeatures() || !info || !token || info.accountId !== datasets.context.activeAccountId) return;
      if (!datasets.context.syncReady) await datasets.signIn(info, token);
      else if (repair) await datasets.signIn(info, token, { repair: true });
    },
    getSyncContext() {
      const token = syncToken();
      if (!adapter.synchronizes || datasets.locked || !proFeatures()
          || !token || !datasets.context.syncReady || datasets.context.activeAccountId !== getAccountId()) return;
      const binding = { ...datasets.capture(), datasetGeneration: datasets.context.datasetGeneration, token };
      return { ...binding, ...txFor(binding), revision: datasets.revision,
        clearRevision: () => datasets.clearRevision(binding),
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
        const files = await active.exportFiles();
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
