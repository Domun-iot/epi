'use strict';

const { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } = require('node:fs');
const { homedir } = require('node:os');
const { dirname, isAbsolute, join } = require('node:path');
const { isSea } = require('node:sea');

const dataFolders = ['devices', 'measures', 'profiles'];

function findSharedData(directory) {
  while (true) {
    const data = join(directory, 'data');
    if (dataFolders.every(name => {
      try { return statSync(join(data, name)).isDirectory(); }
      catch { return false; }
    })) return data;

    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

function userDataDirectory() {
  const base = process.platform === 'win32'
    ? process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
    : (isAbsolute(process.env.XDG_DATA_HOME || '') ? process.env.XDG_DATA_HOME : join(homedir(), '.local', 'share'));
  return join(base, 'fr.epi.balance', 'data');
}

const sharedData = process.env.EPI_DATA_DIR || findSharedData(isSea() ? dirname(process.execPath) : __dirname);
const dataDirectory = sharedData || userDataDirectory();

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

function readMeasurements(root = measureDirectory) {
  return entries(root).filter(entry => entry.isDirectory()).flatMap(folder => {
    const directory = join(root, folder.name);
    return entries(directory).filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(entry => JSON.parse(readFileSync(join(directory, entry.name), 'utf8')));
  });
}

function writeMeasurement(record, root = measureDirectory) {
  const name = record.profile?.name;
  if (name != null && !/^[\p{L}\p{N}][\p{L}\p{N} _-]{0,63}$/u.test(name)) {
    throw Error('Nom de profil invalide pour le dossier de pesées.');
  }
  let folder = name == null ? '_sans-profil' : name.normalize('NFC').toLowerCase().trimEnd();
  if (/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])$/i.test(folder)) folder = '_' + folder;
  const stamp = new Date(record.receivedAt).toISOString().slice(0, 19).replace('T', '-').replace(/:/g, '-');
  const directory = join(root, folder);
  mkdirSync(directory, { recursive: true });
  const contents = JSON.stringify(record, null, 2) + '\n';
  for (let number = 1; ; number++) {
    const path = join(directory, stamp + (number === 1 ? '' : '-' + number) + '.json');
    try {
      writeFileSync(path, contents, { flag: 'wx' });
      return path;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
}

module.exports = { dataDirectory, initializeDataDirectory, profileDirectory, readMeasurements, writeMeasurement };
