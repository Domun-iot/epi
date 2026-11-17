'use strict';

const { statSync } = require('node:fs');
const { homedir } = require('node:os');
const { dirname, isAbsolute, join } = require('node:path');

const dataFolders = ['devices', 'measures', 'profiles'];

function isDataRoot(data) {
  const directory = path => {
    try { return statSync(path).isDirectory(); }
    catch { return false; }
  };
  const file = path => {
    try { return statSync(path).isFile(); }
    catch { return false; }
  };
  return dataFolders.every(name => directory(join(data, name)))
    || directory(join(data, 'local')) || directory(join(data, 'accounts'))
    || file(join(data, 'installation.json')) || file(join(data, 'migration.json'));
}

function findSharedData(directory) {
  while (true) {
    const data = join(directory, 'data');
    if (isDataRoot(data)) return data;

    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

function userDataDirectory() {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'fr.epi.balance', 'data');
  const base = process.platform === 'win32'
    ? process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
    : (isAbsolute(process.env.XDG_DATA_HOME || '') ? process.env.XDG_DATA_HOME : join(homedir(), '.local', 'share'));
  return join(base, 'fr.epi.balance', 'data');
}

function resolveDataDirectory(startDirectory) {
  return process.env.EPI_DATA_DIR || findSharedData(startDirectory) || userDataDirectory();
}

module.exports = { dataFolders, resolveDataDirectory, findSharedData, isDataRoot };
