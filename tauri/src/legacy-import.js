import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
const types = /^(profiles\/(?:profil-[^/]+|[0-9a-f-]{36})\.json|devices\/[^/]+\.json|measures\/[^/]+\/[^/]+\.json)$/u;

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
        if (!row.name && path.startsWith('profiles/profil-')) {
          const stem = path.slice('profiles/profil-'.length, -5);
          row.name = stem[0].toLocaleUpperCase('fr') + stem.slice(1);
        }
        if (!row.uuid && !path.startsWith('profiles/profil-')) row.uuid = path.slice('profiles/'.length, -5);
        archive.profiles.push(row);
      } else if (path.startsWith('devices/')) {
        const stem = path.slice('devices/'.length, -5);
        if (!row.uuid && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(stem)) row.uuid = stem;
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

  for (const profile of state.profiles) add(`profiles/${profile.uuid}.json`, profile);
  for (const device of state.devices) add(`devices/${device.uuid}.json`, device);
  for (const reading of state.measurements) {
    let folder = reading.profile?.uuid ?? reading.profile?.name?.toLowerCase() ?? '_sans-profil';
    if (/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])$/iu.test(folder)) folder = '_' + folder;
    const stamp = new Date(reading.receivedAt).toISOString().replace(/:/gu, '-');
    const path = `measures/${folder}/${stamp}.json`;
    if (!paths.has(path)) add(path, reading);
  }
  return files;
}
