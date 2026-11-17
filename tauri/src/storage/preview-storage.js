import { snapshotKey } from '../preferences.js';
import { fileRecords } from '../../../web/file-records.js';

const browserInstallationKey = 'epi-installation-v1';
const browserSnapshotKey = id => id === 'local' ? snapshotKey : snapshotKey + ':' + id;
export function previewBackend(domain, localStorage) {
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

export function previewStorage(domain, localStorage) {
  return { kind: 'preview', backend: previewBackend(domain, localStorage),
    files: binding => ({
      load: () => JSON.parse(localStorage.getItem(browserSnapshotKey(binding.datasetId)) ?? 'null'),
      save: state => localStorage.setItem(browserSnapshotKey(binding.datasetId), JSON.stringify(state)),
    }) };
}
