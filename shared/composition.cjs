'use strict';

const columns = [
  ['IMC', 'Indice de masse corporelle'],
  ['Mi', 'Mi Fit communautaire (rétro-ingénierie)'],
  ['Sun*', 'Sun et al. (2003)'],
  ['Jan*', 'Janssen et al. (2000)'],
  ['D60*', 'Deurenberg et al. (1990), après 60 ans'],
  ['Deu', 'Deurenberg et al. (1991)'],
  ['CUN', 'Gómez-Ambrosi et al. (CUN-BAE, 2012)'],
  ['Wat', 'Watson et al. (1980)'],
  ['HW', 'Hume et Weyers (1971)'],
  ['MSJ', 'Mifflin–St Jeor et al. (1990)'],
  ['HB', 'Harris–Benedict révisé par Roza et Shizgal (1984)'],
  ['Owe', 'Owen et al. (1986–1987, formule poids)'],
  ['Cun*', 'Cunningham (1980), avec la masse maigre de Sun'],
];

const metrics = [
  ['bmi', 'IMC (kg/m²)'],
  ['fatPercent', 'Masse grasse (%)'],
  ['fatKg', 'Masse grasse (kg)'],
  ['leanKg', 'Masse maigre (kg)'],
  ['fmi', 'Indice masse grasse (kg/m²)'],
  ['ffmi', 'Indice masse maigre (kg/m²)'],
  ['waterL', 'Eau totale (L)'],
  ['waterPercent', 'Eau totale (% du poids)'],
  ['muscleKg', 'Masse musculaire Mi Fit (kg)'],
  ['skeletalMuscleKg', 'Muscle squelettique (kg)'],
  ['boneKg', 'Masse osseuse estimée (kg)'],
  ['proteinPercent', 'Protéines estimées (%)'],
  ['visceralScore', 'Score de graisse viscérale'],
  ['restingEnergy', 'Énergie au repos (kcal/j)', 0],
  ['metabolicAge', 'Âge métabolique (ans)', 0],
];

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

function fromFat(fatPercent, weight, heightSquared) {
  if (!(fatPercent > 0 && fatPercent < 100)) return {};
  const fatKg = weight * fatPercent / 100;
  const leanKg = weight - fatKg;
  return { fatPercent, fatKg, leanKg, fmi: fatKg / heightSquared, ffmi: leanKg / heightSquared };
}

function fromWater(waterL, weight) {
  // 1 L of body water is approximated as 1 kg for the percentage.
  return waterL > 0 && waterL < weight ? { waterL, waterPercent: 100 * waterL / weight } : {};
}

function miFit(w, h, age, male, z, h2) {
  if (w < 10 || w > 200 || h > 220 || age > 99) return {};
  const energy = male ? 877.8 + 14.916 * w - 0.726 * h - 8.976 * age
    : 864.6 + 10.2036 * w - 0.39336 * h - 6.204 * age;
  let visceral;
  if (male) {
    visceral = h < 1.6 * w
      ? 305 * w / (0.0826 * h ** 2 - 0.4 * h + 48) - 2.9 + 0.15 * age
      : (0.765 - 0.0015 * h) * w - 0.143 * h + 0.15 * age - 5;
  } else {
    visceral = w > 0.5 * h - 13
      ? 500 * w / (1.45 * h + 0.1158 * h ** 2 - 120) - 6 + 0.07 * age
      : (0.691 - 0.0048 * h) * w - 0.027 * h - 0.93 * age;
  }
  const result = {
    restingEnergy: energy > (male ? 2322 : 2996) ? 5000 : clamp(energy, 500, 10000),
    visceralScore: clamp(visceral, 1, 50),
  };
  if (!(z > 0 && z <= 3000)) return result;

  const coefficient = 9.058 * h2 + 0.32 * w + 12.226 - 0.0068 * z - 0.0542 * age;
  const offset = male ? 0.8 : age <= 49 ? 9.25 : 7.25;
  let multiplier = 1;
  if (male && w < 61) multiplier = 0.98;
  if (!male && (w < 50 || w > 60)) multiplier = (w < 50 ? 1.02 : 0.96) * (h > 160 ? 1.03 : 1);
  const rawFat = 100 * (1 - (coefficient - offset) * multiplier / w);
  const fat = fromFat(clamp(rawFat > 63 ? 75 : rawFat, 5, 75), w, h2);
  const rawWater = 0.7 * (100 - fat.fatPercent);
  const waterFactor = rawWater <= 50 ? 1.02 : 0.98;
  const waterPercent = clamp((rawWater * waterFactor >= 65 ? 75 : rawWater) * waterFactor, 35, 75);
  let boneKg = coefficient * 0.05158 - (male ? 0.18016894 : 0.245691014);
  boneKg += boneKg > 2.2 ? 0.1 : -0.1;
  boneKg = clamp(boneKg > (male ? 5.2 : 5.1) ? 8 : boneKg, 0.5, 8);
  const muscle = fat.leanKg - boneKg;
  const muscleKg = clamp(muscle >= (male ? 93.5 : 84) ? 120 : muscle, 10, 120);
  const metabolicAge = male ? -0.7471 * h + 0.9161 * w + 0.4184 * age + 0.0517 * z + 54.2267
    : -1.1165 * h + 1.5784 * w + 0.4615 * age + 0.0415 * z + 83.2548;
  return { ...result, ...fat, waterPercent, waterL: w * waterPercent / 100, boneKg, muscleKg,
    proteinPercent: clamp(100 * muscleKg / w - waterPercent, 5, 32),
    metabolicAge: clamp(metabolicAge, 15, 80) };
}

