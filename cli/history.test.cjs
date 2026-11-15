'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { bufferHistory, historyRecord, latestWeights, matchWeight } = require('./history.cjs');
const { chooseProfile } = require('./profile-choice.cjs');

test('writes the complete reading instead of the matching weight-only reading within fifteen seconds', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const saved = [];
  const record = bufferHistory(event => saved.push(event));
  const weightOnly = { address: 'A', scaleTime: '12:00:00', weight: 70, unit: 'kg', impedanceOhms: null };
  const anotherWeighing = { ...weightOnly, scaleTime: '12:00:01' };
  const complete = { ...weightOnly, impedanceOhms: 450, receivedAt: '12:00:14' };
  record(weightOnly);
  record(anotherWeighing);
  t.mock.timers.tick(14999);
  assert.deepEqual(saved, []);
  record(complete);
  assert.deepEqual(saved, [complete]);
  t.mock.timers.tick(1);
  assert.deepEqual(saved, [complete]);
});

test('saves the first complete reading immediately and keeps the original payload', () => {
  const { createReceiver } = require('./scale.cjs');
  const hex = '0226e40709060d2605e9015a37';
  const event = createReceiver({ includeHex: true })('AABBCCDDEEFF -58 ' + hex);
  const saved = [];
  const device = { name: 'Balance', uuid: '3c287584-2521-47b2-be8e-545ec09ae681' };
  bufferHistory(reading => saved.push(historyRecord(reading, null, device)))(event);
  assert.equal(saved.length, 1);
  assert.match(saved[0].uuid, /^[\da-f-]{36}$/);
  assert.equal(saved[0].device.uuid, device.uuid);
  assert.equal(saved[0].profile, null);
  assert.deepEqual(saved[0].device, device);
  assert.deepEqual(saved[0].measures, { weight: 70.85, unit: 'kg', impedanceOhms: 489 });
  assert.deepEqual(saved[0].reception, {
    raw: { hex },
    bluetooth: { serviceUuid: '0x181B', service: 'Body Composition Service', address: 'AA:BB:CC:DD:EE:FF', rssiDbm: -58 },
    scale: { stable: true, removed: false, scaleTime: '2020-09-06T13:38:05' },
  });
});

test('saves the first reading at fifteen seconds when impedance never arrives', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const saved = [];
  const record = bufferHistory(event => saved.push(event));
  const first = { address: 'A', scaleTime: '12:00:00', weight: 70, unit: 'kg', impedanceOhms: null };
  record(first);
  record({ ...first, weight: 71, impedanceOhms: 450 });
  t.mock.timers.tick(14999);
  assert.deepEqual(saved, []);
  t.mock.timers.tick(1);
  record({ ...first, impedanceOhms: 450 });
  assert.deepEqual(saved, [first]);
});

test('decodes and immediately saves a standard Weight Measurement indication', () => {
  const { createReceiver } = require('./scale.cjs');
  const receive = createReceiver({ includeHex: true });
  const event = receive('AABBCCDDEEFF -58 181D 00803e ConnectableUndirected ');
  assert.equal(event.weight, 80);
  assert.equal(event.impedanceOhms, null);
  assert.equal(receive('AABBCCDDEEFF -58 181D 00ffff'), null);
  assert.equal(receive('AABBCCDDEEFF -58 181D 02803e'), null);
  const saved = [];
  bufferHistory(reading => saved.push(historyRecord(reading, null)))(event);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].reception.bluetooth.service, 'Weight Scale Service');
});

test('uses the latest weight by date and compares percentage distance across units', () => {
  // Entirely fictional profiles and measurements, fixed for reproducible tests.
  const profiles = [{ name: 'Élodie' }, { name: 'Malik' }];
  const row = (name, weight, receivedAt, unit = 'kg') => ({ profile: { name }, weight, unit, receivedAt });
  const latest = latestWeights([
    { profile: { name: 'elodie' }, receivedAt: '2026-08-19', measures: { weight: 75.2, unit: 'kg' } },
    row('Élodie', 77.7, '2026-08-03'),
    row('Malik', 82.5 / 0.45359237, '2026-08-19', 'lb'),
  ]);
  assert.equal(matchWeight({ weight: 79, unit: 'kg' }, profiles, latest)?.name, 'Malik');
  assert.equal(matchWeight({ weight: 90.75, unit: 'kg' }, profiles, latest)?.name, 'Malik');
  assert.equal(matchWeight({ weight: 91.1, unit: 'kg' }, profiles, latest), undefined);
});

test('resolves a prefix without accents and records the age on the Paris date of the reading', async () => {
  // Fictional birthday; the two UTC times straddle midnight in Paris.
  const entry = { name: 'Élodie', file: 'profile.json' };
  assert.equal(await chooseProfile([entry], 'ELO', { output: { write() {} } }), entry);
  const profile = { user: entry.name, age: 37, birthDate: '1989-09-17', sex: 'F', heightCm: 163 };
  const event = { weight: 62.35, unit: 'kg', impedanceOhms: null, receivedAt: '2026-09-16T21:59:59Z' };
  assert.equal(historyRecord(event, profile).profile.age, 36);
  assert.equal(historyRecord(event, profile).profile.ageAtWeighIn, 36);
  assert.equal(historyRecord({ ...event, receivedAt: '2026-09-16T23:00:00Z' }, profile).profile.age, 37);
});
