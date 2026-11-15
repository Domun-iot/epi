'use strict';

const { statSync } = require('node:fs');
const { homedir } = require('node:os');
const { dirname, isAbsolute, join } = require('node:path');

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

function resolveDataDirectory(startDirectory) {
  const shared = process.env.EPI_DATA_DIR || findSharedData(startDirectory);
  return { directory: shared || userDataDirectory(), shared: Boolean(shared) };
}

module.exports = { dataFolders, resolveDataDirectory };
