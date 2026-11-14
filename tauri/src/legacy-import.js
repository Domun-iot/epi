import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import domain from 'virtual:epi-session';

const { deviceFileKey } = domain;

const types = /^(profiles\/profil-[^/]+\.json|devices\/[^/]+\.json|measures\/[^/]+\/[^/]+\.json)$/u;

function dataPath(name) {
  const path = name.replace(/^\.\//u, '');
  if (path.split('/').some(part => part === '..' || part.includes('\\') || part.includes(':'))) {
    return null;
  }
  if (types.test(path)) return path;
  const marker = path.indexOf('data/');
  if (marker < 0 || (marker !== 0 && path[marker - 1] !== '/')) return null;
  const relative = path.slice(marker + 'data/'.length);
  return types.test(relative) ? relative : null;
}

export function readArchive(bytes) {
  let dataDirectory = false;
  const packed = unzipSync(bytes, { filter: entry => {
    if (/^(?:\.\/)?data\/$/u.test(entry.name)) dataDirectory = true;
    return dataPath(entry.name) !== null;
  } });
  const files = Object.entries(packed).map(([name, contents]) => ({
    path: dataPath(name), contents: strFromU8(contents),
  }));
  if (!files.length && !dataDirectory) throw new Error('Le ZIP ne contient aucune donnée éPI.');
  return files;
}

export function writeArchive(files) {
  return zipSync({
    'data/': new Uint8Array(),
    ...Object.fromEntries(files.map(file => ['data/' + file.path, strToU8(file.contents)])),
  });
}

export function fileRecords(files) {
  const archive = { profiles: [], devices: [], measurements: [] };
  for (const { path, contents } of files) {
    try {
      const row = JSON.parse(contents.replace(/^\uFEFF/u, ''));
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Objet JSON attendu.');
      if (path.startsWith('profiles/')) {
        if (!row.name) {
          const stem = path.slice('profiles/profil-'.length, -5);
          row.name = stem[0].toLocaleUpperCase('fr') + stem.slice(1);
        }
        archive.profiles.push(row);
      } else if (path.startsWith('devices/')) {
        archive.devices.push(row);
      } else {
        archive.measurements.push(row);
      }
    } catch (error) {
      throw new Error(path + ' · ' + error.message);
    }
  }
  return archive;
}

export function datasetFiles(state) {
  const files = [];
  const paths = new Set();
  function add(path, record) {
    files.push({ path, contents: JSON.stringify(record, null, 2) + '\n' });
    paths.add(path);
  }

  for (const profile of state.profiles) add(`profiles/profil-${profile.name.toLowerCase()}.json`, profile);
  for (const device of state.devices) add(`devices/${deviceFileKey(device.name)}.json`, device);
  for (const reading of state.measurements) {
    let folder = reading.profile?.name?.toLowerCase() ?? '_sans-profil';
    if (/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])$/iu.test(folder)) folder = '_' + folder;
    const stamp = new Date(reading.receivedAt).toISOString().slice(0, 19).replace(/[T:]/gu, '-');
    const base = `measures/${folder}/${stamp}`;
    let path = base + '.json';
    let index = 1;
    while (paths.has(path)) path = `${base}-${++index}.json`;
    add(path, reading);
  }
  return files;
}
