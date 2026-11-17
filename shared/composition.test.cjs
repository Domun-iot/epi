'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { calculateComposition, formatComposition, average, impedanceValue } = require('./composition.cjs');

const profile = { sex: 'H', age: 40, heightCm: 180 };
const reading = { weight: 80, unit: 'kg', impedanceOhms: 500, receivedAt: '2026-11-14T12:00:00Z' };
const display = value => new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(value);
const fatAverage = composition => average(Object.values(composition.methods).map(method => method.fatPercent));

function assertRecovered(event, person, target) {
  const result = calculateComposition({ ...event, impedanceOhms: null, fatPercent: target }, person);
  assert.ok(Number.isFinite(result.estimatedImpedanceOhms), JSON.stringify({ event, person, target }));
  assert.ok(result.estimatedImpedanceOhms >= 1 && result.estimatedImpedanceOhms <= 3000);
  assert.equal(result.impedanceOhms, result.estimatedImpedanceOhms);
  assert.equal(display(fatAverage(result)), display(target));
  return result;
}

test('recovers the displayed whole-method mean across profiles, formula limits and both impedance branches', () => {
  // The values cover the Mi jump, Sun appearance/disappearance, D60 entry,
  // turning points, upper/lower solver bounds and the age/height exclusions.
  for (const sex of ['H', 'F']) for (const age of [18, 40, 61, 94, 95, 100]) {
    for (const heightCm of [100, 180, 250]) for (const weight of [10, 50, 80, 200, 201]) {
      for (const impedanceOhms of [1, 350, 800, 1300, 2200, 3000]) {
        const person = { sex, age, heightCm };
        const event = { weight, unit: 'kg', impedanceOhms };
        const source = calculateComposition(event, person);
        const hasVariableFat = ['Mi', 'Sun*', 'D60*'].some(id => {
          const value = source.methods[id].fatPercent;
          return Number.isFinite(value) && (id !== 'Mi' || (value > 5 && value < 75));
        });
        if (hasVariableFat) assertRecovered(event, person, fatAverage(source));
      }
    }
  }
});

test('preserves all anthropometric methods when fitting the mean, and handles pounds', () => {
  const measured = calculateComposition(reading, profile);
  const recovered = assertRecovered(reading, profile, fatAverage(measured));
  assert.deepEqual(recovered.methods.Deu, measured.methods.Deu);
  assert.deepEqual(recovered.methods.CUN, measured.methods.CUN);
  assert.ok(recovered.methods['Jan*'].skeletalMuscleKg > 0);
  const pounds = assertRecovered({ ...reading, weight: reading.weight / 0.45359237, unit: 'lb' },
    profile, fatAverage(measured));
  assert.equal(pounds.weightKg, 80);
  assert.ok(Math.abs(pounds.estimatedImpedanceOhms - recovered.estimatedImpedanceOhms) < 1e-8);
});

test('accepts a rounded target above the exact maximum, and chooses a deterministic branch', () => {
  const maximumAt = Math.sqrt(26325 / 0.0165);
  const source = calculateComposition({ ...reading, impedanceOhms: maximumAt }, profile);
  const rounded = Number(display(fatAverage(source)));
  assert.ok(rounded > fatAverage(source));
  assertRecovered(reading, profile, rounded);
  const first = assertRecovered(reading, profile, 25.3);
  const second = assertRecovered(reading, profile, 25.3);
  assert.equal(first.estimatedImpedanceOhms, second.estimatedImpedanceOhms);
  assert.ok(first.estimatedImpedanceOhms < maximumAt);
});

test('does not mistake the Mi discontinuity for an attainable mean', () => {
  // At this profile Sun never yields a valid fat percentage. The mean of
  // Mi and Deu jumps from 34 to 40, leaving 37 unattainable.
  const person = { sex: 'H', age: 40, heightCm: 100 };
  const event = { weight: 10, unit: 'kg', impedanceOhms: null, fatPercent: 37 };
  const result = calculateComposition(event, person);
  assert.equal(result.estimatedImpedanceOhms, undefined);
  assert.equal(result.impedanceOhms, null);
  assert.deepEqual(result.methods, calculateComposition({ ...event, fatPercent: undefined }, person).methods);
});

test('keeps impossible, invalid and entirely constant targets without inventing impedance', () => {
  for (const fatPercent of [99.9, 0, 100, -1, NaN, Infinity, '25']) {
    const result = calculateComposition({ ...reading, impedanceOhms: null, fatPercent }, profile);
    assert.equal(result.estimatedImpedanceOhms, undefined);
    assert.equal(result.impedanceOhms, null);
  }
  const person = { sex: 'H', age: 40, heightCm: 250 };
  const event = { weight: 50, unit: 'kg', impedanceOhms: null };
  const target = fatAverage(calculateComposition(event, person));
  assert.ok(Number.isFinite(target));
  const result = calculateComposition({ ...event, fatPercent: target }, person);
  assert.equal(result.estimatedImpedanceOhms, undefined);
  assert.equal(result.impedanceOhms, null);
});

test('uses captured fat percentage and always gives actual impedance priority', () => {
  const expected = calculateComposition(reading, profile);
  const captured = calculateComposition({ ...reading, impedanceOhms: null,
    deviceMetrics: { fatPercent: fatAverage(expected) } }, profile);
  assert.ok(captured.estimatedImpedanceOhms > 0);
  assert.equal(display(fatAverage(captured)), display(fatAverage(expected)));
  assert.deepEqual(calculateComposition({ ...reading, fatPercent: 99, deviceMetrics: { fatPercent: 1 } }, profile), expected);
  assert.deepEqual(calculateComposition({ ...reading, fatPercent: NaN }, profile), expected);
  const manual = { ...reading, impedanceOhms: null, fatPercent: fatAverage(expected) };
  assert.match(formatComposition(manual, profile), /Impédance [\d\s]+ Ω/);
});

test('reads measured or calculated impedance without changing legacy record support', () => {
  assert.equal(impedanceValue({ impedanceOhms: 500 }), 500);
  assert.equal(impedanceValue({ measures: { impedanceOhms: 500 }, calculations: { impedanceOhms: 650 } }), 500);
  for (const impedanceOhms of [null, undefined, 0, -1, NaN, Infinity, '500']) {
    assert.equal(impedanceValue({ measures: { impedanceOhms }, calculations: { impedanceOhms: 650 } }), 650);
    assert.equal(impedanceValue({ measures: { impedanceOhms } }), null);
    assert.equal(impedanceValue({ calculations: { impedanceOhms } }), null);
  }
});
