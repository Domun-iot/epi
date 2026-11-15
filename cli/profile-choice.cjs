'use strict';

const { listProfileFiles } = require('./record-files.cjs');
const { createInterface } = require('node:readline/promises');
const { normalizeProfileName } = require('./profiles.cjs');

const { nameKey } = require('../shared/profile-fields.cjs');

async function listProfiles(directory) {
  const entries = listProfileFiles(directory).map(({ file, record }) => ({
    file, name: record.name, uuid: record.uuid,
  }));
  return entries.sort((a, b) => a.name.localeCompare(b.name, 'fr'));
}

async function chooseProfile(entries, query, { input = process.stdin, output = process.stderr, allowNew = false } = {}) {
  const askForName = allowNew && query === undefined;
  let questions;
  const abort = new AbortController();
  try {
    for (;;) {
      const key = nameKey(query ?? '');
      const exact = key && entries.filter(entry => nameKey(entry.name) === key);
      const matches = exact?.length ? exact : key ? entries.filter(entry => nameKey(entry.name).startsWith(key)) : entries;
      if (key && matches.length === 1) {
        output.write(`Profil sélectionné : ${matches[0].name}\n`);
        return matches[0];
      }
      const canCreate = allowNew && !askForName && key && !matches.length;
      if (canCreate && !entries.length && !input.isTTY) return { name: query.trim() };
      const offered = matches.length ? matches : entries;
      const reason = !key ? 'Choisis un profil pour cette pesée.'
        : matches.length ? `Plusieurs profils correspondent à « ${query} ».`
          : `Aucun profil ne correspond à « ${query} ».`;
      const options = offered.map((entry, i) => `${i + 1}. ${entry.name}`);
      if (askForName) options.unshift('0. Créer un profil');
      else if (canCreate) options.unshift(`0. Créer le profil « ${query} »`);
      const message = reason + '\n' + (options.join('\n') || 'Aucun profil enregistré.');
      if (!input.isTTY || (!offered.length && !askForName && !canCreate)) throw Error(message + '\nIndique ou crée un profil avec --utilisateur.');
      output.write(message + '\n');
      if (!questions) {
        questions = createInterface({ input, output });
        questions.once('close', () => abort.abort());
        questions.once('SIGINT', () => questions.close());
      }
      const newName = canCreate ? query.trim() : null;
      query = (await questions.question('Nom ou numéro du profil : ', { signal: abort.signal })).trim();
      if (query === '0' && askForName) {
        for (;;) {
          const answer = await questions.question('Nom du nouveau profil : ', { signal: abort.signal });
          let name;
          try {
            name = normalizeProfileName(answer);
          } catch (error) {
            output.write(error.message + '\n');
            continue;
          }
          if (!entries.some(entry => nameKey(entry.name) === nameKey(name))) return { name };
          output.write('Ce nom est déjà utilisé.\n');
        }
      }
      if (query === '0' && newName) return { name: newName };
      if (/^[1-9]\d*$/.test(query) && offered[Number(query) - 1]) {
        const selected = offered[Number(query) - 1];
        output.write(`Profil sélectionné : ${selected.name}\n`);
        return selected;
      }
    }
  } catch (error) {
    if (abort.signal.aborted) throw Error('Sélection du profil annulée.');
    throw error;
  } finally {
    questions?.close();
  }
}

module.exports = { nameKey, listProfiles, chooseProfile };
