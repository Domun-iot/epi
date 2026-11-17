'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { calculateComposition, average, impedanceValue } = require('./composition.cjs');
const { historyRecord, receptionRecord } = require('./history.cjs');

const profile = { uuid: 'profile-id', user: 'Camille', sex: 'H', age: 40, heightCm: 180 };
const event = { weight: 80, unit: 'kg', impedanceOhms: null, receivedAt: '2020-06-15T12:00:00Z' };
const manual = { source: 'manual', uuid: null };
const mean = composition => average(Object.values(composition.methods).map(method => method.fatPercent));
const display = value => new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(value);

test('stores original fat percentage separately from inferred impedance and dates a manual write now', () => {
  const fatPercent = mean(calculateComposition({ ...event, impedanceOhms: 500 }, profile));
  const before = Date.now();
  const row = historyRecord(Object.freeze({ ...event, fatPercent }), profile, manual);
  const after = Date.now();
  assert.equal(row.measures.fatPercent, fatPercent);
  assert.equal(row.measures.impedanceOhms, null);
  assert.ok(row.calculations.impedanceOhms > 0);
  assert.equal(impedanceValue(row), row.calculations.impedanceOhms);
  assert.equal(display(mean({ methods: row.calculations })), display(fatPercent));
  assert.equal(row.receivedAt, event.receivedAt);
  assert.ok(Date.parse(row.createdAt) >= before && Date.parse(row.createdAt) <= after);
  assert.equal(row.reception, null);
  assert.deepEqual(row.device, manual);
  assert.equal(row.profile.uuid, profile.uuid);
});

test('preserves actual impedance and the original captured fat percentage when they coexist', () => {
  const deviceMetrics = { fatPercent: 17.123456, heartRateBpm: 70 };
  const received = { ...event, impedanceOhms: 500, deviceMetrics };
  const device = { uuid: 'device-id', name: 'Scale', bluetooth: { address: 'AA:BB:CC:DD:EE:FF' } };
  const row = historyRecord(received, profile, device);
  assert.equal(row.measures.impedanceOhms, 500);
  assert.equal(row.measures.fatPercent, deviceMetrics.fatPercent);
  assert.deepEqual(row.measures.deviceMetrics, deviceMetrics);
  assert.equal(row.calculations.impedanceOhms, undefined);
  assert.deepEqual(row.calculations, calculateComposition(received, profile).methods);
  assert.equal(row.createdAt, event.receivedAt);
  assert.deepEqual(row.reception, receptionRecord(received, device.bluetooth.model));
});

test('uses a scale-reported fat percentage when no impedance was captured', () => {
  const fatPercent = mean(calculateComposition({ ...event, impedanceOhms: 500 }, profile));
  const deviceMetrics = { fatPercent, bmi: 24.7 };
  const row = historyRecord({ ...event, deviceMetrics }, profile, { uuid: 'scale-id' });
  assert.equal(row.measures.fatPercent, fatPercent);
  assert.deepEqual(row.measures.deviceMetrics, deviceMetrics);
  assert.equal(row.measures.impedanceOhms, null);
  assert.ok(row.calculations.impedanceOhms > 0);
  assert.notEqual(row.reception, null);
});

test('keeps weight-only anonymous records and legacy calculation results unchanged', () => {
  const anonymous = historyRecord(event, null, manual);
  assert.equal(anonymous.profile, null);
  assert.equal(anonymous.calculations, null);
  assert.deepEqual(anonymous.measures, { weight: 80, unit: 'kg', impedanceOhms: null });
  const legacy = historyRecord(event, profile);
  assert.equal(legacy.createdAt, event.receivedAt);
  assert.deepEqual(legacy.calculations, calculateComposition(event, profile).methods);
  assert.deepEqual(legacy.reception, receptionRecord(event));
  assert.equal(legacy.calculations.impedanceOhms, undefined);
});

test('retains an out-of-range model target with the closest impedance and uses the weigh-in age', () => {
  const row = historyRecord({ ...event, fatPercent: 99.9 }, profile, manual);
  assert.equal(row.measures.fatPercent, 99.9);
  assert.equal(row.measures.impedanceOhms, null);
  assert.ok(row.calculations.impedanceOhms > 0);
  const born = { ...profile, birthDate: '1990-01-01', age: undefined };
  const targetProfile = { ...born, age: 30 };
  const fatPercent = mean(calculateComposition({ ...event, impedanceOhms: 500 }, targetProfile));
  const dated = historyRecord({ ...event, fatPercent }, born, manual);
  assert.equal(dated.profile.ageAtWeighIn, 30);
  assert.equal(display(mean({ methods: dated.calculations })), display(fatPercent));
});