function calculateComposition(event, { sex, age, heightCm: h }) {
  const w = event.unit === 'lb' ? event.weight * 0.45359237 : event.weight;
  const z = event.impedanceOhms;
  const male = Number(sex === 'H');
  const female = 1 - male;
  const h2 = (h / 100) ** 2;
  const bmi = w / h2;
  const bmi2 = bmi ** 2;
  const result = { weightKg: w, impedanceOhms: z, methods: {
    IMC: { bmi },
    Mi: miFit(w, h, age, male, z, h2),
    'Sun*': {},
    'Jan*': {},
    'D60*': {},
    Deu: fromFat(1.2 * bmi + 0.23 * age - 10.8 * male - 5.4, w, h2),
    CUN: fromFat(-44.988 + 0.503 * age + 10.689 * female + 3.172 * bmi - 0.026 * bmi2
      + 0.181 * bmi * female - 0.02 * bmi * age - 0.005 * bmi2 * female
      + 0.00021 * bmi2 * age, w, h2),
    Wat: fromWater(male ? 2.447 - 0.09516 * age + 0.1074 * h + 0.3362 * w
      : -2.097 + 0.1069 * h + 0.2466 * w, w),
    HW: fromWater(male ? -14.012934 + 0.194786 * h + 0.296785 * w
      : -35.270121 + 0.344547 * h + 0.183809 * w, w),
    MSJ: { restingEnergy: 9.99 * w + 6.25 * h - 4.92 * age + 166 * male - 161 },
    HB: { restingEnergy: male ? 88.362 + 13.397 * w + 4.799 * h - 5.677 * age
      : 447.593 + 9.247 * w + 3.098 * h - 4.330 * age },
    Owe: { restingEnergy: male ? 879 + 10.2 * w : 795 + 7.18 * w },
    'Cun*': {},
  } };
  if (z > 0) {
    // The Xiaomi packet supplies only one impedance value. Use it as an R proxy.
    const index = h ** 2 / z;
    if (age <= 94) {
      const lean = male ? -10.68 + 0.65 * index + 0.26 * w + 0.02 * z
        : -9.53 + 0.69 * index + 0.17 * w + 0.02 * z;
      const water = male ? 1.20 + 0.45 * index + 0.18 * w : 3.75 + 0.45 * index + 0.11 * w;
      const masses = fromFat(100 * (1 - lean / w), w, h2);
      result.methods['Sun*'] = { ...masses, ...fromWater(water, w) };
      if (masses.leanKg) result.methods['Cun*'] = { restingEnergy: 500 + 22 * masses.leanKg };
    }
    if (age > 60) {
      const lean = 3.9 + 0.671 * index + 3.1 * male;
      result.methods['D60*'] = fromFat(100 * (1 - lean / w), w, h2);
    }
    if (age <= 86) {
      const skeletalMuscleKg = 0.401 * index + 3.825 * male - 0.071 * age + 5.102;
      if (skeletalMuscleKg > 0 && skeletalMuscleKg < w) result.methods['Jan*'] = { skeletalMuscleKg };
    }
  }
  return result;
}

function average(values) {
  const available = values.filter(Number.isFinite);
  return available.length ? available.reduce((sum, value) => sum + value, 0) / available.length : null;
}

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'medium' });

function formatComposition(event, profile) {
  const { weightKg, impedanceOhms, methods } = calculateComposition(event, profile);
  const receivedAt = new Date(event.receivedAt);
  const date = Number.isNaN(+receivedAt) ? '—' : dateTime.format(receivedAt);
  const number = (n, digits) => n.toLocaleString('fr-FR', { maximumFractionDigits: Math.min(digits, 1) });
  const lines = [
    '',
    `Pesée ${profile.user ? profile.user + ' · ' : ''}${date} · ${event.address}`,
    `Poids mesuré ${number(weightKg, 1)} kg · Impédance ${impedanceOhms ? number(impedanceOhms, 0) + ' Ω' : 'en attente ou absente'}`,
    ...columns.map(([short, name]) => `  ${short} = ${name}`),
    '  * Impédance pieds à pieds utilisée en approximation de la résistance corps entier. — = indisponible.',
  ];
  const rows = [['Donnée', 'Moyenne', ...columns.map(([id]) => id)]];
  for (const [metric, label, digits = 1] of metrics) {
    const values = columns.map(([id]) => {
      const value = methods[id][metric];
      return value > 0 ? value : null;
    });
    const format = value => Number.isFinite(value) ? number(value, digits) : '—';
    rows.push([label, format(average(values)), ...values.map(format)]);
  }
  const widths = rows[0].map((_, i) => Math.max(...rows.map(row => row[i].length)));
  const rowText = ([label, ...values]) => [label.padEnd(widths[0]),
    ...values.map((value, i) => value.padStart(widths[i + 1]))].join(' | ');
  return [...lines, rowText(rows[0]), widths.map(n => '-'.repeat(n)).join('-+-'),
    ...rows.slice(1).map(rowText)].join('\n');
}

module.exports = { calculateComposition, formatComposition, average, columns, metrics };
