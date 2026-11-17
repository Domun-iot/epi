'use strict';

// These are technical search limits, not physiological validity limits.
const MIN_IMPEDANCE = 1;
const MAX_IMPEDANCE = 3000;
const MAX_ITERATIONS = 48;
const roundedPercent = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

function positiveRoots(a, b, c) {
  if (!a) return b ? [-c / b].filter(value => value > 0 && Number.isFinite(value)) : [];
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return [];
  // Avoid subtracting almost equal numbers when finding the smaller root.
  const q = -0.5 * (b + (b < 0 ? -1 : 1) * Math.sqrt(discriminant));
  return [...new Set(q ? [q / a, c / q] : [-b / (2 * a)])]
    .filter(value => value > 0 && Number.isFinite(value)).sort((left, right) => left - right);
}

function estimateImpedance(event, profile, methodsAt) {
  const target = event.fatPercent ?? event.deviceMetrics?.fatPercent;
  const w = event.unit === 'lb' ? event.weight * 0.45359237 : event.weight;
  const { sex, heightCm: h, age } = profile;
  if (!(Number.isFinite(target) && target > 0 && target < 100
      && Number.isFinite(w) && w > 0 && ['kg', 'lb'].includes(event.unit)
      && Number.isFinite(h) && h > 0 && Number.isFinite(age) && age >= 0
      && ['H', 'F'].includes(sex))) return null;

  const male = Number(sex === 'H');
  const boundaries = new Set([MIN_IMPEDANCE, MAX_IMPEDANCE]);
  const seeds = [];
  const models = {};
  const inRange = value => Number.isFinite(value) && value >= MIN_IMPEDANCE && value <= MAX_IMPEDANCE;
  const addBoundary = value => { if (inRange(value)) boundaries.add(value); };

  if (w >= 10 && w <= 200 && h <= 220 && age <= 99) {
    const offset = male ? 0.8 : age <= 49 ? 9.25 : 7.25;
    let multiplier = 1;
    if (male && w < 61) multiplier = 0.98;
    if (!male && (w < 50 || w > 60)) multiplier = (w < 50 ? 1.02 : 0.96) * (h > 160 ? 1.03 : 1);
    const a = 100 * (1 - (9.058 * (h / 100) ** 2 + 0.32 * w + 12.226 - 0.0542 * age - offset) * multiplier / w);
    const b = 0.68 * multiplier / w;
    models.Mi = z => {
      const raw = a + b * z;
      return raw <= 5 ? [5, 0, 0] : raw > 63 ? [75, 0, 0] : [a, b, 0];
    };
    addBoundary((5 - a) / b);
    addBoundary((63 - a) / b);
    if (target >= 5 && target <= 63) seeds.push((target - a) / b);
  }
  if (age <= 94) {
    const coefficient = male ? 0.65 : 0.69;
    const constant = male ? -10.68 + 0.26 * w : -9.53 + 0.17 * w;
    const model = [100 * (1 - constant / w), -2 / w, -100 * coefficient * h ** 2 / w];
    models['Sun*'] = () => model;
    for (const lean of [0, w]) {
      for (const root of positiveRoots(0.02, constant - lean, coefficient * h ** 2)) addBoundary(root);
    }
    seeds.push(...positiveRoots(0.02, constant - w * (1 - target / 100), coefficient * h ** 2));
  }
  if (age > 60) {
    const constant = 3.9 + 3.1 * male;
    const model = [100 * (1 - constant / w), 0, -67.1 * h ** 2 / w];
    models['D60*'] = () => model;
    if (w > constant) addBoundary(0.671 * h ** 2 / (w - constant));
    const denominator = w * (1 - target / 100) - constant;
    if (denominator > 0) seeds.push(0.671 * h ** 2 / denominator);
  }

  const cache = new Map();
  function evaluate(z) {
    if (!cache.has(z)) {
      const methods = methodsAt(z);
      const available = Object.entries(methods).filter(([, values]) => Number.isFinite(values?.fatPercent));
      const sum = available.reduce((value, [, values]) => value + values.fatPercent, 0);
      // On each interval the mean is A + B*z + C/z. Constants such as Deu
      // and CUN contribute to A and to the same denominator as the UI.
      const coefficients = available.reduce((total, [id, values]) => {
        const model = models[id]?.(z) ?? [values.fatPercent, 0, 0];
        return total.map((value, index) => value + model[index]);
      }, [0, 0, 0]);
      cache.set(z, { value: available.length ? sum / available.length : null, coefficients, count: available.length });
    }
    return cache.get(z);
  }
  const targetDisplay = roundedPercent.format(target);
  const matches = z => {
    if (!inRange(z)) return false;
    const { value, coefficients: [, b, c] } = evaluate(z);
    // A constant estimate alone cannot identify any impedance.
    return Number.isFinite(value) && (b !== 0 || c !== 0) && roundedPercent.format(value) === targetDisplay;
  };
  const seed = seeds.find(inRange) ?? 500;
  if (matches(seed)) return seed;

  const points = [...boundaries].sort((left, right) => left - right);
  const segments = [];
  for (let index = 1; index < points.length; index += 1) {
    const low = points[index - 1];
    const high = points[index];
    const [, b, c] = evaluate((low + high) / 2).coefficients;
    if (b === 0 && c === 0) continue;
    const extremum = b && c / b > 0 ? Math.sqrt(c / b) : null;
    if (extremum > low && extremum < high) segments.push([low, extremum], [extremum, high]);
    else segments.push([low, high]);
  }
  const distance = ([low, high]) => seed < low ? low - seed : seed > high ? seed - high : 0;
  segments.sort((left, right) => distance(left) - distance(right) || left[0] - right[0]);

  for (const [low, high] of segments) {
    const candidates = [low, high, (low + high) / 2, ...seeds.filter(value => value > low && value < high)]
      .sort((left, right) => Math.abs(left - seed) - Math.abs(right - seed));
    for (const candidate of candidates) if (matches(candidate)) return candidate;

    const midpoint = (low + high) / 2;
    const { value: middleValue, coefficients: [, b, c], count } = evaluate(midpoint);
    // Use the continuous one-sided limits of this segment for bracketing.
    // At a formula's availability boundary, floating-point evaluation of the
    // exact endpoint can include the other segment's method denominator.
    const limitAt = z => middleValue + (b * (z - midpoint) + c * (1 / z - 1 / midpoint)) / count;
    const leftValue = limitAt(low);
    const rightValue = limitAt(high);
    const roundedTarget = Number(targetDisplay);
    if (!Number.isFinite(leftValue) || !Number.isFinite(rightValue)
        || roundedTarget < Number(roundedPercent.format(Math.min(leftValue, rightValue)))
        || roundedTarget > Number(roundedPercent.format(Math.max(leftValue, rightValue)))) continue;
    const increasing = leftValue < rightValue;
    let left = low;
    let right = high;
    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration += 1) {
      const middle = (left + right) / 2;
      if (middle === left || middle === right) break;
      if (matches(middle)) return middle;
      const value = evaluate(middle).value;
      if (!Number.isFinite(value)) break;
      if ((value < target) === increasing) left = middle;
      else right = middle;
    }
  }
  return null;
}

module.exports = { estimateImpedance };
