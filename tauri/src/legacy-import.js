import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { recordPath } from '../../web/file-records.js';
export { fileRecords } from '../../web/file-records.js';

function dataPath(name) {
  const path = name.replace(/^\.\//u, '');
  if (path.split('/').some(part => part === '..' || part.includes('\\') || part.includes(':'))) {
    return null;
  }
  if (recordPath.test(path)) return path;
  const marker = path.indexOf('data/');
  if (marker < 0 || (marker !== 0 && path[marker - 1] !== '/')) return null;
  const relative = path.slice(marker + 'data/'.length);
  return recordPath.test(relative) ? relative : null;
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
