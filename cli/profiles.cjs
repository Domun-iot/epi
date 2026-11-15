'use strict';

const { readOptional, saveChanges, serialize } = require('../shared/transactions.cjs');
const { randomUUID } = require('node:crypto');
const { basename, dirname, join } = require('node:path');
const { listProfileFiles } = require('./record-files.cjs');
const { profileDirectory } = require('./storage.cjs');
const { createInterface } = require('node:readline/promises');

const { normalize, normalizeBirth, profileAt, normalizeProfileName, nameKey } = require('../shared/profile-fields.cjs');

const fields = [
  ['sex', 'sexe', 'Sexe utilisé par les formules (H/F)'],
  ['age', 'age', 'Date de naissance (JJ/MM/AAAA) ou âge en années'],
  ['heightCm', 'taille', 'Taille en centimètres'],
];

async function prepareProfile(values, {
  directory = profileDirectory,
  input = process.stdin,
  output = process.stderr,
  filename,
} = {}) {
  const hasFields = values.naissance !== undefined || fields.some(([, flag]) => values[flag] !== undefined);
  if (values.utilisateur === undefined && !hasFields) return null;
  const user = values.utilisateur === undefined ? undefined : normalizeProfileName(values.utilisateur);

  const stored = user === undefined ? undefined : listProfileFiles(directory)
    .find(entry => entry.file === filename || nameKey(entry.record.name) === nameKey(user))?.record;
  const uuid = user === undefined ? undefined : stored?.uuid ?? randomUUID();
  const file = uuid ? join(directory, uuid + '.json') : null;

  const profile = {};
  if (values.naissance !== undefined && values.age !== undefined) throw Error('Choisis --naissance ou --age.');
  const birth = values.naissance ?? (values.age === undefined ? stored?.birthDate : undefined);
  if (birth !== undefined) profile.birthDate = normalizeBirth(birth);
  for (const [key, flag] of fields) {
    if (key === 'age' && profile.birthDate) continue;
    const value = values[flag] ?? stored?.[key];
    if (value !== undefined) profile[key] = normalize(key, value);
  }
  const missing = fields.filter(([key]) => profile[key] === undefined && !(key === 'age' && profile.birthDate));
  if (missing.length) {
    const flags = missing.map(([, flag]) => flag === 'age' ? '--naissance ou --age' : '--' + flag).join(', ');
    const message = file && !stored ? `Aucun profil enregistré pour « ${user} ».` : 'Profil incomplet.';
    if (!input.isTTY) throw Error(`${message} Complète ${flags} avant de relancer.`);
    output.write(`${message} Complète les champs suivants.\n`);
    const questions = createInterface({ input, output });
    const abort = new AbortController();
    questions.once('close', () => abort.abort());
    questions.once('SIGINT', () => questions.close());
    try {
      for (const [key, , label] of missing) {
        while (profile[key] === undefined && !(key === 'age' && profile.birthDate)) {
          const answer = await questions.question(label + ' : ', { signal: abort.signal });
          try {
            if (key === 'age' && /[-/]/.test(answer)) profile.birthDate = normalizeBirth(answer);
            else profile[key] = normalize(key, answer);
          }
          catch (error) { output.write(error.message + '\n'); }
        }
      }
    } catch (error) {
      if (abort.signal.aborted) throw Error('Saisie du profil annulée.');
      throw error;
    } finally {
      questions.close();
    }
  }

  if (file && (!stored?.uuid || hasFields || missing.length)) {
    const record = { ...profile, name: user, uuid };
    if (stored) {
      if (stored.createdAt) record.createdAt = stored.createdAt;
      if (hasFields || missing.length) record.updatedAt = new Date().toISOString();
      else if (stored.updatedAt) record.updatedAt = stored.updatedAt;
    } else {
      record.createdAt = new Date().toISOString();
    }
    saveChanges(dirname(directory), [{
      path: basename(directory) + '/' + basename(file), before: readOptional(file), after: serialize(record),
    }]);
    output.write(`Profil « ${user} » enregistré.\n`);
  }
  return profileAt({ ...profile, user, uuid });
}

module.exports = { normalizeProfileName, prepareProfile, profileAt };
