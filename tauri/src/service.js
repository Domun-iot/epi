import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open, save } from '@tauri-apps/plugin-dialog';
import { readFile, writeFile } from '@tauri-apps/plugin-fs';
import domain from 'virtual:epi-session';
import { createWebSession } from './web-session.js';
import composition from 'virtual:epi-composition';
import { datasetFiles, fileRecords, readArchive, writeArchive } from './legacy-import.js';

export const METHOD_COLUMNS = composition.columns;
export const METRICS = composition.metrics;

const snapshotKey = 'epi-session-v1';
const zipFilters = [{ name: 'Archive ZIP', extensions: ['zip'] }];

export async function connect(onState, onStatus, onRaw) {
  const native = isTauri();
  const web = import.meta.env.MODE === 'web' && !native;
  const storage = native ? {
    load: () => invoke('load_session'),
    save: (session, previous) => invoke('save_session', { session, previous }),
  } : {
    load: () => JSON.parse(localStorage.getItem(snapshotKey) ?? 'null'),
    save: session => localStorage.setItem(snapshotKey, JSON.stringify(session)),
  };
  const session = web ? createWebSession(onState) : domain.createSession({ storage });
  if (web) {
    await session.load();
  } else {
    session.subscribe(onState);
    onState(await session.load());
  }

  function receive(line) {
    onRaw?.(line);
    session.ingest(line).catch(error => onStatus?.('Erreur de traitement Bluetooth · ' + String(error)));
  }

  async function retryBluetooth() {
    if (!native) return;
    await invoke('start_bluetooth');
  }

  if (native) {
    await listen('ble-frame', event => receive(event.payload));
    await listen('ble-status', event => onStatus?.(event.payload));
    onStatus?.('Démarrage du Bluetooth…');
    try {
      await retryBluetooth();
    } catch (error) {
      onStatus?.('Bluetooth indisponible · ' + String(error));
    }
  } else if (web) {
    onStatus?.('Mode web · import ZIP');
  } else {
    onStatus?.('Mode simulation');
    window.addEventListener('epi:frame', event => receive(event.detail));
  }

  async function importBytes(bytes) {
    const current = native ? await invoke('export_files') : datasetFiles(await session.load());
    const paths = new Set(current.map(file => file.path.toLowerCase()));
    const contents = new Set(current.map(file => file.contents));
    const files = readArchive(bytes).filter(file => {
      const path = file.path.toLowerCase();
      if (paths.has(path) || contents.has(file.contents)) return false;
      paths.add(path);
      contents.add(file.contents);
      return true;
    });
    if (!files.length) return 0;
    const records = fileRecords(files);
    if (!native) return session.importLegacy(records);

    // Validate records before merging the original bytes with the shared CLI files.
    await domain.createSession({ storage: { load: () => null, save: () => {} } }).importLegacy(records);
    const added = await invoke('import_files', { files });
    await session.reload();
    return added;
  }

  return {
    ...session,
    retryBluetooth: web ? undefined : retryBluetooth,
    native,
    web,
    async importLegacy(file) {
      return importBytes(new Uint8Array(await file.arrayBuffer()));
    },
    ...(native && {
      async pickLegacy() {
        const path = await open({ multiple: false, filters: zipFilters });
        if (!path) return undefined;
        return importBytes(await readFile(path));
      },
    }),
    async exportData() {
      const filename = 'epi-data-' + new Date().toISOString().slice(0, 10) + '.zip';
      if (native) {
        const path = await save({ defaultPath: filename, filters: zipFilters });
        if (!path) return false;
        await writeFile(path, writeArchive(await invoke('export_files')));
      } else {
        const url = URL.createObjectURL(new Blob([writeArchive(datasetFiles(await session.load()))],
          { type: 'application/zip' }));
        const link = Object.assign(document.createElement('a'), { href: url, download: filename });
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      return true;
    },
  };
}
