'use strict';

const { mkdirSync, readdirSync, readFileSync } = require('node:fs');
const { readOptional, saveChanges, serialize } = require('../shared/transactions.cjs');
const { nameKey } = require('../shared/profile-fields.cjs');
const { upgradeMeasurement } = require('../shared/history.cjs');
const { basename, dirname, join } = require('node:path');
const { isSea } = require('node:sea');

const { dataFolders, resolveDataDirectory } = require('../shared/data-directory.cjs');
const { resolveActiveDataset } = require('../shared/account-storage.cjs');
const { withInstallationLock } = require('../shared/installation-lock.cjs');

const installationRoot = resolveDataDirectory(isSea() ? dirname(process.execPath) : __dirname);
// Importing CLI helpers must not migrate the user's files (tests and --help also import them).
let initialSettings = {};
try { initialSettings = JSON.parse(readFileSync(join(installationRoot, 'installation.json'), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
if (initialSettings.activeAccountId != null && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(initialSettings.activeAccountId)) throw Error('Invalid account UUID.');
const datasetContext = { datasetId: initialSettings.activeAccountId ?? 'local', datasetGeneration: initialSettings.datasetGeneration ?? 0 };
const dataDirectory = initialSettings.activeAccountId ? join(installationRoot, 'accounts', initialSettings.activeAccountId) : join(installationRoot, 'local');
function assertActiveDataset() {
  resolveActiveDataset(installationRoot, datasetContext.datasetId, datasetContext.datasetGeneration);
}

function withActiveDataset(callback) {
  return withInstallationLock(installationRoot, () => { assertActiveDataset(); return callback(); });
}

function initializeDataDirectory() {
  assertActiveDataset();
  for (const name of dataFolders) mkdirSync(join(dataDirectory, name), { recursive: true });
}
const profileDirectory = join(dataDirectory, 'profiles');
const measureDirectory = join(dataDirectory, 'measures');

function entries(directory) {
  try { return readdirSync(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

function readMeasurements(root = measureDirectory, identities) {
  if (root === measureDirectory) assertActiveDataset();
  const profiles = new Map(identities?.profiles.map(row => [nameKey(row.name), row.uuid]));
  const devices = new Map(identities?.devices.map(row => [row.bluetooth.address, row.uuid]));
  return entries(root).filter(entry => entry.isDirectory()).flatMap(folder => {
    const directory = join(root, folder.name);
    return entries(directory).filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(entry => {
        const path = join(directory, entry.name);
        const before = readFileSync(path, 'utf8');
        const record = JSON.parse(before.replace(/^\uFEFF/u, ''));
        if (!identities) return record;
        const address = record.device?.bluetooth?.address ?? record.reception?.bluetooth?.address;
        const migrated = upgradeMeasurement(record, record.profile?.name && profiles.get(nameKey(record.profile.name)),
          devices.get(address));
        if (migrated !== record) {
          saveChanges(dirname(root), [{
            path: [basename(root), folder.name, entry.name].join('/'), before, after: serialize(migrated),
          }]);
        }
        return migrated;
      });
  });
}

function writeMeasurement(record, root = measureDirectory) {
  if (root === measureDirectory) assertActiveDataset();
  const name = record.profile?.name;
  if (name != null && !/^[\p{L}\p{N}][\p{L}\p{N} _-]{0,63}$/u.test(name)) {
    throw Error('Nom de profil invalide pour le dossier de pesées.');
  }
  let folder = record.profile?.uuid ?? (name == null ? '_sans-profil' : name.normalize('NFC').toLowerCase().trimEnd());
  if (/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])$/i.test(folder)) folder = '_' + folder;
  const stamp = new Date(record.receivedAt).toISOString().replace(/:/gu, '-');
  const directory = join(root, folder);
  const path = join(directory, stamp + '.json');
  const relative = [basename(root), folder, stamp + '.json'].join('/');
  if (readOptional(path) !== undefined) return null;
  try { saveChanges(dirname(root), [{ path: relative, after: serialize(record) }]); }
  catch (error) { if (error.code === 'EEXIST') return null; throw error; }
  return path;
}

module.exports = { assertActiveDataset, withActiveDataset, dataDirectory, profileDirectory,
  initializeDataDirectory: () => withActiveDataset(initializeDataDirectory),
  readMeasurements: (root = measureDirectory, identities) => root === measureDirectory
    ? withActiveDataset(() => readMeasurements(root, identities)) : readMeasurements(root, identities),
  writeMeasurement: (record, root = measureDirectory) => root === measureDirectory
    ? withActiveDataset(() => writeMeasurement(record, root)) : writeMeasurement(record, root),
};
