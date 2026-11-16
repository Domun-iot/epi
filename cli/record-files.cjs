'use strict';

const { readdirSync, readFileSync } = require('node:fs');
const { saveChanges, serialize } = require('../shared/transactions.cjs');
const { randomUUID } = require('node:crypto');
const { basename, dirname, join } = require('node:path');

const uuidFile = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.json$/i;

function listRecordFiles(root, legacyFile, normalize) {
  let files;
  try { files = readdirSync(root, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return files.filter(file => file.isFile() && (uuidFile.test(file.name) || legacyFile.test(file.name))).map(({ name }) => {
    const source = join(root, name);
    const before = readFileSync(source, 'utf8');
    const record = normalize(JSON.parse(before.replace(/^\uFEFF/u, '')), name);
    const uuid = record.uuid ?? (uuidFile.test(name) ? name.slice(0, -5) : randomUUID());
    const file = uuid + '.json';
    if (!uuidFile.test(file)) throw Error('UUID invalide dans ' + name);
    const identified = { ...record, uuid };
    let contents = before;
    if (file.toLowerCase() !== name.toLowerCase()) {
      const folder = basename(root) + '/';
      contents = serialize(identified);
      saveChanges(dirname(root), [
        { path: folder + file, after: contents },
        { path: folder + name, before },
      ]);
    }
    return { file, record: identified, contents };
  });
}

function listProfileFiles(root) {
  return listRecordFiles(root, /^profil-.+\.json$/u, (record, file) => {
    if (!record.name && file.startsWith('profil-')) {
      const stem = file.slice(7, -5);
      record.name = stem[0].toUpperCase() + stem.slice(1);
    }
    return record;
  });
}

module.exports = { listRecordFiles, listProfileFiles };
