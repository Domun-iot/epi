'use strict';

const { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } = require('node:fs');
const { randomUUID } = require('node:crypto');
const { nameKey } = require('../shared/profile-fields.cjs');
const { upgradeMeasurement } = require('../shared/history.cjs');
const { dirname, join } = require('node:path');
const { isSea } = require('node:sea');

const { dataFolders, resolveDataDirectory } = require('../shared/data-directory.cjs');

const { directory: dataDirectory, shared: sharedData } = resolveDataDirectory(
  isSea() ? dirname(process.execPath) : __dirname,
);

function initializeDataDirectory() {
  if (sharedData) return;
  for (const name of dataFolders) mkdirSync(join(dataDirectory, name), { recursive: true });
}
const profileDirectory = join(dataDirectory, 'profiles');
const measureDirectory = join(dataDirectory, 'measures');

function entries(directory) {
  try { return readdirSync(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

function readMeasurements(root = measureDirectory, identities) {
  const profiles = new Map(identities?.profiles.map(row => [nameKey(row.name), row.uuid]));
  const devices = new Map(identities?.devices.map(row => [row.bluetooth.address, row.uuid]));
  return entries(root).filter(entry => entry.isDirectory()).flatMap(folder => {
    const directory = join(root, folder.name);
    return entries(directory).filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(entry => {
        const path = join(directory, entry.name);
        const record = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/u, ''));
        if (!identities) return record;
        const address = record.device?.bluetooth?.address ?? record.reception?.bluetooth?.address;
        const migrated = upgradeMeasurement(record, record.profile?.name && profiles.get(nameKey(record.profile.name)),
          devices.get(address));
        if (migrated !== record) {
          const temp = path + '.' + randomUUID() + '.tmp';
          writeFileSync(temp, JSON.stringify(migrated, null, 2) + '\n', { flag: 'wx' });
          try { renameSync(temp, path); }
          catch (error) { unlinkSync(temp); throw error; }
        }
        return migrated;
      });
  });
}

function writeMeasurement(record, root = measureDirectory) {
  const name = record.profile?.name;
  if (name != null && !/^[\p{L}\p{N}][\p{L}\p{N} _-]{0,63}$/u.test(name)) {
    throw Error('Nom de profil invalide pour le dossier de pesées.');
  }
  let folder = record.profile?.uuid ?? (name == null ? '_sans-profil' : name.normalize('NFC').toLowerCase().trimEnd());
  if (/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])$/i.test(folder)) folder = '_' + folder;
  const stamp = new Date(record.receivedAt).toISOString().replace(/:/gu, '-');
  const directory = join(root, folder);
  mkdirSync(directory, { recursive: true });
  const contents = JSON.stringify(record, null, 2) + '\n';
  const path = join(directory, stamp + '.json');
  try { writeFileSync(path, contents, { flag: 'wx' }); }
  catch (error) { if (error.code === 'EEXIST') return null; throw error; }
  return path;
}

module.exports = { dataDirectory, initializeDataDirectory, profileDirectory, readMeasurements, writeMeasurement };
