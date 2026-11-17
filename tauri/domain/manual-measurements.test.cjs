'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSession } = require('./session.cjs');
const { average } = require('../../shared/composition.cjs');
const when = '2020-01-02T10:30:00.000Z';
const alice = { name: 'Alice', sex: 'F', birthDate: '1990-06-15', heightCm: 165 };
const bob = { name: 'Bob', sex: 'H', age: 40, heightCm: 180 };

function fixture(seed) {
  let disk = structuredClone(seed);
  const session = createSession({ storage: {
    load: async () => structuredClone(disk),
    save: async state => { disk = structuredClone(state); },
  } });
  return { session, disk: () => structuredClone(disk) };
}

test('records an anonymous backdated manual weight without enrolling a Bluetooth device', async () => {
  const { session, disk } = fixture();
  const before = Date.now();
  const state = await session.saveManualMeasurement({ weight: '154,3', unit: 'lb', receivedAt: when, profileUuid: null });
  const [row] = state.measurements;
  assert.equal(row.profile, null);
  assert.equal(row.measures.weight, 154.3);
  assert.equal(row.measures.unit, 'lb');
  assert.equal(row.measures.impedanceOhms, null);
  assert.equal(row.calculations, null);
  assert.equal(row.device.source, 'manual');
  assert.equal(row.device.bluetooth, undefined);
  assert.equal(row.reception, null);
  assert.equal(row.receivedAt, when);
  assert.ok(Date.parse(row.createdAt) >= before);
  assert.deepEqual(state.devices, []);
  assert.equal(state.notifications.at(-1).record.uuid, row.uuid);
  const reopened = await fixture(disk()).session.load();
  assert.equal(reopened.measurements[0].device.source, 'manual');
  assert.equal(reopened.measurements[0].createdAt, row.createdAt);
});

test('uses the active profile rather than Bluetooth weight matching and preserves the original fat percentage', async () => {
  const prior = { receivedAt: '2019-12-01T09:00:00.000Z', profile: { name: 'Alice' },
    measures: { weight: 80, unit: 'kg' } };
  const { session, disk } = fixture({ profiles: [alice, bob], selectedProfile: 'Bob', measurements: [prior] });
  const initial = await session.load();
  const state = await session.saveManualMeasurement({ weight: '80', fatPercent: '25,04', receivedAt: when });
  const row = state.measurements.at(-1);
  assert.equal(row.profile.uuid, initial.profiles[1].uuid);
  assert.equal(row.profile.name, 'Bob');
  assert.equal(row.measures.fatPercent, 25.04);
  assert.equal(row.measures.impedanceOhms, null);
  assert.ok(row.calculations.impedanceOhms > 0);
  const values = Object.values(row.calculations).map(method => method?.fatPercent);
  const format = value => value.toLocaleString('en-GB', { maximumFractionDigits: 1 });
  assert.equal(format(average(values)), format(row.measures.fatPercent));
  assert.ok(row.calculations.Mi.muscleKg > 0);
  assert.deepEqual(state.measurements[0], initial.measurements[0]);
  const reopened = await fixture(disk()).session.load();
  assert.deepEqual(reopened.measurements.at(-1).measures, row.measures);
  assert.deepEqual(reopened.measurements.at(-1).calculations, row.calculations);
});

test('explicitly captures a profile, normalizes the instant and uses age at the entered weighing date', async () => {
  const { session } = fixture({ profiles: [alice, bob], selectedProfile: 'Alice' });
  const initial = await session.load();
  await session.selectProfile('Bob');
  const state = await session.saveManualMeasurement({ weight: 60, receivedAt: '2020-01-02T12:30:00+02:00',
    profileUuid: initial.profiles[0].uuid });
  const [row] = state.measurements;
  assert.equal(row.profile.name, 'Alice');
  assert.equal(row.profile.ageAtWeighIn, 29);
  assert.equal(row.receivedAt, when);
  assert.ok(row.calculations.IMC.bmi > 0);
  assert.equal(row.calculations.impedanceOhms, undefined);
});

