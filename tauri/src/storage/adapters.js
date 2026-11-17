import { createWebSession, requestWebSession } from '../web-session.js';
import { createBrowserStorage, browserStorageKey } from './browser-storage.js';
import { changedDataset } from './snapshot-files.js';
import { previewStorage } from './preview-storage.js';

/** SessionPort: open an account-bound session; DatasetPort: select its dataset;
 * PersistencePort: load/save, ZIP files and the durable transaction queue.
 * API adapters implement SessionPort over HTTP; their persistence runs on the server.
 */
export function domainAdapter({ kind, backend, files, domain, synchronizes = true }) {
  return {
    kind, backend, files, synchronizes, remote: false,
    open({ binding, current, onState, onWeighing, hasProViews, onTransactions }) {
      const persistence = files(binding, current, onTransactions);
      const session = domain.createSession({ storage: persistence, onWeighing, hasProViews });
      session.subscribe(onState);
      return { ...session,
        exportFiles: () => persistence.exportFiles(),
        async importFiles(entries) {
          const added = await persistence.importFiles(entries);
          onState(await session.reload());
          return added;
        },
      };
    },
  };
}

export function nativeAdapter({ invoke, domain }) {
  const backend = {
    context: () => invoke('get_dataset_context'),
    prepare: accountId => invoke('prepare_account_dataset', { accountId }),
    activate: (accountId, mode, remoteFiles, token, syncReady, syncRevision) => invoke('activate_account_dataset', { accountId, mode, remoteFiles, syncReady, syncRevision }),
    confirmSync: (accountId, datasetGeneration) => invoke('confirm_dataset_sync', { accountId, datasetId: accountId, datasetGeneration }),
    logout: () => invoke('logout_dataset'),
  };
  return domainAdapter({ kind: 'native-files', backend, domain,
    files(binding, current, onTransactions = () => {}) {
      const { datasetId, datasetGeneration } = binding;
      const call = (command, args = {}) => {
        if (!current()) throw changedDataset();
        return invoke(command, { ...args, datasetId, datasetGeneration });
      };
      return {
        load: () => call('load_session'),
        async save(session, previous) { if (await call('save_session', { session, previous })) onTransactions(); },
        exportFiles: () => call('export_files'),
        async importFiles(files) { const added = await call('import_files', { files }); if (added) onTransactions(); return added; },
        pendingTransactions: () => call('pending_transactions'),
        archiveTransactions: names => call('archive_transactions', { names }),
        integrateTransactions: transactions => call('integrate_transactions', { transactions }),
      };
    },
  });
}

export function apiAdapter({ hosted = false, getToken }) {
  const installation = async (action, args = [], token) => {
    const response = await fetch('/api/installation', { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token && { Authorization: 'Bearer ' + token }) },
      body: JSON.stringify({ action, args }) });
    const value = await response.json();
    if (!response.ok) throw Object.assign(new Error(value.error), { code: value.error, status: response.status });
    return value;
  };
  return {
    kind: hosted ? 'hosted-api' : 'personal-api', remote: hosted, synchronizes: !hosted,
    backend: hosted ? { hosted: true } : {
      context: () => installation('context'),
      prepare: (accountId, token) => installation('prepare', [accountId], token),
      activate: (accountId, mode, remoteFiles, token, syncReady, syncRevision) => installation('activate', [accountId, mode, remoteFiles, syncReady, syncRevision], token),
      confirmSync: (accountId, datasetGeneration) => installation('confirmSync', [accountId, datasetGeneration], getToken()),
      logout: () => installation('logout'),
    },
    open({ binding, current, onState, onTransactions, token }) {
      return createWebSession(onState, hosted ? () => {} : onTransactions,
        token, () => binding.datasetId, current, () => binding.datasetGeneration);
    },
    files(binding, current) {
      const call = async (action, args = []) => {
        if (!current()) throw changedDataset();
        const { state } = await requestWebSession(action, args, binding.token, binding.datasetId, binding.datasetGeneration);
        if (!current()) throw changedDataset();
        return state;
      };
      return {
        pendingTransactions: () => call('pendingTransactions'),
        archiveTransactions: names => call('archiveTransactions', [names]),
        async integrateTransactions(rows) {
          const state = await call('integrateTransactions', [rows]);
          return { uuids: state.uuids, changed: Boolean(state.state), state: state.state };
        },
      };
    },
  };
}

export function sharedWebAdapter({ storage, versions, domain, getToken, hasSavedAccount, locks, onTransactions }) {
  const browser = createBrowserStorage({ storage, versions, domain, locks, onTransactions });
  const local = domainAdapter({ ...browser, domain, files: browser.files });
  const remote = apiAdapter({ hosted: true, getToken });
  let selected = local;
  let lastRemote;
  const isPro = info => info?.paid === true && Date.parse(info.paidUntil) > Date.now();
  const backend = {
    get hosted() { return selected.remote; },
    async context() {
      if (!await browser.hasLocalUsage() && hasSavedAccount()) {
        selected = remote;
        return { locked: true, activeAccountId: null, datasetId: null, accountModeEnabled: true };
      }
      selected = local;
      return local.backend.context();
    },
    async select(info) {
      if (info.entitlementVerified === false) {
        if (!await browser.hasLocalUsage()) throw new Error('epi-i18n:accountServerUnavailable');
        selected = local;
        return;
      }
      if (!isPro(info)) {
        await browser.seedAccount(info.accountId, lastRemote?.accountId === info.accountId ? lastRemote.state : undefined);
        selected = local;
      } else selected = await browser.hasLocalUsage() ? local : remote;
    },
    prepare: (...args) => local.backend.prepare(...args),
    activate: (...args) => local.backend.activate(...args),
    confirmSync: (...args) => local.backend.confirmSync(...args),
    async logout() {
      lastRemote = undefined;
      if (selected.remote) { selected = local; return local.backend.context(); }
      return local.backend.logout();
    },
  };
  return {
    backend,
    get kind() { return selected.kind; },
    get remote() { return selected.remote; },
    get synchronizes() { return selected.synchronizes; },
    files: (...args) => selected.files(...args),
    open(options) {
      const adapter = selected;
      const onState = state => {
        if (adapter.remote && options.current()) lastRemote = { accountId: options.binding.datasetId, state };
        options.onState(state);
      };
      return adapter.open({ ...options, onState });
    },
    storageChanged(event) { return event.key === browserStorageKey || event.key === null; },
  };
}

export function createStorageAdapter(options) {
  if (options.native) return nativeAdapter(options);
  if (options.mode === 'hosted') return sharedWebAdapter(options);
  if (options.mode === 'web') return apiAdapter(options);
  return domainAdapter({ ...previewStorage(options.domain, options.storage), domain: options.domain, synchronizes: false });
}
