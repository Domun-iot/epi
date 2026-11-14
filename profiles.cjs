'use strict';

const { mkdir, readFile, rename, unlink, writeFile } = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const { join } = require('node:path');
const { profileDirectory } = require('./storage.cjs');
const { createInterface } = require('node:readline/promises');

const fields = [
  ['sex', 'sexe', 'Sexe utilisé par les formules (H/F)'],
  ['age', 'age', 'Date de naissance (JJ/MM/AAAA) ou âge en années'],
  ['heightCm', 'taille', 'Taille en centimètres'],
];

function normalize(key, value) {
  if (key === 'sex') {
    const sex = String(value).trim().toUpperCase();
    if (['H', 'HOMME', 'M', 'MALE'].includes(sex)) return 'H';
    if (['F', 'FEMME', 'FEMALE'].includes(sex)) return 'F';
    throw Error('Indique --sexe H ou --sexe F.');
  }
  const input = String(value).trim().replace(',', '.');
  const number = /^\d+(?:\.\d+)?$/.test(input) ? Number(input) : NaN;
  if (key === 'age') {
    if (Number.isInteger(number) && number >= 18 && number <= 120) return number;
    throw Error('Indique --age en années entières, entre 18 et 120.');
  }
  if (number >= 100 && number <= 250) return number;
  throw Error('Indique --taille en centimètres, entre 100 et 250.');
}

const parisDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
});

function ageAt(birthDate, when = new Date()) {
  const parts = Object.fromEntries(parisDate.formatToParts(new Date(when)).map(({ type, value }) => [type, value]));
  const [year, month, day] = birthDate.split('-').map(Number);
  return Number(parts.year) - year - Number(+parts.month < month || (+parts.month === month && +parts.day < day));
}

function normalizeBirth(value) {
  const input = String(value).trim();
  const french = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(input);
  const iso = french ? [french[3], french[2].padStart(2, '0'), french[1].padStart(2, '0')].join('-') : input;
  const date = new Date(iso + 'T00:00:00Z');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || !Number.isFinite(+date)
      || date.toISOString().slice(0, 10) !== iso || ageAt(iso) < 18 || ageAt(iso) > 120) {
    throw Error('Indique une date de naissance valide (JJ/MM/AAAA ou AAAA-MM-JJ), pour un âge de 18 à 120 ans.');
  }
  return iso;
}

function profileAt(profile, when) {
  if (!profile?.birthDate) return profile;
  return { ...profile, age: ageAt(profile.birthDate, when) };
}

function normalizeProfileName(value) {
  const name = value.trim().normalize('NFC');
  if (!/^[\p{L}\p{N}][\p{L}\p{N} _-]{0,63}$/u.test(name)) {
    throw Error('Indique un nom d’utilisateur de 1 à 64 caractères (lettres, chiffres, espaces, _ ou -).');
  }
  return name;
}

async function prepareProfile(values, {
  directory = profileDirectory,
  input = process.stdin,
  output = process.stderr,
  filename,
} = {}) {
  const hasFields = values.naissance !== undefined || fields.some(([, flag]) => values[flag] !== undefined);
  if (values.utilisateur === undefined && !hasFields) return null;
  const user = values.utilisateur === undefined ? undefined : normalizeProfileName(values.utilisateur);

  // The prefix also avoids reserved Windows names such as CON and NUL.
  const file = user === undefined ? null : join(directory, filename ?? ('profil-' + user.normalize('NFC').toLowerCase() + '.json'));
  let stored;
  if (file) {
    try {
      stored = JSON.parse(await readFile(file, 'utf8'));
      if (!stored || typeof stored !== 'object' || Array.isArray(stored)) throw Error('Objet JSON attendu.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw Error(`Impossible de lire le profil « ${user} » (${error.message}).`);
    }
  }

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

  if (file && (!stored || hasFields || missing.length)) {
    await mkdir(directory, { recursive: true });
    const temp = file + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(temp, JSON.stringify({ ...profile, name: user }, null, 2) + '\n', { flag: 'wx' });
      await rename(temp, file);
    } finally {
      await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    output.write(`Profil « ${user} » enregistré.\n`);
  }
  return profileAt({ ...profile, user });
}

module.exports = { normalizeProfileName, prepareProfile, profileAt };