test('requires a real profile for fat percentage and rejects invalid entries without saving anything', async () => {
  const { session } = fixture();
  await session.load();
  await assert.rejects(session.saveManualMeasurement({ weight: 70, fatPercent: 25 }), /manualProfileRequired/);
  for (const weight of [0, -1, Infinity, NaN, '', '1abc', true, [], '1e999']) {
    await assert.rejects(session.saveManualMeasurement({ weight }), /manualWeightInvalid/);
  }
  await assert.rejects(session.saveManualMeasurement({ weight: 70, unit: 'stone' }), /manualUnitInvalid/);
  for (const fatPercent of [0, 100, -1, Infinity, NaN, true, 'hello']) {
    await assert.rejects(session.saveManualMeasurement({ weight: 70, fatPercent }), /manualFatInvalid/);
  }
  for (const receivedAt of ['invalid', '', '2026-02-30T12:00:00Z', '2026-01-02T24:00:00Z', '2026-01-02T10:30:00', null]) {
    await assert.rejects(session.saveManualMeasurement({ weight: 70, receivedAt }), /manualDateInvalid/);
  }
  await assert.rejects(session.saveManualMeasurement({ weight: 70, profileUuid: 'missing' }), /manualProfileMissing/);
  assert.deepEqual((await session.load()).measurements, []);
});

test('rejects dates before birth and duplicate profile instants, but permits different profiles', async () => {
  const { session } = fixture({ profiles: [alice, bob], selectedProfile: 'Alice' });
  const initial = await session.load();
  await assert.rejects(session.saveManualMeasurement({ weight: 20, receivedAt: '1989-01-01T10:00:00Z' }), /manualDateBeforeBirth/);
  const saved = await session.saveManualMeasurement({ weight: 60, receivedAt: when, fatPercent: ' ' });
  await assert.rejects(session.saveManualMeasurement({ weight: 61, receivedAt: when }), /manualDuplicate/);
  const next = await session.saveManualMeasurement({ weight: 80, receivedAt: when, profileUuid: initial.profiles[1].uuid });
  assert.equal(next.measurements.length, 2);
  assert.equal(saved.measurements[0].measures.fatPercent, undefined);
  const row = next.measurements[0];
  const deleted = await session.deleteMeasurement(row);
  const notice = deleted.notifications.findLast(entry => entry.type === 'measurement' && entry.action === 'deleted');
  const restored = await session.restoreNotification(notice.id);
  assert.equal(restored.measurements.find(item => item.uuid === row.uuid).device.source, 'manual');
});

test('persists the closest impedance and repairs an existing failed calculation using the saved profile', async () => {
  const profile = { name: 'Test', sex: 'H', age: 50, heightCm: 175 };
  const legacy = { uuid: 'legacy-row', receivedAt: when, createdAt: when,
    profile: { ...profile, ageAtWeighIn: 50 },
    measures: { weight: 102, unit: 'kg', impedanceOhms: null, fatPercent: 45 },
    calculations: { IMC: { bmi: 33.3 } } };
  const { session, disk } = fixture({ profiles: [{ ...profile, age: 51 }], selectedProfile: 'Test', measurements: [legacy] });
  const state = await session.load();
  const row = state.measurements[0];
  assert.equal(row.measures.fatPercent, 45);
  assert.equal(row.measures.impedanceOhms, null);
  assert.ok(Math.abs(row.calculations.impedanceOhms - 1228.0266) < 0.01);
  assert.equal(average(Object.values(row.calculations).map(m => m?.fatPercent)).toFixed(1), '38.9');
  const reopened = await fixture(disk()).session.load();
  assert.deepEqual(reopened.measurements[0], row);
  const saved = await session.saveManualMeasurement({ weight: 102, fatPercent: 45, receivedAt: '2020-01-03T10:30:00.000Z' });
  assert.ok(saved.measurements.at(-1).calculations.impedanceOhms > 0);
  assert.equal(saved.measurements.at(-1).measures.fatPercent, 45);
});

test('saving without a profile selects anonymous history so the new row is visible', async () => {
  const { session } = fixture({ profiles: [alice], selectedProfile: 'Alice' });
  const state = await session.saveManualMeasurement({ weight: 70, profileUuid: null, receivedAt: when });
  assert.equal(state.selectedProfile, null);
  assert.equal(state.measurements.at(-1).profile, null);
});
