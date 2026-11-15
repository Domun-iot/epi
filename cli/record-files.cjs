'use strict';

const { readdirSync, readFileSync, writeFileSync, unlinkSync } = require('node:fs');
const { randomUUID } = require('node:crypto');
const { join } = require('node:path');

const uuidFile = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.json$/i;

function listRecordFiles(root, legacyFile, normalize) {
  let files;
  try { files = readdirSync(root, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return files.filter(file => file.isFile() && (uuidFile.test(file.name) || legacyFile.test(file.name))).map(({ name }) => {
    const source = join(root, name);
    const record = normalize(JSON.parse(readFileSync(source, 'utf8').replace(/^\uFEFF/u, '')), name);
    const uuid = record.uuid ?? (uuidFile.test(name) ? name.slice(0, -5) : randomUUID());
    const file = uuid + '.json';
    if (!uuidFile.test(file)) throw Error('UUID invalide dans ' + name);
    if (file.toLowerCase() !== name.toLowerCase()) {
      const target = join(root, file);
      writeFileSync(target, JSON.stringify({ ...record, uuid }, null, 2) + '\n', { flag: 'wx' });
      try { unlinkSync(source); }
      catch (error) {
        unlinkSync(target);
        throw error;
      }
    }
    return { file, record: { ...record, uuid } };
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
