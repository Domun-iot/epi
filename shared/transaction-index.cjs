'use strict';

const { appendFileSync, readFileSync } = require('node:fs');
const { join } = require('node:path');

const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;

function transactionIndex(root) {
  const path = join(root, 'transactions.index');
  let ids;
  return {
    has(uuid) {
      if (!ids) {
        let contents = '';
        try { contents = readFileSync(path, 'utf8'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        ids = new Set(contents.split('\n').filter(id => uuidPattern.test(id)));
      }
      return ids.has(uuid);
    },
    add(uuid) {
      if (!uuidPattern.test(uuid)) throw new Error('UUID de transaction invalide.');
      appendFileSync(path, uuid + '\n', { mode: 0o600, flush: true });
      ids?.add(uuid);
    },
  };
}

module.exports = { transactionIndex, uuidPattern };
