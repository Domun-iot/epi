import { localizeMessage, t } from './i18n.js';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open, save } from '@tauri-apps/plugin-dialog';
import { readFile, writeFile } from '@tauri-apps/plugin-fs';
import { domain } from 'virtual:epi-domain';
import { createWebSession } from './web-session.js';
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
  const web = import.meta.env.MODE === 'web' && !native;
  const storage = native ? {
    load: () => invoke('load_session'),
    integrateTransactions: transactions => invoke('integrate_transactions', { transactions }),
    async save(session, previous) {
      if (await invoke('save_session', { session, previous })) onTransactions();
    },
  } : {
    load: () => JSON.parse(localStorage.getItem(snapshotKey) ?? 'null'),
    save: session => localStorage.setItem(snapshotKey, JSON.stringify(session)),
  };
  const session = web ? createWebSession(onState, onTransactions) : domain.createSession({ storage, onWeighing });
  if (!web) {
    session.subscribe(onState);
    onState(await session.load());
  }

  function receive(line) {
    onRaw?.(line);
    if (line.startsWith('PAYLOAD ')) return;
    session.ingest(line).catch(error => {
      if (!recoverDataConflict(error)) {
        onStatus?.(t('bluetoothProcessingError', { detail: localizeMessage(error?.message ?? String(error)) }), true);
      }
    });
  }

  async function retryBluetooth() {
    if (!native) return;
    await invoke('start_bluetooth');
  }

  if (native) {
    await listen('ble-frame', event => receive(event.payload));
    await listen('ble-status', ({ payload }) => onStatus?.(localizeMessage(payload),
      !['epi-i18n:bluetoothStarting', 'epi-i18n:diagnostic.startingBluetoothListening', 'epi-i18n:diagnostic.activeBluetoothListening'].includes(payload)));
    onStatus?.(t('bluetoothStarting'));
    try {
      await retryBluetooth();
    } catch (error) {
      onStatus?.(t('bluetoothUnavailable', { detail: localizeMessage(String(error)) }), true);
    }
  } else if (web) {
    onStatus?.(t('webMode'));
  } else {
    onStatus?.(t('simulationMode'), true);
    window.addEventListener('epi:frame', event => receive(event.detail));
  }

  async function importBytes(bytes) {
    const files = readArchive(bytes);
    if (!files.length) return 0;
    const records = fileRecords(files);
    if (!native && !web) return session.importLegacy(records);

    // Validate the core records before merging the original bytes.
    await domain.createSession({ storage: { load: () => null, save: () => {} } }).importLegacy(records);
    return queueReload(async () => {
      if (web) return session.importFiles(files);
      const added = await invoke('import_files', { files });
      if (added) onTransactions();
      await session.reload();
      return added;
    });
  }

  return {
    ...session,
    ...(native && {
      pendingTransactions: () => invoke('pending_transactions'),
      archiveTransactions: names => invoke('archive_transactions', { names }),
    }),
    retryBluetooth: native ? retryBluetooth : undefined,
    native,
    web,
    async importLegacy(file) {
      return importBytes(new Uint8Array(await file.arrayBuffer()));
    },
    ...(native && {
      async pickLegacy() {
        const path = await open({ title: t('importAZipArchive'), multiple: false, filters: zipFilters });
        if (!path) return undefined;
        return importBytes(await readFile(path));
      },
    }),
    async exportData() {
      const filename = 'epi-data-' + new Date().toISOString().slice(0, 10) + '.zip';
      if (native) {
        const path = await save({ title: t('exportZip'), defaultPath: filename, filters: zipFilters });
        if (!path) return false;
        await writeFile(path, writeArchive(await invoke('export_files')));
      } else {
        const files = web ? await session.exportFiles() : datasetFiles(await session.load());
        const url = URL.createObjectURL(new Blob([writeArchive(files)],
          { type: 'application/zip' }));
        const link = Object.assign(document.createElement('a'), { href: url, download: filename });
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      return true;
    },
  };
}
