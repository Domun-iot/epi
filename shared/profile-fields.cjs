'use strict';

const nameKey = name => name.trim().normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

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

module.exports = { nameKey, normalize, normalizeBirth, profileAt, normalizeProfileName };
